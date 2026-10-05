// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  | "home"
  | "prompt"
  | "nudge"
  | "lookup"
  | "review"
  | "stats"
  | "study"
  | "confused"
  | "note"
  | "settings"
  | "greeting";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
}

// The window is a fixed size (largest view) like the macOS panel; the island is
// drawn inside it, glued to the top edge and horizontally centred.
export const PANEL_W = 1060;
export const PANEL_H = 700;

/** The study view: the island grows into a large panel (Talk, Review, Progress). */
export const STUDY_SIZE = { w: 1000, h: 660 } as const;

/** The chat when it has been expanded with the header button. */
export const CHAT_EXPANDED = { w: 820, h: 520 } as const;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104
export const EXPANDED_W = 640;

export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  // Mochi on the left; today at a glance and the ways in on the right.
  home: { height: 176, botX: 70, botY: null, botDiameter: 62 },
  nudge: { height: 160, botX: 66, botY: null, botDiameter: 60 },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66 },
  prompt: { height: 160, botX: 52, botY: null, botDiameter: 44 },
  // The lookup answer scrolls inside its card; Mochi sits beside it.
  lookup: { height: 300, botX: 52, botY: null, botDiameter: 44 },
  review: { height: 236, botX: 52, botY: null, botDiameter: 44 },
  stats: { height: 196, botX: 52, botY: null, botDiameter: 44 },
  // No Mochi on the panel: the study UI has its own rail.
  study: { height: STUDY_SIZE.h, botX: 0, botY: null, botDiameter: 0 },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50 },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46 },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0 },
};

/** Chat view grows with the conversation — IslandContainer.chatPromptHeight. */
export function chatPromptHeight(messageCount: number): number {
  return Math.min(300, 240 + messageCount * 40);
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
  chatExpanded = false,
  /** Height the chat's content needs, measured; 0 = unknown. */
  chatFit = 0,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      return { w: NOTCH_W, h: 0 };
    case "compact":
      return { w: COMPACT_W, h: NOTCH_H };
    case "expanded": {
      if (view === "study") return { w: STUDY_SIZE.w, h: STUDY_SIZE.h };
      if (view === "prompt" && chatExpanded) return { w: CHAT_EXPANDED.w, h: CHAT_EXPANDED.h };
      const h =
        view === "prompt"
          ? chatFit > 0
            ? // Grows with what is in it, so a long reply is shown whole; past
              // the maximize size the conversation scrolls.
              Math.max(chatPromptHeight(0), Math.min(CHAT_EXPANDED.h, chatFit))
            : chatPromptHeight(chatCount)
          : VIEW_LAYOUTS[view].height;
      return { w: EXPANDED_W, h };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(mode: IslandMode, view: IslandViewName, islandH: number): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: 40, cy: 16, diameter: 20, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      // A view with no character (the study panel).
      if (layout.botDiameter === 0) return { cx: 0, cy: 0, diameter: 0, opacity: 0 };
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
