// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the pages can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[kotoba] ${cmd} failed`, err);
    return null;
  }
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Kotoba");
  return invoke<T>(cmd, args);
}

/** Which conversation a message belongs to; each keeps its own history. */
export type ChatKind = "study" | "quick" | "lookup";

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

export interface ChatReply {
  text: string;
}

export interface LevelPoint {
  date: string;
  score: number;
}

export interface Level {
  score: number;
  label: string;
  reason: string;
  history: LevelPoint[];
}

export interface DayStat {
  date: string;
  messages: number;
  reviews: number;
  minutes: number;
  newWords: number;
  correct: number;
  wrong: number;
}

export interface WordStat {
  surface: string;
  reading: string;
  meaning: string;
  strength: number;
}

export interface Mistake {
  date: string;
  said: string;
  correct: string;
  kind: string;
  note: string;
}

/** learner::Stats — everything the Stats view and the island's home show. */
export interface Stats {
  level: Level;
  streak: number;
  bestStreak: number;
  words: number;
  solid: number;
  weak: number;
  /** Share of right uses over the last 30 days; null before any. */
  accuracy30: number | null;
  totalMinutes: number;
  todayMinutes: number;
  todayMessages: number;
  /** The last 84 days, oldest first. */
  activity: DayStat[];
  mistakesByKind: { kind: string; count: number }[];
  weakWords: WordStat[];
  recentMistakes: Mistake[];
  /** Words the learner knows well (their furigana can be hidden). */
  known: string[];
  /** Cards waiting for review today. */
  dueToday: number;
  /** Speaking practice over the last 30 days: attempts and the mean score (0..1). */
  speaking30: number;
  speakingAvg30: number | null;
}

export interface Card {
  surface: string;
  reading: string;
  meaning: string;
  strength: number;
  reps: number;
}

export type Grade = "again" | "hard" | "good" | "easy";

/** What a hotkey press tells the island page. */
export type HotkeyEvent =
  | { action: "summon" }
  | { action: "lookup"; text?: string; error?: string };

export interface Voice {
  id: string;
  title: string;
  description: string;
}

export interface SkinInfo {
  id: string;
  name: string;
  author: string;
  note: string;
  persona: string;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Registers the global shortcut, then saves it. Rejects with why it could not. */
  setHotkey: (enabled: boolean, accelerator: string, lookup: string) =>
    callOrThrow<Settings>("set_hotkey", { enabled, accelerator, lookup }),

  /** What the tray menu and tooltip say. */
  traySync: (status: string, visible: boolean) => call<void>("tray_sync", { status, visible }),

  /** May the island summon itself right now (not over a full-screen app)? */
  canSummon: () => call<boolean>("can_summon"),

  /** Shows or hides the island window; hidden also parks the cursor poll. */
  setVisible: (visible: boolean) => call<void>("set_visible", { visible }),

  /** The island's shape, for click-through. */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Milliseconds since the last keyboard or mouse input anywhere. */
  idleMs: () => call<number>("idle_ms"),

  /** Lets the island take (or give back) the keyboard. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** The study window, optionally on a view ("chat", "stats") or "ask:<text>". */
  openStudyWindow: (view: string | null = null) => call<void>("open_study_window", { view }),

  /** Writes to Kotoba's log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Tutor ─────────────────────────────────────────────────────────────────

  /** One message to Mochi; the reply streams as "assistant-stream" events. */
  chatSend: (which: ChatKind, query: string, scenario: string | null, today: string) =>
    callOrThrow<ChatReply>("chat_send", { which, query, scenario, today }),

  chatReset: (which: ChatKind) => call<void>("chat_reset", { which }),

  learnerStats: (today: string) => call<Stats>("learner_stats", { today }),

  // ── Reviews ───────────────────────────────────────────────────────────────

  /** The cards to review today, most overdue first. */
  reviewQueue: (today: string, limit: number) => call<Card[]>("review_queue", { today, limit }),
  reviewGrade: (word: string, grade: Grade, today: string) =>
    callOrThrow<void>("review_grade", { word, grade, today }),
  /** "Add to reviews" from a lookup. False when the word was already known. */
  addWord: (word: string, reading: string, meaning: string, today: string) =>
    callOrThrow<boolean>("learner_add_word", { word, reading, meaning, today }),

  /** A shadowing attempt and its score (0..1), for Progress. */
  speakingLog: (score: number, today: string) => call<void>("speaking_log", { score, today }),

  // ── Speech to text ────────────────────────────────────────────────────────

  /** What was said in a recording (Fish Audio). Rejects with a message to show. */
  transcribe: (bytes: ArrayBuffer, mime: string) =>
    IS_TAURI
      ? invoke<string>("speech_transcribe", new Uint8Array(bytes), { headers: { "x-mime": mime } })
      : Promise.reject(new Error("not running inside Kotoba")),

  /** Gemini models the stored key can use. */
  geminiModels: () => callOrThrow<{ id: string; label: string }[]>("gemini_models"),

  // ── Voice ─────────────────────────────────────────────────────────────────

  /** MP3 bytes for a Japanese line. `voice` overrides the chosen one (previews). */
  ttsSpeak: (text: string, voice: string | null = null) =>
    callOrThrow<ArrayBuffer>("tts_speak", { text, voice }),

  fishVoices: (mine: boolean) => callOrThrow<Voice[]>("fish_voices", { mine }),

  // ── Skin bundles ──────────────────────────────────────────────────────────
  skinsList: () => call<SkinInfo[]>("skins_list"),
  /** Checks a bundle; `keep` installs it. Rejects with why it was refused. */
  skinImport: (path: string, keep: boolean) => callOrThrow<SkinInfo>("skin_import", { path, keep }),
  skinRemove: (id: string) => callOrThrow<void>("skin_remove", { id }),
  skinManifest: (id: string) => call<string>("skin_manifest", { id }),
  skinLayer: (id: string, name: string) => call<ArrayBuffer>("skin_layer", { id, name }),
  /** The skin editor's result: installed, or written to `zipPath` to share. Files are base64. */
  skinSave: (files: [string, string][], zipPath: string | null) =>
    callOrThrow<SkinInfo>("skin_save", { files, zipPath }),
  /** Save dialog for an exported skin. */
  pickSkinZip: (name: string) => call<string | null>("pick_skin_zip", { name }),
  /** Opens the skin editor on a new skin, or on an installed one. */
  openSkinEditor: (id: string | null) => call<void>("open_skin_editor", { id }),
  /** The file dialog behind "Import skin…". */
  pickSkin: (folder: boolean) => call<string | null>("pick_skin", { folder }),

  // ── Secrets ───────────────────────────────────────────────────────────────
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),
};

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
