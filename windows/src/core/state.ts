// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { ClaudeUsage, RepoStatus } from "./bridge";
import type { FileActivity } from "./snippet";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** The session's process chain (Claude Code, its shell, the terminal), for "Open terminal". */
  sessionPids?: number[];
  /** The file the current tool call is reading or changing, with a few lines of it. */
  activity?: FileActivity | null;
  /** The last few tool calls, for the step list of the editor view. */
  log?: ToolLogEntry[];
  /** The shell command of the current Bash call, shown under the file in the editor. */
  shell?: ShellRun | null;
}

export interface ShellRun {
  command: string;
  status: "running" | "ok" | "fail";
}

export interface ToolLogEntry {
  verb: string;
  target: string;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
}

export interface ChatMessage {
  id: number;
  /**
   * "action": a line saying what the assistant did on the way.
   * "confirm": an Allow/Deny card for a risky action.
   */
  role: "user" | "assistant" | "action" | "confirm";
  content: string;
  /** Confirm cards only. */
  confirmId?: string;
  detail?: string;
  status?: "pending" | "allowed" | "denied" | "expired";
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

/** One Claude Code session, tracked from its hook events. */
export interface SessionInfo {
  id: string;
  /** Folder name of the project it works in. */
  project: string;
  cwd: string;
  /** Process chain (Claude Code, shell, terminal) for jumping back to it. */
  pids: number[];
  state: "working" | "idle" | "approval" | "error";
  step: string;
  startedAt: number;
  lastSeen: number;
}

/** A session that has said nothing for this long is treated as gone. */
const SESSION_TTL_MS = 20 * 60_000;

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  // Named after the editor in use once it is detected (core/ide.ts).
  task("integration_claude", "Claude Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  /** Which screen edge the island springs from; either way it stays centred. */
  position: "top" | "bottom";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
  /** Global shortcut that summons or dismisses the island. */
  hotkeyEnabled: boolean;
  hotkeyAccelerator: string;
  /** Which AI answers in the chat. */
  provider: "claude" | "gemini";
  /** Gemini model id; empty = the first "flash" model the key can use. */
  geminiModel: string;
  /** "mochi", "ribbon", or a local dev-only skin (src/mochi/local/). */
  skin: string;
  /** What the chat calls the user (a character's {{user}}); empty = never named. */
  userName: string;
  /** Keyboard controls the user rebound, by action id (core/keys.ts). Missing = the default. */
  keys: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  position: "top",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  hotkeyEnabled: true,
  hotkeyAccelerator: "Ctrl+Alt+C",
  provider: "claude",
  geminiModel: "",
  skin: "mochi",
  userName: "",
  keys: {},
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in window-logical pixels, origin at the island window's top-left. */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  /** The editor the user works in (null until detected): Home names it instead of "VS Code". */
  ide: { id: string; label: string } | null = null;
  get ideLabel(): string {
    // No editor open (Claude Code in a terminal or the Claude app): the pill is Claude Code.
    return this.ide?.label ?? "Claude Code";
  }

  setIde(ide: { id: string; label: string } | null) {
    if (this.ide?.id === ide?.id) return;
    this.ide = ide;
    // The pill carries the editor's name while no session names it after its folder.
    const t = this.tasks.find((x) => x.id === "integration_claude");
    if (t && !t.sessionCwd && t.steps.length === 0) t.name = this.ideLabel;
    this.notify();
  }

  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};
  /** Local git status per working folder, filled by core/repo.ts. */
  repos: Record<string, RepoStatus> = {};
  /** Claude Code usage from its local transcripts, filled by core/usage.ts. */
  usage: ClaudeUsage | null = null;
  sessions: Record<string, SessionInfo> = {};
  /** The chat is shown large (header button). */
  chatExpanded = false;
  /** Island height the chat needs to show everything in it, measured by the chat view (0 = not yet). */
  chatFitHeight = 0;
  /** The step-by-step guide Mochi is walking the user through, if any. */
  guide: {
    title: string;
    steps: string[];
    index: number;
    page: string | null;
    /** Result of "Check my step" for the current step; cleared on Back/Next. */
    check: { busy: boolean; done?: boolean; hint?: string } | null;
  } | null = null;
  /** The session the cockpit is showing; null = the most recent. */
  activeSessionId: string | null = null;

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  /** Sessions that have been heard from recently, newest first. */
  get liveSessions(): SessionInfo[] {
    const now = Date.now();
    return Object.values(this.sessions)
      .filter((x) => now - x.lastSeen < SESSION_TTL_MS)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** The session the cockpit is about. */
  get currentSession(): SessionInfo | null {
    const live = this.liveSessions;
    return live.find((x) => x.id === this.activeSessionId) ?? live[0] ?? null;
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  /** A tool call started: it joins the step list, and its file (if any) fills the Home card. */
  recordTool(id: string, entry: ToolLogEntry, activity: FileActivity | null, shell: ShellRun | null = null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.log = [...(t.log ?? []), entry].slice(-5);
    // The last file stays on the card while other tools (Bash, Grep…) run; the
    // next file tool replaces it, and the end of the session clears it.
    t.activity = activity ?? t.activity ?? null;
    t.shell = shell;
    this.notify();
  }

  /** The shell command ended. */
  finishShell(id: string, ok: boolean) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t?.shell) return;
    t.shell = { ...t.shell, status: ok ? "ok" : "fail" };
    this.notify();
  }

  /** The file's own lines arrived; ignored when a newer tool call has replaced this one. */
  patchActivity(id: string, activity: FileActivity) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.activity?.seq !== activity.seq) return;
    t.activity = activity;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** loadIntegrationTasks() — VS Code always on, the rest opt-in (max 4). */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad =
        proto.id === "integration_claude" || this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Order: integration_claude first, then agent_* pills (visible in slice(0,4)),
    // then other integrations in declaration order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const isAgentA = a.id.startsWith("agent_");
      const isAgentB = b.id.startsWith("agent_");
      // integration_claude always first
      if (a.id === "integration_claude") return -1;
      if (b.id === "integration_claude") return 1;
      // agent_* before other integrations; preserve insertion order among themselves
      if (isAgentA && !isAgentB) return -1;
      if (isAgentB && !isAgentA) return 1;
      if (isAgentA && isAgentB) return 0;
      // both known integrations → declaration order
      return order.indexOf(a.id) - order.indexOf(b.id);
    });
    if (!this.focusId) this.focusId = "integration_claude";
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? "integration_claude";
    this.notify();
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const at = this.tasks.findIndex((t) => t.id === "integration_claude") + 1;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
