// Overview task ticker, shown like lyrics in a karaoke player.
//
// Each step is a line in a real column, one under the other. The column only
// ever moves as a whole: a new step joins at the bottom and the column glides
// up one line, so the line being "sung" is always the bottom one and the line
// before it sits dimmed above. Because lines are laid out in flow, two of them
// can never land on the same spot — the overlap the old three-row machine
// produced when steps arrived in bursts is impossible by construction.
//
// Motion is a CSS transition on the column's transform, so it runs on the
// compositor, needs nothing from the island's frame loop, and a burst of steps
// simply retargets the glide instead of queueing animations.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import type { AgentTask } from "../core/state";

const LINE_H = 22;
/** Lines kept in the column; older ones are trimmed off the top. */
const KEEP = 6;

interface Line {
  el: HTMLElement;
  text: string;
}

function makeLine(text: string): Line {
  const el = h(
    "div",
    { class: "lyric" },
    h(
      "span",
      { class: "lyric-icon" },
      svg(ICONS.chevronRight, 9, { stroke: 2.4 }),
      svg(ICONS.check, 8, { stroke: 2.2 }),
    ),
    h("span", { class: "lyric-text", text, "data-text": text }),
  );
  return { el, text };
}

export class Ticker {
  readonly el: HTMLElement;
  private column: HTMLElement;
  private lines: Line[] = [];
  private displayIndex = -1;

  constructor() {
    this.column = h("div", { class: "lyrics" });
    this.el = h("div", { class: "ticker" }, this.column);
    // The ticker fills whatever the card leaves it. When that changes (the
    // card is laid out, the island resizes), re-anchor without motion.
    new ResizeObserver(() => this.settle(false)).observe(this.el);
  }

  /** CSS runs the motion; the island's frame loop has nothing to keep alive. */
  get animating(): boolean {
    return false;
  }

  sync(task: AgentTask | null) {
    const steps = task && task.steps.length > 0 ? task.steps : ["…"];
    const idx = task ? Math.min(task.stepIndex, steps.length - 1) : -1;

    // First render, or the session restarted (steps cleared): lay the last two
    // steps down in place, without motion.
    if (this.displayIndex < 0 || idx < this.displayIndex) {
      this.displayIndex = idx;
      const from = Math.max(0, idx - 1);
      this.reset(idx > 0 ? steps.slice(from, idx + 1) : [steps[Math.max(idx, 0)]]);
      return;
    }

    if (idx === this.displayIndex) {
      // Same step, but its text may have been refined (a longer command line).
      const last = this.lines.at(-1);
      const text = steps[Math.max(idx, 0)];
      if (last && last.text !== text) this.setText(last, text);
      return;
    }

    // New steps: each joins the bottom. A burst adds several lines at once and
    // the column glides straight to the newest — no queue, nothing dropped
    // from view mid-way, nothing piled up.
    for (let i = this.displayIndex + 1; i <= idx; i++) this.push(steps[i]);
    this.displayIndex = idx;
    this.trim();
    this.settle(true);
  }

  /** Kept for the view contract; motion is CSS-driven. */
  tick(_nowMs: number) {}

  // ── Column ────────────────────────────────────────────────────────────────

  private push(text: string) {
    const line = makeLine(text);
    this.lines.push(line);
    this.column.append(line.el);
  }

  private setText(line: Line, text: string) {
    line.text = text;
    const span = line.el.querySelector<HTMLElement>(".lyric-text");
    if (span) {
      span.textContent = text;
      span.dataset.text = text;
    }
  }

  private reset(texts: string[]) {
    this.column.replaceChildren();
    this.lines = [];
    for (const t of texts) this.push(t);
    this.settle(false);
  }

  /** Drops lines scrolled out of sight, compensating so nothing visibly moves. */
  private trim() {
    const extra = this.lines.length - KEEP;
    if (extra <= 0) return;
    for (const line of this.lines.splice(0, extra)) line.el.remove();
    // The column is about to glide anyway; jump it back by the removed height
    // first so the glide starts from where the eye already is.
    this.column.style.transition = "none";
    this.column.style.transform = `translateY(${-this.offsetFor(this.lines.length - 1 - this.newLines())}px)`;
    void this.column.offsetHeight; // commit the jump before re-enabling motion
    this.column.style.transition = "";
  }

  /** Lines added since the column last settled (they are still below view). */
  private newLines(): number {
    return this.lines.filter((l) => !l.el.classList.contains("placed")).length;
  }

  /**
   * The column offset that puts line `i` on the ticker's bottom edge, with
   * the lines before it stacked above. Negative while there are fewer lines
   * than fit, which pushes them down — the newest is always at the bottom.
   */
  private offsetFor(i: number): number {
    const height = this.el.clientHeight || 2 * LINE_H; // not laid out yet
    return (i + 1) * LINE_H - height;
  }

  /** Marks the bottom line current, the rest sung, and glides into place. */
  private settle(animate: boolean) {
    const last = this.lines.length - 1;
    this.lines.forEach((line, i) => {
      line.el.classList.add("placed");
      line.el.classList.toggle("now", i === last);
      line.el.classList.toggle("sung", i < last);
      // Restart the karaoke sweep on the line that just became current.
      if (i === last && animate) {
        line.el.classList.remove("sweep");
        void line.el.offsetWidth;
        line.el.classList.add("sweep");
      }
    });
    if (!animate) this.column.style.transition = "none";
    this.column.style.transform = `translateY(${-this.offsetFor(last)}px)`;
    if (!animate) {
      void this.column.offsetHeight;
      this.column.style.transition = "";
    }
  }
}
