// The tutor's reply format (see src-tauri/src/tutor.rs) and how Japanese is
// drawn: furigana as <ruby>, an optional romaji line, a play button.
//
//   JP: 今日{きょう}は何{なに}を食{た}べましたか。
//   EN: What did you eat today?
//   NOTE: …
//   FIX: わたしわ => わたしは | は is read "wa"
//   NEW: 食べる|たべる|to eat

import { kanaToRomaji } from "./romaji.ts";

export type Block =
  | { kind: "jp"; text: string }
  | { kind: "en"; text: string }
  | { kind: "note"; text: string }
  | { kind: "fix"; said: string; correct: string; why: string }
  | { kind: "new"; word: string; reading: string; meaning: string };

const TAG = /^\s*(JP|EN|NOTE|FIX|NEW)\s*[:：]\s*(.*)$/i;

/** Markdown the model may slip in anyway: bold markers, bullets, headings. */
function plain(s: string): string {
  return s.replace(/\*\*|__/g, "").replace(/^\s*(?:[-*•]|#+)\s+/, "").trim();
}

export function parseReply(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = plain(raw);
    if (!line) continue;
    const m = TAG.exec(line);
    if (!m) {
      blocks.push({ kind: "note", text: line });
      continue;
    }
    const tag = m[1].toUpperCase();
    const body = plain(m[2]);
    if (!body) continue;
    switch (tag) {
      case "JP":
        blocks.push({ kind: "jp", text: body });
        break;
      case "EN":
        blocks.push({ kind: "en", text: body });
        break;
      case "NOTE":
        blocks.push({ kind: "note", text: body });
        break;
      case "FIX": {
        const [pair, ...why] = body.split("|");
        const [said, correct] = pair.split(/=>|→/);
        blocks.push({
          kind: "fix",
          said: (said ?? "").trim(),
          correct: (correct ?? said ?? "").trim(),
          why: why.join("|").trim(),
        });
        break;
      }
      case "NEW": {
        const [word, reading, ...meaning] = body.split("|").map((s) => s.trim());
        if (word) blocks.push({ kind: "new", word, reading: reading ?? "", meaning: meaning.join(", ") });
        break;
      }
    }
  }
  return blocks;
}

// ── Furigana ──────────────────────────────────────────────────────────────────

export interface Segment {
  base: string;
  /** Kana reading of `base`, when it carries kanji. */
  reading?: string;
}

const KANJI_RUN = /[㐀-䶿一-鿿豈-﫿々〆ヶ]+$/;

/** `今日{きょう}は` → [{base:"今日", reading:"きょう"}, {base:"は"}]. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\{([^{}]*)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushPlain = (s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev && prev.reading === undefined) prev.base += s;
    else out.push({ base: s });
  };
  while ((m = re.exec(text))) {
    const before = text.slice(last, m.index);
    const run = KANJI_RUN.exec(before);
    if (run && m[1].trim()) {
      pushPlain(before.slice(0, run.index));
      out.push({ base: run[0], reading: m[1].trim() });
    } else {
      // Braces after kana: the reading adds nothing, drop it.
      pushPlain(before);
    }
    last = m.index + m[0].length;
  }
  pushPlain(text.slice(last));
  return out;
}

/** The sentence without readings, as it would be printed. */
export function plainJapanese(text: string): string {
  return segments(text).map((s) => s.base).join("");
}

/** The sentence in kana only (kanji replaced by their readings). */
export function kanaOf(text: string): string {
  return segments(text).map((s) => s.reading ?? s.base).join("");
}

/** Particles set apart after a kanji word when a new word follows them (私も学生 → watashi mo gakusei). */
const SPACED_PARTICLES = "もがにでとのや";
const HIRAGANA = /[ぁ-ゟ]/;

/**
 * Romaji for a JP line, with spaces between words where they can be told
 * apart. は / へ / を count as particles when they follow a word written with
 * kanji, or when nothing kana-like follows them: a heuristic, right for the
 * short sentences beginners meet.
 */
export function romajiOf(text: string): string {
  let kana = "";
  const particles = new Set<number>();
  const spaces = new Set<number>();
  const segs = segments(text);
  segs.forEach((seg, si) => {
    const piece = seg.reading ?? seg.base;
    if (seg.reading === undefined) {
      const afterKanjiWord = si > 0 && segs[si - 1].reading !== undefined;
      if (afterKanjiWord) {
        if (/^(です|でした|でしょう|だ)/.test(piece)) spaces.add(kana.length);
        else if (SPACED_PARTICLES.includes(piece[0]) && !HIRAGANA.test(piece[1] ?? "")) {
          spaces.add(kana.length);
          spaces.add(kana.length + 1);
        }
      }
      [...piece].forEach((c, ci) => {
        if (c === "を") particles.add(kana.length + ci);
        if (c !== "は" && c !== "へ") return;
        const afterKanji = ci === 0 && si > 0 && segs[si - 1].reading !== undefined;
        const next = piece[ci + 1];
        const alone = next === undefined || /[、。！？!?\s」）)]/.test(next);
        if (afterKanji || alone) particles.add(kana.length + ci);
      });
    }
    kana += piece;
  });
  return kanaToRomaji(kana, particles, spaces);
}

export interface RubyOptions {
  /** "always", "unknown" (hide over words the learner knows well), "off". */
  furigana: "always" | "unknown" | "off";
  /** Bases (kanji words) the learner knows well; used by "unknown". */
  known?: ReadonlySet<string>;
}

/** The Japanese line as DOM: <ruby> for each word with a reading. */
export function rubyNodes(text: string, opts: RubyOptions): Node[] {
  return segments(text).map((seg) => {
    if (seg.reading === undefined) return document.createTextNode(seg.base);
    const hide = opts.furigana === "off" || (opts.furigana === "unknown" && isKnown(seg.base, opts.known));
    const ruby = document.createElement("ruby");
    ruby.append(seg.base);
    const rt = document.createElement("rt");
    rt.textContent = seg.reading;
    if (hide) ruby.classList.add("rt-hidden");
    ruby.append(rt);
    // Hidden readings are one tap away.
    if (hide) ruby.addEventListener("click", () => ruby.classList.toggle("rt-hidden"));
    return ruby;
  });
}

function isKnown(base: string, known?: ReadonlySet<string>): boolean {
  if (!known) return false;
  for (const w of known) if (w === base || w.startsWith(base)) return true;
  return false;
}
