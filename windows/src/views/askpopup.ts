// Select text in a message and a small popup offers to ask Mochi about it:
// "Explain" sends the question at once, "Ask…" quotes the text in the chat field
// so you can write your own. Works on chat bubbles and on a lookup's answer.

import { h } from "./dom";

/** Where a selection may offer the popup. */
const ASKABLE = ".bubble, .lookup-reply, .lookup-source";
/** Longest quote sent to the AI: a sentence or two, not a page. */
const MAX_QUOTE = 400;

export interface AskPopupActions {
  /** Send "what does this mean?" for the quoted text. */
  explain(quote: string): void;
  /** Put the quoted text in the chat field and focus it. */
  ask(quote: string): void;
  /** The popup is up: keep the island open. */
  keepOpen(): void;
}

/** The selected text without furigana (<rt>) or a button's label, whitespace collapsed. */
function selectedText(range: Range): string {
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  holder.querySelectorAll("rt, rp, button").forEach((n) => n.remove());
  const text = (holder.textContent ?? "").replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length > MAX_QUOTE ? `${chars.slice(0, MAX_QUOTE).join("")}…` : text;
}

let hide: () => void = () => {};

/** Takes the popup down (the island closed, or the view changed). */
export function hideAskPopup() {
  hide();
}

export function installAskPopup(actions: AskPopupActions) {
  let quote = "";
  const explain = h("button", { class: "ask-popup-btn", text: "Explain" });
  const ask = h("button", { class: "ask-popup-btn primary", text: "Ask…" });
  const popup = h("div", { class: "ask-popup", role: "toolbar", "aria-label": "Ask Mochi about the selection" }, explain, ask);
  // A press on the popup must not clear the selection it is about.
  popup.addEventListener("mousedown", (e) => e.preventDefault());
  document.body.append(popup);

  hide = () => {
    popup.classList.remove("on");
    quote = "";
  };

  const use = (run: (q: string) => void) => () => {
    const q = quote;
    hide();
    window.getSelection()?.removeAllRanges();
    if (q) run(q);
  };
  explain.addEventListener("click", use((q) => actions.explain(q)));
  ask.addEventListener("click", use((q) => actions.ask(q)));

  function update() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hide();
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const region = (node instanceof Element ? node : node.parentElement)?.closest(ASKABLE);
    const text = region ? selectedText(range) : "";
    if ([...text].length < 2) return hide();
    const rects = range.getClientRects();
    const island = document.getElementById("island")?.getBoundingClientRect();
    if (!rects.length || !island) return hide();

    quote = text;
    popup.classList.add("on");
    const first = rects[0];
    const last = rects[rects.length - 1];
    const w = popup.offsetWidth;
    const hgt = popup.offsetHeight;
    // Above the selection, or below it when the island's edge is in the way; never outside the island.
    const above = first.top - hgt - 6;
    const y = above >= island.top + 4 ? above : last.bottom + 6;
    const x = Math.min(Math.max(first.left + first.width / 2 - w / 2, island.left + 4), island.right - w - 4);
    popup.style.left = `${Math.round(x)}px`;
    popup.style.top = `${Math.round(y)}px`;
    actions.keepOpen();
  }

  // After the mouse is released (or a keyboard selection ends), once the selection has settled.
  document.addEventListener("pointerup", () => setTimeout(update, 0));
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") update();
  });
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hide();
  });
  // A new press elsewhere starts a new selection: the old popup goes.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!popup.contains(e.target as Node)) hide();
    },
    true,
  );
  // The text moved under it.
  document.addEventListener("scroll", () => hide(), true);
  window.addEventListener("resize", () => hide());
}
