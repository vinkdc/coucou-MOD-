// One reply from Mochi, drawn from its tagged lines: Japanese with furigana,
// romaji and a play button, its translation, corrections and new words.
// Shared by the study window and the island's quick chat.

import { h } from "../views/dom";
import { icon } from "../views/phosphor";
import { nowPlaying, onVoiceChange, speak } from "../core/voice";
import type { Settings } from "../core/state";
import { parseReply, plainJapanese, romajiOf, rubyNodes, type Block } from "./markup";
import { shadowControls } from "./shadow";

export interface ReplyOptions {
  settings: Settings;
  /** Words the learner knows well (furigana "unknown" hides theirs). */
  known?: ReadonlySet<string>;
  /** Keys play buttons so the one playing can light up: "<message id>:<line>". */
  keyPrefix: string;
  /** Shown when a line can't be played (no key, no credit…). */
  onVoiceError?: (message: string) => void;
  /** A mic button on each line to say it and check (the study window). */
  shadow?: boolean;
}

/** Every play button on screen, so the one playing can be marked. */
const buttons = new Map<string, Set<HTMLElement>>();
onVoiceChange((key) => {
  for (const [k, set] of buttons) {
    for (const b of set) {
      if (!b.isConnected) set.delete(b);
      else b.classList.toggle("playing", k === key);
    }
    if (set.size === 0) buttons.delete(k);
  }
});

export function playButton(text: string, key: string, onError?: (m: string) => void, label = "Listen"): HTMLElement {
  const b = h("button", { class: "play-btn", title: label, "aria-label": label }, icon("play", 12));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    speak(text, { key }).catch((err) => onError?.(String(err.message ?? err)));
  });
  if (nowPlaying() === key) b.classList.add("playing");
  let set = buttons.get(key);
  if (!set) buttons.set(key, (set = new Set()));
  set.add(b);
  return b;
}

/** A Japanese line: ruby text, romaji below, ▶ beside. */
export function jpLine(text: string, key: string, opts: ReplyOptions, extraClass = ""): HTMLElement {
  const s = opts.settings;
  const sentence = h("div", { class: "jp-text", lang: "ja" }, ...rubyNodes(text, { furigana: s.furigana, known: opts.known }));
  const body = h("div", { class: "jp-body" }, sentence);
  if (s.romaji) body.append(h("div", { class: "jp-romaji", text: romajiOf(text) }));
  const buttons = h("div", { class: "jp-buttons" }, playButton(plainJapanese(text), key, opts.onVoiceError));
  if (!opts.shadow) return h("div", { class: `jp-line ${extraClass}`.trim() }, buttons, body);
  const shadow = shadowControls(plainJapanese(text), (m) => opts.onVoiceError?.(m));
  buttons.append(shadow.button);
  body.append(shadow.panel);
  return h("div", { class: `jp-line ${extraClass}`.trim() }, buttons, body);
}

function enLine(text: string, show: boolean): HTMLElement {
  const el = h("div", { class: show ? "en-line" : "en-line veiled", text });
  if (!show) {
    el.title = "Show the translation";
    el.addEventListener("click", () => el.classList.remove("veiled"), { once: true });
  }
  return el;
}

function fixCard(b: Extract<Block, { kind: "fix" }>, key: string, opts: ReplyOptions): HTMLElement {
  return h(
    "div",
    { class: "fix-card" },
    h("div", { class: "fix-head", text: "Correction" }),
    h("div", { class: "fix-said", lang: "ja", text: plainJapanese(b.said) }),
    jpLine(b.correct, key, opts, "fix-correct"),
    b.why ? h("div", { class: "fix-why", text: b.why }) : null,
  );
}

function newWord(b: Extract<Block, { kind: "new" }>, key: string, opts: ReplyOptions): HTMLElement {
  return h(
    "div",
    { class: "word-chip" },
    playButton(b.word, key, opts.onVoiceError, `Listen to ${b.word}`),
    h(
      "div",
      { class: "word-body" },
      h("span", { class: "word-jp", lang: "ja", text: b.word }),
      b.reading && b.reading !== b.word ? h("span", { class: "word-reading", lang: "ja", text: b.reading }) : null,
      h("span", { class: "word-meaning", text: b.meaning }),
    ),
  );
}

/** The reply as DOM. Also returns its Japanese lines, in order, for auto-play. */
export function renderReply(text: string, opts: ReplyOptions): { el: HTMLElement; lines: { text: string; key: string }[] } {
  const blocks = parseReply(text);
  const el = h("div", { class: "reply" });
  const lines: { text: string; key: string }[] = [];
  let words: HTMLElement | null = null;
  blocks.forEach((b, i) => {
    const key = `${opts.keyPrefix}:${i}`;
    if (b.kind !== "new") words = null;
    switch (b.kind) {
      case "jp":
        el.append(jpLine(b.text, key, opts));
        lines.push({ text: plainJapanese(b.text), key });
        break;
      case "en":
        el.append(enLine(b.text, opts.settings.showEnglish));
        break;
      case "note":
        el.append(h("div", { class: "note-line", text: b.text }));
        break;
      case "fix":
        el.append(fixCard(b, key, opts));
        break;
      case "new":
        if (!words) {
          words = h("div", { class: "word-row" });
          el.append(words);
        }
        words.append(newWord(b, key, opts));
        break;
    }
  });
  return { el, lines };
}

/** New words in a reply, for the "words in this conversation" list. */
export function newWordsOf(text: string): { word: string; reading: string; meaning: string }[] {
  return parseReply(text).flatMap((b) => (b.kind === "new" ? [{ word: b.word, reading: b.reading, meaning: b.meaning }] : []));
}
