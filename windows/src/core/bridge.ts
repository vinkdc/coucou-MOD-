// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";
import type { FileContext } from "./snippet";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

export interface ListeningPort {
  port: number;
  addr: string;
  pid: number;
  process: string;
  /** A known development runtime (node, python …): listed first. */
  dev: boolean;
}

export interface ProjectScript {
  /** npm, pnpm, yarn, bun, cargo or make. */
  kind: string;
  name: string;
  /** What runs: `npm run dev`. */
  cmd: string;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Registers the global shortcut, then saves it. Rejects with why it could not. */
  setHotkey: (enabled: boolean, accelerator: string) =>
    callOrThrow<Settings>("set_hotkey", { enabled, accelerator }),

  /** What the tray menu and tooltip say. */
  traySync: (status: string, visible: boolean, paused: boolean) =>
    call<void>("tray_sync", { status, visible, paused }),

  /** False while a full-screen app or presentation must not be interrupted. */
  canSummon: () => call<boolean>("can_summon"),

  /** Show the island window, or hide it entirely (no window, no cursor poll). */
  setVisible: (visible: boolean) => call<void>("set_visible", { visible }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Milliseconds since the user last touched the keyboard or mouse (anywhere). */
  idleMs: () => call<number>("idle_ms"),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** "Check my step": a screenshot goes to the chosen model, which says if it looks done. */
  guideCheck: (title: string, step: string) =>
    call<{ done: boolean; hint: string }>("guide_check", { title, step }),

  /** "Show me": a ring over the thing to click; false when the model can't find it. */
  guideLocate: (title: string, step: string) =>
    call<{ found: boolean; label: string }>("guide_locate", { title, step }),
  guideClear: () => call<void>("guide_clear"),

  /** A guide step's "Open page": one of the allowlisted Windows Settings pages. */
  openWindowsSettings: (page: string) => call<boolean>("open_windows_settings", { page }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null, ide: string | null = null) =>
    call<boolean>("open_in_vscode", { path, ide }),
  /** The editor the user works in: the session's own when its process chain is known. */
  detectIde: async (pids: number[]): Promise<{ id: string; label: string } | null | undefined> =>
    IS_TAURI ? (await call<{ id: string; label: string }>("detect_ide", { pids })) ?? null : undefined,

  /**
   * "Open terminal": back to the window the Claude Code session runs in, found
   * from its process chain; the folder when that window can't be found.
   */
  focusSession: (pids: number[], path: string | null) =>
    call<boolean>("focus_session", { pids, path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null, persona: string | null = null) =>
    callOrThrow<{ text: string; actions: string[] }>("chat_send", { query, context, persona }),
  chatReset: () => call<void>("chat_reset"),
  /**
   * A few lines of a file a session works on (inside its folder only), for the
   * Home view. Give `needle` to find a text, or `offset`/`count` for a window.
   */
  readSnippet: (req: {
    path: string;
    cwd: string;
    needle: string | null;
    offset: number | null;
    count: number;
    before: number;
    after: number;
  }) => call<FileContext>("read_snippet", req),
  /** Branch, changed files and ahead/behind of a folder, read locally from git. */
  repoStatus: (path: string) => call<RepoStatus>("repo_status", { path }),
  /** Claude Code tokens per hour over the last week, read from its local transcripts. */
  claudeUsage: () => call<ClaudeUsage>("claude_usage"),
  /** Allow / Deny on an assistant action card — only ever from a click. */
  assistantConfirm: (id: string, allow: boolean) => call<void>("assistant_confirm", { id, allow }),
  /** Result of one of Coucou's own tools, run by the island page. */
  assistantToolResult: (id: string, result: { ok: boolean; text: string }) =>
    call<void>("assistant_tool_result", { id, result }),
  /** Gemini models the stored key can use. */
  geminiModels: () => callOrThrow<{ id: string; label: string }[]>("gemini_models"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** A dropped picture as a data: URL for its thumbnail; null for anything else. */
  filePreview: (path: string) => call<string | null>("file_preview", { path }),
  /** Opens Windows' snipping overlay; the result arrives as `snip-ready`. */
  snipStart: () => callOrThrow<void>("snip_start"),
  /** A file dropped on the page itself, by contents (the webview gives no path). */
  ingestBytes: async (name: string, bytes: Uint8Array): Promise<DroppedFile> => {
    try {
      return await invoke<DroppedFile>("ingest_bytes", bytes, {
        headers: { "x-file-name": encodeURIComponent(name) },
      });
    } catch (err) {
      throw new Error(String(err));
    }
  },
  /** Native "open file" dialog. Null when cancelled (or outside Tauri). */
  pickFile: () => call<string | null>("pick_file"),

  // ── Developer tools ───────────────────────────────────────────────────────
  pickFolder: () => call<string | null>("pick_folder"),
  listeningPorts: () => call<ListeningPort[]>("listening_ports"),
  /** Rejects with why the server could not be stopped. */
  killPortProcess: (pid: number) => callOrThrow<void>("kill_port_process", { pid }),
  projectScripts: (dir: string) => call<ProjectScript[]>("project_scripts", { dir }),
  runScript: (dir: string, kind: string, name: string) =>
    callOrThrow<void>("run_script", { dir, kind, name }),

  // ── Skin bundles ──────────────────────────────────────────────────────────
  skinsList: () => call<SkinInfo[]>("skins_list"),
  /** A .zip or a folder; Rust checks all of it first. `keep: false` only reports what is in it. */
  skinImport: (path: string, keep: boolean) => callOrThrow<SkinInfo>("skin_import", { path, keep }),
  skinRemove: (id: string) => callOrThrow<void>("skin_remove", { id }),
  skinManifest: (id: string) => call<string>("skin_manifest", { id }),
  skinLayer: (id: string, name: string) => call<ArrayBuffer>("skin_layer", { id, name }),
  /** The skin editor's result: installed, or written to \`zipPath\` to share. Files are base64. */
  skinSave: (files: [string, string][], zipPath: string | null) =>
    callOrThrow<SkinInfo>("skin_save", { files, zipPath }),
  /** Save dialog for an exported skin. */
  pickSkinZip: (name: string) => call<string | null>("pick_skin_zip", { name }),
  /** Opens the skin editor on a new skin, or on an installed one. */
  openSkinEditor: (id: string | null) => call<void>("open_skin_editor", { id }),
  /** The file dialog behind "Import skin…". */
  pickSkin: (folder: boolean) => call<string | null>("pick_skin", { folder }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
};

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface RepoStatus {
  isRepo: boolean;
  branch: string;
  detached: boolean;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  changed: number;
  lastCommit: string;
  /** owner/repo when origin is on GitHub. */
  github: string | null;
}

export interface UsageHour {
  /** Start of the hour, seconds since the epoch. */
  hour: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  messages: number;
}

export interface ClaudeUsage {
  hours: UsageHour[];
  /** A Claude Code projects folder exists. */
  found: boolean;
}

/** An imported skin bundle, as Rust vetted it. */
export interface SkinInfo {
  id: string;
  name: string;
  author: string;
  note: string;
  persona: string;
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
