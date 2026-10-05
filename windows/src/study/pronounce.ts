// Speaking practice: how close what the recogniser heard is to the line the
// learner meant to say. This checks *what was recognised*, not pitch accent.
//
// Both sides are compared as plain Japanese, character by character: katakana
// is folded to hiragana and punctuation and spaces are dropped. The target comes
// from the tutor's line without its readings; the transcript comes from speech
// recognition, which may write a word with other kanji or kana than the target,
// so a miss is a hint, not a verdict.

import { toHiragana } from "./romaji.ts";

export type PartKind = "ok" | "miss" | "extra";

export interface Part {
  text: string;
  kind: PartKind;
}

export interface Comparison {
  /** 0..1: 2 × common characters / (target + heard). */
  score: number;
  /** The target with the characters that were not heard marked "miss". */
  target: Part[];
  /** What was heard, with characters not in the target marked "extra". */
  heard: Part[];
  verdict: "great" | "close" | "again";
}

const IGNORED = /[\s、。，．,.!?！？「」『』（）()\[\]【】〜~…・ー-]/g;

/** Hiragana, lower case, without punctuation: the form two lines are compared in. */
export function normalize(s: string): string {
  return toHiragana(s.normalize("NFKC")).replace(IGNORED, "").toLowerCase();
}

/** Longest common subsequence, as which indexes of `a` and `b` are shared. */
function lcs(a: string[], b: string[]): { a: Set<number>; b: Set<number> } {
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const ia = new Set<number>();
  const ib = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ia.add(i++);
      ib.add(j++);
    } else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return { a: ia, b: ib };
}

/** Marks each *displayed* character by whether its normalised form was shared. */
function mark(display: string, shared: Set<number>, wrong: PartKind): Part[] {
  const parts: Part[] = [];
  let k = 0; // index into the normalised string
  for (const ch of display) {
    const norm = normalize(ch);
    let kind: PartKind = "ok";
    if (norm.length > 0) {
      // A character may normalise to more than one (NFKC); it is right if all are shared.
      const idx = [...norm].map((_, o) => k + o);
      k += idx.length;
      kind = idx.every((x) => shared.has(x)) ? "ok" : wrong;
    }
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += ch;
    else parts.push({ text: ch, kind });
  }
  return parts;
}

export function compare(target: string, heard: string): Comparison {
  const a = [...normalize(target)];
  const b = [...normalize(heard)];
  if (a.length === 0 || b.length === 0) {
    return { score: 0, target: [{ text: target, kind: "miss" }], heard: b.length ? [{ text: heard, kind: "extra" }] : [], verdict: "again" };
  }
  const common = lcs(a, b);
  const score = (2 * common.a.size) / (a.length + b.length);
  return {
    score,
    target: mark(target, common.a, "miss"),
    heard: mark(heard, common.b, "extra"),
    verdict: score >= 0.9 ? "great" : score >= 0.6 ? "close" : "again",
  };
}
