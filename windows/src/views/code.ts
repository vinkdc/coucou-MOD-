// Code as the Home view shows it: tokenised lines with a gutter, red/green for
// a change, and the little file tab. Shared by the compact card and the editor.

import { h } from "./dom";
import {
  badgeFor, tokenize, MINI_LINES,
  type CodeLine, type FileActivity, type Lang,
} from "../core/snippet";

/** One line: gutter number, +/- sign, coloured text. */
function codeRow(line: CodeLine, lang: Lang, gutter: boolean): HTMLElement {
  const text = h("span", { class: "cl-text" });
  for (const t of tokenize(line.text, lang)) {
    text.append(t.k === "plain" ? document.createTextNode(t.s) : h("span", { class: `t-${t.k}`, text: t.s }));
  }
  if (line.text === "") text.append(document.createTextNode(" "));
  return h(
    "div",
    { class: `cl ${line.kind}` },
    gutter ? h("span", { class: "cl-no", text: line.no == null ? "" : String(line.no) }) : null,
    gutter ? h("span", { class: "cl-sign", text: line.kind === "add" ? "+" : line.kind === "del" ? "-" : "" }) : null,
    text,
  );
}

export function codeLines(lines: CodeLine[], lang: Lang, opts: { gutter?: boolean } = {}): HTMLElement {
  const box = h("div", { class: "code-lines" });
  for (const l of lines) box.append(codeRow(l, lang, opts.gutter !== false));
  return box;
}

/**
 * The 3 lines the compact card has room for. A change shows what went and what
 * came instead; anything else shows the top of what was read or written.
 */
export function miniLines(a: FileActivity): CodeLine[] {
  const changed = a.lines.filter((l) => l.kind !== "ctx");
  if (changed.length === 0) return a.lines.slice(0, MINI_LINES);
  const dels = changed.filter((l) => l.kind === "del");
  const adds = changed.filter((l) => l.kind === "add");
  const picked =
    dels.length && adds.length
      ? [...dels.slice(0, 1), ...adds.slice(0, MINI_LINES - 1)]
      : changed.slice(0, MINI_LINES);
  if (picked.length < MINI_LINES) {
    // Room left: the unchanged lines that follow the change give it some context.
    const lastAt = a.lines.lastIndexOf(picked.at(-1)!);
    picked.push(...a.lines.slice(lastAt + 1).filter((l) => l.kind === "ctx").slice(0, MINI_LINES - picked.length));
  }
  return picked;
}

/** `TS invoice.ts ●` on the left, the relative path on the right. */
export function fileTab(a: FileActivity): HTMLElement {
  const badge = badgeFor(a.path);
  const changed = a.verb !== "Read";
  const chip = h("span", { class: "ft-badge", text: badge.label });
  chip.style.background = badge.color;
  return h(
    "div",
    { class: "file-tab" },
    h("span", { class: "ft-name" }, chip, h("span", { text: a.name }), changed ? h("i", { class: "ft-dot" }) : null),
    h("span", { class: "ft-path", text: a.rel }),
  );
}
