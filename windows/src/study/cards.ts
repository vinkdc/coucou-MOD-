// A review session: the cards that are due, one at a time. Shared by the study
// window's Review view and the island's two-minute review.
//
// Cards alternate between recognition (see the word, recall what it means) and
// listening (hear it, say what it is). A missed card comes back later in the same
// session, up to twice; the schedule itself is Rust's (learner::schedule).

import { h, clear } from "../views/dom";
import { icon } from "../views/phosphor";
import { Bridge, type Card, type Grade } from "../core/bridge";
import { speak, stop } from "../core/voice";
import { today } from "../core/state";

export interface SessionOptions {
  limit: number;
  /** Show the answer straight away (a "word of the day"). */
  revealed?: boolean;
  /** Smaller layout for the island. */
  compact?: boolean;
  /** Keys 1-4 and Space (the study window only: the island has no keyboard focus). */
  keys?: boolean;
  /** Called once the session ends (all cards done, or nothing was due). */
  onDone?: (reviewed: number) => void;
  /** Called when the user wants the rest of the day's backlog. */
  onMore?: () => void;
}

const GRADES: { grade: Grade; label: string; key: string; hint: string }[] = [
  { grade: "again", label: "Again", key: "1", hint: "I didn't know it" },
  { grade: "hard", label: "Hard", key: "2", hint: "I got it, with effort" },
  { grade: "good", label: "Good", key: "3", hint: "I knew it" },
  { grade: "easy", label: "Easy", key: "4", hint: "Too easy" },
];

const MAX_RETRIES = 2;

export function buildSession(opts: SessionOptions) {
  const el = h("div", { class: opts.compact ? "review compact" : "review" });
  let queue: { card: Card; tries: number }[] = [];
  let total = 0;
  let done = 0;
  let missed = 0;
  let revealed = false;
  let busy = false;
  let kind: "see" | "hear" = "see";

  const current = () => queue[0];
  const say = (text: string) => {
    speak(text, { key: `card:${text}` }).catch(() => {});
  };

  function frame(...children: Node[]) {
    clear(el);
    el.append(...children);
  }

  function progress(): HTMLElement {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return h(
      "div",
      { class: "review-progress" },
      h("div", { class: "review-bar" }, h("i", { style: `width:${pct}%` })),
      h("span", { text: `${Math.min(done + 1, total)} / ${total}` }),
    );
  }

  function render() {
    const c = current();
    if (!c) return finish();
    const card = c.card;
    const front =
      kind === "see"
        ? h("div", { class: "review-word", lang: "ja", text: card.surface })
        : h(
            "button",
            { class: "review-listen", title: "Play again", onclick: () => say(card.surface) },
            icon("play", 12),
            h("span", { text: "Listen" }),
          );
    const answer = h(
      "div",
      { class: revealed ? "review-answer" : "review-answer hidden" },
      kind === "hear" ? h("div", { class: "review-word small", lang: "ja", text: card.surface }) : null,
      card.reading && card.reading !== card.surface ? h("div", { class: "review-reading", lang: "ja", text: card.reading }) : null,
      h("div", { class: "review-meaning", text: card.meaning || "(no meaning saved)" }),
    );
    const controls = revealed
      ? h(
          "div",
          { class: "review-grades" },
          ...GRADES.map((g) =>
            h(
              "button",
              { class: `grade ${g.grade}`, title: g.hint, onclick: () => void grade(g.grade) },
              h("span", { text: g.label }),
              opts.keys ? h("kbd", { text: g.key }) : null,
            ),
          ),
        )
      : h("button", { class: "reveal-btn", onclick: reveal }, h("span", { text: "Show answer" }), opts.keys ? h("kbd", { text: "Space" }) : null);
    frame(progress(), front, answer, controls);
  }

  function reveal() {
    if (revealed || !current()) return;
    revealed = true;
    // Seeing the word: hear it now. Hearing it was the question, so no repeat.
    if (kind === "see") say(current().card.surface);
    render();
  }

  function startCard() {
    const c = current();
    if (!c) return finish();
    kind = done % 2 === 1 && c.card.reps > 0 ? "hear" : "see";
    revealed = !!opts.revealed && done === 0;
    render();
    if (kind === "hear") say(c.card.surface);
    else if (revealed) say(c.card.surface);
  }

  async function grade(g: Grade) {
    const c = current();
    if (!c || busy) return;
    busy = true;
    try {
      await Bridge.reviewGrade(c.card.surface, g, today());
    } catch (err) {
      busy = false;
      frame(h("div", { class: "review-empty", text: String(err).replace(/^Error:\s*/, "") }));
      return;
    }
    busy = false;
    queue.shift();
    if (g === "again") {
      missed++;
      if (c.tries < MAX_RETRIES) queue.push({ card: c.card, tries: c.tries + 1 });
      else done++;
    } else {
      done++;
    }
    startCard();
  }

  function finish() {
    stop();
    const reviewed = total;
    frame(
      h(
        "div",
        { class: "review-summary" },
        h("div", { class: "review-big", lang: "ja", text: total === 0 ? "おつかれさま" : "よくできました！" }),
        h("div", {
          class: "review-meaning",
          text: total === 0 ? "Nothing is due right now. New words from your conversations show up here." : `${total} card${total === 1 ? "" : "s"} reviewed${missed ? `, ${missed} to see again soon` : ""}.`,
        }),
        opts.onMore ? h("button", { class: "reveal-btn", onclick: opts.onMore }, h("span", { text: "Keep going" })) : null,
      ),
    );
    opts.onDone?.(reviewed);
  }

  /** Loads what is due and starts. */
  async function start() {
    frame(h("div", { class: "review-empty", text: "Loading…" }));
    const cards = (await Bridge.reviewQueue(today(), opts.limit)) ?? [];
    queue = cards.map((card) => ({ card, tries: 0 }));
    total = queue.length;
    done = 0;
    missed = 0;
    startCard();
  }

  const onKey = (e: KeyboardEvent) => {
    if (!opts.keys || !el.isConnected || el.offsetParent === null) return;
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (!current()) return;
    if (!revealed && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      reveal();
    } else if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
      void grade(GRADES[Number(e.key) - 1].grade);
    }
  };
  if (opts.keys) window.addEventListener("keydown", onKey);

  return { el, start };
}
