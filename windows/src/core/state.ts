// App state shared by the pages: the island's mode and view, the quick chat,
// and the preferences every window reads.

import type { BotStateName, IslandMode, IslandViewName } from "./layout";
import type { MemoryNote, Stats } from "./bridge";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** What Mochi saved to memory with this reply (undo-able). */
  remembered?: MemoryNote[];
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  screen: "primary" | "cursor";
  /** Which screen edge the island springs from; either way it stays centred. */
  position: "top" | "bottom";
  autostart: boolean;
  /** Claude model used by the tutor. */
  model: string;
  /** Global shortcut that summons or dismisses Mochi. */
  hotkeyEnabled: boolean;
  hotkeyAccelerator: string;
  /** Look up the selected text, from any app. */
  hotkeyLookup: string;
  /** A popup to ask Mochi about text selected in any app (Windows). */
  selectionPopup: boolean;
  /** Apps that never get it, by exe name; terminals and password managers are built in. */
  selectionIgnore: string;
  /** Which AI teaches. */
  provider: "claude" | "gemini" | "deepseek";
  /** Gemini model id; empty = the first "flash" model the key can use. */
  geminiModel: string;
  /** DeepSeek model id; empty = the first "flash" model the key can use. */
  deepseekModel: string;
  /** "mochi", "ribbon", or an imported skin. */
  skin: string;
  /** What the tutor calls the learner; empty = never named. */
  userName: string;
  /** Keyboard controls the user rebound, by action id (core/keys.ts). Missing = the default. */
  keys: Record<string, string>;

  /** How much English the tutor gives. */
  englishSupport: "auto" | "more" | "less";
  /** A romaji line under Japanese. */
  romaji: boolean;
  /** Furigana over kanji: always, only for words not yet solid, or never. */
  furigana: "always" | "unknown" | "off";
  /** Translations shown straight away (otherwise tap to reveal). */
  showEnglish: boolean;
  dailyGoalMinutes: number;

  /** Mochi offers a short moment at natural breaks. */
  reminders: boolean;
  reminderMaxPerDay: number;
  /** No reminders between these local times (HH:MM; may span midnight). */
  quietStart: string;
  quietEnd: string;
  reminderReview: boolean;
  reminderWord: boolean;
  reminderQuiz: boolean;

  /** Fish Audio voice model id; empty = Fish Audio's default voice. */
  ttsVoice: string;
  ttsVoiceName: string;
  ttsModel: string;
  ttsSpeed: number;
  autoPlay: boolean;

  /** Let Mochi open links, search the web, control music and read basic PC facts. */
  pcTools: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  screen: "primary",
  position: "top",
  autostart: false,
  model: "claude-opus-5-5",
  hotkeyEnabled: true,
  hotkeyAccelerator: "Ctrl+Alt+C",
  hotkeyLookup: "Ctrl+Alt+J",
  selectionPopup: true,
  selectionIgnore: "",
  provider: "claude",
  geminiModel: "",
  deepseekModel: "",
  skin: "mochi",
  userName: "",
  keys: {},
  englishSupport: "auto",
  romaji: true,
  furigana: "always",
  showEnglish: true,
  dailyGoalMinutes: 10,
  reminders: true,
  reminderMaxPerDay: 4,
  quietStart: "22:00",
  quietEnd: "08:00",
  reminderReview: true,
  reminderWord: true,
  reminderQuiz: true,
  ttsVoice: "",
  ttsVoiceName: "",
  ttsModel: "s2.1-pro-free",
  ttsSpeed: 0.9,
  autoPlay: true,
  pcTools: true,
};

type Listener = () => void;

/** The learner's local calendar day, YYYY-MM-DD: what streaks and stats are counted in. */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "home";

  stateOverride: BotStateName | null = null;

  /** Cursor in window-logical pixels, origin at the island window's top-left. */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;

  noteMessage: string | null = null;
  chatHistory: ChatMessage[] = [];
  /** The chat is shown large (header button). */
  chatExpanded = false;
  /** Island height the chat needs to show everything in it, measured by the chat view (0 = not yet). */
  chatFitHeight = 0;

  /** Today's progress, refreshed whenever the learner changes. */
  stats: Stats | null = null;

  /** The lookup on screen: what was selected, and why there may be no answer. */
  lookup: { text: string; error?: string; token: number } | null = null;
  /** The review session the island is showing. */
  review: { limit: number; revealed: boolean; fromReminder: boolean; token: number; done?: boolean } | null = null;

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

  get effectiveState(): BotStateName {
    return this.stateOverride ?? "idle";
  }

  defaultView(): IslandViewName {
    return "home";
  }
}

export const State = new AppState();
