// Every keyboard control of Coucou's own windows, in one table. Each has a
// default and the user may rebind it (Settings → Keyboard); the choices live in
// settings.keys, by action id. The global "show or hide the island" shortcut is
// separate: it is registered with the OS by Rust (hotkey.rs).

export type KeyScope = "island" | "editor";

export interface KeyAction {
  id: string;
  scope: KeyScope;
  /** What it does, as the settings list says it. */
  what: string;
  /** The combination out of the box, in `comboFromEvent` form. */
  default: string;
  note?: string;
}

export const KEY_ACTIONS: readonly KeyAction[] = [
  { id: "island.close", scope: "island", what: "Close the island", default: "Esc" },
  {
    id: "tab.prev", scope: "island", what: "Previous tab (Today, Ask, Review, Progress)", default: "Left",
    note: "Click the island first so it has the keyboard. A plain key only works while the chat's message box is empty.",
  },
  { id: "tab.next", scope: "island", what: "Next tab (Today, Ask, Review, Progress)", default: "Right" },
  { id: "chat.send", scope: "island", what: "Send your message in the chat", default: "Enter" },
  { id: "editor.undo", scope: "editor", what: "Undo", default: "Ctrl+Z" },
  { id: "editor.redo", scope: "editor", what: "Redo", default: "Ctrl+Y", note: "Ctrl+Shift+Z always redoes too." },
  { id: "editor.cancel", scope: "editor", what: "Stop picking a colour from the picture", default: "Esc" },
];

export const SCOPE_TITLES: Record<KeyScope, string> = {
  island: "While the island is open",
  editor: "Skin editor",
};

const MODS = ["Ctrl", "Alt", "Shift", "Super"] as const;

/** Keys that do nothing when typing, so they may be used bare (no modifier). */
const BARE_OK = new Set([
  "Esc", "Enter", "Tab", "Backspace", "Left", "Right", "Up", "Down",
  "Home", "End", "PageUp", "PageDown", "Insert", "Delete",
]);

const NAMED: Record<string, string> = {
  Escape: "Esc", Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
  Backquote: "`", Minus: "-", Equal: "=", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Backslash: "\\",
};

/** The key itself (no modifiers) for a key press, or null for keys that can't be bound. */
export function keyName(e: KeyboardEvent): string | null {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

/** "Ctrl+Shift+Z" for a key press (modifiers in a fixed order); null for a lone modifier or unknown key. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = keyName(e);
  if (!key) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
  return [...mods, key].join("+");
}

const isFKey = (key: string) => /^F\d+$/.test(key);
const split = (combo: string) => combo.split("+");

/** Whether a combination may be used: the global shortcut needs a modifier (F-keys aside). */
export function usable(combo: string, global: boolean): boolean {
  const parts = split(combo);
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!key || mods.some((m) => !(MODS as readonly string[]).includes(m))) return false;
  // Shift alone only capitalises a letter: it is not a modifier worth binding.
  const real = mods.filter((m) => m !== "Shift");
  if (real.length || isFKey(key)) return true;
  return !global && BARE_OK.has(key);
}

/** True when the combination can be typed into a text field by accident (needs Ctrl/Alt/Super to be safe there). */
export function isBare(combo: string): boolean {
  return !split(combo).slice(0, -1).some((m) => m === "Ctrl" || m === "Alt" || m === "Super");
}

/** The combination bound to an action: the user's choice if it is valid, else the default. */
export function binding(keys: Record<string, string> | undefined, id: string): string {
  const def = KEY_ACTIONS.find((a) => a.id === id)!.default;
  const custom = keys?.[id];
  return typeof custom === "string" && custom.length <= 40 && usable(custom, false) ? custom : def;
}

/** Whether this key press is the action's combination. */
export function matches(e: KeyboardEvent, keys: Record<string, string> | undefined, id: string): boolean {
  return comboFromEvent(e) === binding(keys, id);
}

const SYMBOLS: Record<string, string> = { Left: "←", Right: "→", Up: "↑", Down: "↓" };

/** The caps to show for a combination. */
export function capsOf(combo: string): string[] {
  return split(combo).map((p) => SYMBOLS[p] ?? p);
}
