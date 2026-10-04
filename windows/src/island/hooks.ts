// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { repoMayHaveChanged } from "../core/repo";
import { State } from "../core/state";
import { refreshIde } from "../core/ide";
import {
  activityFromTool, contextRequest, isShellTool, withContext, type FileActivity,
} from "../core/snippet";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;
/** Tool and input of the request on the card, to recognise its PostToolUse. */
let pendingKey = "";

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
  /** Process ids above the relay, nearest first — see coucou-hook. */
  coucou_ancestors?: unknown;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string, ancestors?: unknown) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  if (cwd) {
    t.name = projectName;
    t.sessionCwd = cwd;
  }
  // Only what can be a process id; the relay sends at most twelve.
  const pids = Array.isArray(ancestors)
    ? ancestors.filter((p): p is number => Number.isInteger(p) && p > 4).slice(0, 12)
    : [];
  if (pids.length) {
    const changed = pids.join() !== (t.sessionPids ?? []).join();
    t.sessionPids = pids;
    // A new process chain may sit in another editor.
    if (changed) void refreshIde(pids);
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * What a prompt step should say. Claude Code also passes its own internal
 * messages through UserPromptSubmit — a background task finishing arrives as
 * "<task-notification><task-id>…" — and the ticker must show what happened,
 * never the markup.
 */
export function promptStep(raw: string): string | null {
  const text = raw.trim();
  if (!text.startsWith("<")) return oneLine(text) || null;
  const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(text)?.[1];
  if (/^<task-notification\b/i.test(text)) {
    return summary ? oneLine(summary) : "Background task update";
  }
  // Any other tagged message: keep the words, drop the tags.
  return oneLine(text.replace(/<[^>]*>/g, " ")) || null;
}

/**
 * Keeps one record per Claude Code session, so the cockpit can show them side
 * by side and jump to the right terminal. Sessions end on SessionEnd, or fade
 * out of State.liveSessions after twenty quiet minutes.
 */
function trackSession(payload: HookPayload, project: string, cwd: string, event: string, step: string | null) {
  const id = payload.session_id;
  if (!id) return;
  if (event === "SessionEnd") {
    delete State.sessions[id];
    if (State.activeSessionId === id) State.activeSessionId = null;
    return;
  }
  const now = Date.now();
  const known = State.sessions[id];
  const state =
    event === "Stop" ? "idle"
    : event === "StopFailure" ? "error"
    : event === "PermissionRequest" ? "approval"
    : event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse" ? "working"
    : known?.state ?? "idle";
  const pids = Array.isArray(payload.coucou_ancestors)
    ? payload.coucou_ancestors.filter((p): p is number => Number.isInteger(p) && p > 4).slice(0, 12)
    : known?.pids ?? [];
  State.sessions[id] = {
    id,
    project,
    cwd: cwd || known?.cwd || "",
    pids: pids.length ? pids : known?.pids ?? [],
    state,
    step: step ?? known?.step ?? "",
    startedAt: known?.startedAt ?? now,
    lastSeen: now,
  };
}

/** The approval badge left by a request handed back to the terminal. */
function clearDeclinedApprovalBadge() {
  if (State.pendingApproval) return;
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (t?.pillBadge === "approval") t.pillBadge = null;
}

/**
 * What the Home card shows for a tool call: the file it touches and a few lines
 * of it. The payload alone gives an Edit's strings; the file gives the real line
 * numbers and a Read's lines, so those arrive a moment later and only land if
 * no newer tool call has replaced this one.
 */
function showToolOnHome(agentId: string, tool: string, input: Record<string, unknown>, cwd: string) {
  const activity = activityFromTool(tool, input, cwd);
  const command = isShellTool(tool) && typeof input.command === "string" ? input.command.trim() : "";
  State.recordTool(
    agentId,
    toolLogEntry(tool, input, activity),
    activity,
    command ? { command: command.slice(0, 200), status: "running" } : null,
  );
  const req = activity && cwd ? contextRequest(tool, input) : null;
  if (!activity || !req) return;
  void Bridge.readSnippet({ path: activity.path, cwd, ...req }).then((ctx) => {
    if (ctx) State.patchActivity(agentId, withContext(activity, tool, input, ctx));
  });
}

function toolLogEntry(tool: string, input: Record<string, unknown>, a: FileActivity | null) {
  if (a) return { verb: a.verb, target: a.name };
  const cmd = typeof input.command === "string" ? input.command : "";
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  return { verb: isShellTool(tool) ? "Bash" : tool, target: first.slice(0, 24) };
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.activity = null;
  t.shell = null;
  t.log = [];
  t.name = State.ideLabel;
  t.pillBadge = null;
}

/** Events that may summon the island; only these wait on the full-screen check. */
const SUMMONING = new Set(["Notification", "Stop", "StopFailure", "PermissionRequest"]);

/**
 * Hooks are handled one at a time, in arrival order. Summoning events await the
 * full-screen check, and without the queue a PreToolUse could overtake the Stop
 * that came before it.
 */
let queue: Promise<void> = Promise.resolve();

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => {
    queue = queue
      .then(() => handleHook(island, payload))
      .catch((err) => console.error("[coucou] hook failed", err));
  });
  // The request was answered in the terminal: Claude Code killed the relay.
  void onEvent<string>("approval-gone", (requestId) => {
    queue = queue.then(() => dismissApproval(island, requestId));
  });
}

/**
 * Takes the approval card down without a decision — answered in the terminal,
 * or the relay gave up. A request id that isn't the one on the card is ignored.
 */
function dismissApproval(island: Island, requestId?: string) {
  const req = State.pendingApproval;
  if (!req || (requestId && req.requestId !== requestId)) return;
  if (pendingTimeout != null) {
    window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
  }
  State.pendingApproval = null;
  pendingKey = "";
  State.isPinned = false;
  island.dropPin();
  State.updateTask(CLAUDE_ID, "working");
  State.setPillBadge(CLAUDE_ID, null);
  if (State.view === "approval") island.setView(State.defaultView());
  State.notify();
}

/** Events that prove the request on the card is over, even if the relay's hang-up was missed. */
function settlesApproval(name: string, payload: HookPayload): boolean {
  const req = State.pendingApproval;
  if (!req || !req.sessionId || payload.session_id !== req.sessionId) return false;
  if (name === "Stop" || name === "StopFailure" || name === "UserPromptSubmit" || name === "SessionEnd") return true;
  // Tools can run in parallel: only the one that was asked about counts.
  return (
    (name === "PostToolUse" || name === "PostToolUseFailure") &&
    approvalKey(payload.tool_name, payload.tool_input) === pendingKey
  );
}

function approvalKey(tool: string | undefined, input: Record<string, unknown> | undefined): string {
  return `${tool ?? ""}:${JSON.stringify(input ?? {})}`;
}

async function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  // A full-screen game, video or presentation is never interrupted: State still
  // updates and badges still show, but the island stays down and stays silent.
  // Null (plain browser) counts as allowed.
  const quiet = SUMMONING.has(name) && (await Bridge.canSummon()) === false;
  // Paused while we were asking: same answer as above.
  if (State.paused) {
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }
  const play = (sound: Parameters<typeof Sound.play>[0]) => {
    if (!quiet) Sound.play(sound);
  };

  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code pill unchanged.
  const validAgent = validateAgent(payload.coucou_agent);
  const agentId = validAgent ? `agent_${validAgent}` : CLAUDE_ID;
  const isExternalAgent = validAgent !== null;

  const focused = State.focusId === agentId;

  /**
   * Only alerts surface the island — something that needs a human. Routine work
   * updates State silently (the trailing notify repaints if the island is up);
   * on Windows there is no notch to sit in, so appearing for it would interrupt.
   */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (!isAlert || quiet) return;
    if (State.mode === "expanded") island.setView(view);
    else island.alert(view);
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else {
      upsert(projectName, cwd, payload.coucou_ancestors);
    }
  };

  // Any event identifies the session. Waiting for one of the first few meant an
  // island started mid-session (or one that only saw a Stop or SubagentStop)
  // kept the default "VS Code" name and had no window to jump back to.
  if (!isExternalAgent && name !== "SessionEnd") ensurePill();

  if (!isExternalAgent && settlesApproval(name, payload)) dismissApproval(island);

  switch (name) {
    case "SessionStart":
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = promptStep(payload.prompt ?? payload.message ?? "");
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      break;
    }

    case "PreToolUse": {
      ensurePill();
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
      showToolOnHome(agentId, tool, payload.tool_input ?? {}, cwd);
      break;
    }

    case "PostToolUse":
      State.updateTask(agentId, "working");
      // A tool may have edited files or committed: the repo row catches up.
      if (!isExternalAgent) repoMayHaveChanged(cwd);
      if (isShellTool(payload.tool_name ?? "")) State.finishShell(agentId, true);
      // A tool ran, so an approval handed back to the terminal has been answered.
      clearDeclinedApprovalBadge();
      break;

    case "PostToolUseFailure":
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      if (isShellTool(payload.tool_name ?? "")) State.finishShell(agentId, false);
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        play("rate");
        surface("overview", true);
      } else if (message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
        surface("question", true);
      }
      break;
    }

    case "Stop":
      State.updateTask(agentId, "finished");
      if (!isExternalAgent) repoMayHaveChanged(cwd);
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, 60));
      play("finish");
      if (focused && !quiet) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          State.updateTask(agentId, "idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(agentId, "error");
      play("error");
      if (focused && !quiet) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        State.updateTask(agentId, "idle");
        clearSession();
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest": {
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(projectName, cwd, payload.coucou_ancestors);
      if (quiet) {
        // Nobody can see a card over a full-screen app. Never leave Claude Code
        // waiting on one, and never approve on anyone's behalf: hand it back to
        // the terminal now, and leave the badge so it is noticed afterwards.
        if (requestId) void Bridge.approvalDecline(requestId);
        State.updateTask(CLAUDE_ID, "approval");
        State.setPillBadge(CLAUDE_ID, "approval");
        break;
      }
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
      };
      pendingKey = approvalKey(tool, input);
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(CLAUDE_ID, "approval");
      State.isPinned = true;
      Sound.play("approval");
      // Always the full card, even when another agent holds the view. Claude Code
      // is blocked on this answer, and with no resting island a compact peek that
      // closes on its own is too easy to miss. The badge stays for the pill row.
      if (!focused) State.setPillBadge(CLAUDE_ID, "approval");
      island.alert("approval");
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        dismissApproval(island);
      }, 110_000);
      break;
    }

    default:
      break;
  }
  if (!isExternalAgent) {
    const step = name === "PreToolUse" ? stepLabel(payload.tool_name ?? "Tool", payload.tool_input ?? {}) : null;
    trackSession(payload, projectName, cwd, name, step);
  }
  State.notify();
}
