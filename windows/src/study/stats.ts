// Stats: where the learner stands. Headline numbers as tiles, then the level
// trend, twelve weeks of activity, what kinds of mistakes come up, and the
// words that need work. Charts are inline SVG drawn here, no library.

import { h, clear } from "../views/dom";
import { icon, type IconName } from "../views/phosphor";
import type { DayStat, Stats } from "../core/bridge";
import { playButton } from "./reply";
import type { StudyContext } from "./app";

const NS = "http://www.w3.org/2000/svg";

/** One-hue sequential ramp (blue), stepped for the dark surface: 0 → most. */
const HEAT = ["#1c1e22", "#184f95", "#256abf", "#3987e5", "#86b6ef"];

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ── Tooltip (one for the page) ────────────────────────────────────────────────

const tip = h("div", { class: "viz-tip", role: "status" });
function showTip(x: number, y: number, value: string, label: string) {
  clear(tip);
  tip.append(h("b", { text: value }), h("span", { text: label }));
  tip.classList.add("on");
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
  tip.style.top = `${y - tip.offsetHeight - 10}px`;
}
function hideTip() {
  tip.classList.remove("on");
}

/** Hover and keyboard focus show the same details. */
function hoverable(node: Element, value: () => string, label: () => string) {
  const at = () => {
    const r = node.getBoundingClientRect();
    showTip(r.left + r.width / 2, r.top, value(), label());
  };
  node.setAttribute("tabindex", "0");
  node.addEventListener("pointerenter", at);
  node.addEventListener("focus", at);
  node.addEventListener("pointerleave", hideTip);
  node.addEventListener("blur", hideTip);
}

const fmtDate = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const fmtMinutes = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);

// ── Pieces ────────────────────────────────────────────────────────────────────

function tile(label: string, value: string, sub: string, glyph?: IconName): HTMLElement {
  return h(
    "div",
    { class: "tile" },
    h("div", { class: "tile-label" }, glyph ? icon(glyph, 12) : null, h("span", { text: label })),
    h("div", { class: "tile-value", text: value }),
    h("div", { class: "tile-sub", text: sub }),
  );
}

function panel(title: string, sub: string, body: Node, table?: HTMLElement): HTMLElement {
  return h(
    "section",
    { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", { text: title }), h("span", { class: "panel-sub", text: sub })),
    body,
    table ? h("details", { class: "data-table" }, h("summary", { text: "View as table" }), table) : null,
  );
}

function table(head: string[], rows: string[][]): HTMLElement {
  return h(
    "table",
    {},
    h("thead", {}, h("tr", {}, ...head.map((c) => h("th", { text: c })))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((c) => h("td", { text: c }))))),
  );
}

/** Level over time: one series, so no legend; the crosshair snaps to each day. */
function levelChart(stats: Stats): HTMLElement {
  const pts = stats.level.history;
  const W = 520;
  const H = 160;
  const pad = { l: 34, r: 12, t: 12, b: 24 };
  const box = h("div", { class: "chart" });
  if (pts.length < 2) {
    box.append(h("div", { class: "chart-empty", text: pts.length ? "One reading so far. The trend appears after a few days of study." : "Mochi will estimate your level as you talk." }));
    return box;
  }
  const s = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "line-chart", role: "img", "aria-label": `Level over ${pts.length} days, now ${stats.level.score}` });
  const max = Math.max(30, Math.ceil(Math.max(...pts.map((p) => p.score)) / 10) * 10);
  const x = (i: number) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  for (const v of [0, max / 2, max]) {
    s.append(el("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: "grid" }));
    const t = el("text", { x: pad.l - 8, y: y(v) + 3, class: "axis", "text-anchor": "end" });
    t.textContent = String(Math.round(v));
    s.append(t);
  }
  for (const [i, anchor] of [[0, "start"], [pts.length - 1, "end"]] as const) {
    const t = el("text", { x: x(i), y: H - 6, class: "axis", "text-anchor": anchor });
    t.textContent = fmtDate(pts[i].date);
    s.append(t);
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join("");
  s.append(el("path", { d, class: "line" }));
  const last = pts[pts.length - 1];
  s.append(el("circle", { cx: x(pts.length - 1), cy: y(last.score), r: 4, class: "line-end" }));
  const label = el("text", { x: x(pts.length - 1) - 8, y: y(last.score) - 10, class: "direct-label", "text-anchor": "end" });
  label.textContent = String(Math.round(last.score));
  s.append(label);

  // Crosshair: a hairline and a dot snap to the nearest day.
  const hair = el("line", { y1: pad.t, y2: H - pad.b, class: "crosshair" });
  const dot = el("circle", { r: 4, class: "line-dot" });
  hair.style.display = dot.style.display = "none";
  s.append(hair, dot);
  const hit = el("rect", { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, fill: "transparent" });
  s.append(hit);
  hit.addEventListener("pointermove", (e) => {
    const r = s.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1))));
    hair.setAttribute("x1", String(x(i)));
    hair.setAttribute("x2", String(x(i)));
    dot.setAttribute("cx", String(x(i)));
    dot.setAttribute("cy", String(y(pts[i].score)));
    hair.style.display = dot.style.display = "";
    showTip(r.left + (x(i) / W) * r.width, r.top + (y(pts[i].score) / H) * r.height, `Level ${Math.round(pts[i].score)}`, fmtDate(pts[i].date));
  });
  hit.addEventListener("pointerleave", () => {
    hair.style.display = dot.style.display = "none";
    hideTip();
  });
  box.append(s);
  return box;
}

/** 12 weeks × 7 days, minutes studied. Sequential blue; empty days recede. */
function heatmap(days: DayStat[]): HTMLElement {
  const cell = 14;
  const gap = 3;
  const first = new Date(`${days[0].date}T12:00:00`).getDay(); // 0 = Sunday
  const cols = Math.ceil((days.length + first) / 7);
  const W = cols * (cell + gap);
  const H = 7 * (cell + gap) + 18;
  // Drawn at its natural size (cells stay 14 px), shrinking only if the panel is narrower.
  const s = el("svg", { viewBox: `0 0 ${W + 26} ${H}`, width: W + 26, height: H, class: "heatmap", role: "img", "aria-label": "Minutes studied per day, last 12 weeks" });
  const max = Math.max(...days.map((d) => d.minutes), 1);
  const step = (m: number) => (m <= 0 ? 0 : Math.min(4, 1 + Math.floor((m / max) * 3.999)));
  ["M", "W", "F"].forEach((t, i) => {
    const tx = el("text", { x: 0, y: (1 + i * 2) * (cell + gap) + cell - 3, class: "axis" });
    tx.textContent = t;
    s.append(tx);
  });
  days.forEach((d, i) => {
    const k = i + first;
    const c = Math.floor(k / 7);
    const r = k % 7;
    const rect = el("rect", { x: 26 + c * (cell + gap), y: r * (cell + gap), width: cell, height: cell, rx: 3, fill: HEAT[step(d.minutes)], class: "cell" });
    hoverable(
      rect,
      () => (d.minutes > 0 ? fmtMinutes(d.minutes) : "No study"),
      () => `${fmtDate(d.date)}${d.newWords ? ` · ${d.newWords} new word${d.newWords > 1 ? "s" : ""}` : ""}`,
    );
    s.append(rect);
  });
  // Legend: less → more.
  const ly = 7 * (cell + gap) + 4;
  const right = W + 26;
  const boxes = right - 34 - HEAT.length * 13;
  const less = el("text", { x: boxes - 6, y: ly + 9, class: "axis", "text-anchor": "end" });
  less.textContent = "Less";
  s.append(less);
  HEAT.forEach((c, i) => s.append(el("rect", { x: boxes + i * 13, y: ly, width: 10, height: 10, rx: 2, fill: c })));
  const more = el("text", { x: right, y: ly + 9, class: "axis", "text-anchor": "end" });
  more.textContent = "More";
  s.append(more);
  return h("div", { class: "chart" }, s);
}

const KIND_LABEL: Record<string, string> = {
  vocab: "Vocabulary",
  grammar: "Grammar",
  particle: "Particles",
  conjugation: "Conjugation",
  kana: "Kana / reading",
  other: "Other",
};

/** Mistakes by kind: one measure, so one hue; values labelled at the bar end. */
function kindBars(stats: Stats): HTMLElement {
  const rows = stats.mistakesByKind;
  if (rows.length === 0) return h("div", { class: "chart-empty", text: "No mistakes logged yet. They'll show up here as Mochi corrects you." });
  const max = Math.max(...rows.map((r) => r.count));
  const list = h("div", { class: "bars" });
  for (const r of rows) {
    const bar = h("div", { class: "bar", style: `width:${Math.max(4, (r.count / max) * 100)}%` });
    const track = h("div", { class: "bar-track" }, bar);
    hoverable(track, () => `${r.count}`, () => KIND_LABEL[r.kind] ?? r.kind);
    list.append(h("div", { class: "bar-row" }, h("span", { class: "bar-label", text: KIND_LABEL[r.kind] ?? r.kind }), track, h("span", { class: "bar-value", text: String(r.count) })));
  }
  return list;
}

// ── View ──────────────────────────────────────────────────────────────────────

export function buildStats(ctx: StudyContext, practise: (text: string) => void) {
  const root = h("div", { class: "stats" });
  document.body.append(tip);

  function render() {
    clear(root);
    const st = ctx.stats;
    root.append(h("div", { class: "stats-head" }, h("h1", { text: "Your Japanese" }), h("span", { class: "panel-sub", text: "Updated after every message" })));
    if (!st) {
      root.append(h("div", { class: "chart-empty", text: "Stats appear once Kotoba is running." }));
      return;
    }
    const acc = st.accuracy30 == null ? "—" : `${Math.round(st.accuracy30 * 100)}%`;
    root.append(
      h(
        "div",
        { class: "tiles" },
        tile("Level", `${Math.round(st.level.score)}`, `${st.level.label} · of 100`, "sparkle"),
        tile("Streak", `${st.streak} day${st.streak === 1 ? "" : "s"}`, `Best ${st.bestStreak}`, "flame"),
        tile("Words", `${st.words}`, `${st.solid} solid · ${st.weak} to review`, "book-open"),
        tile("Accuracy", acc, "Last 30 days", "target"),
        tile("Time", fmtMinutes(st.totalMinutes), `${fmtMinutes(st.todayMinutes)} today`, "clock"),
        tile("Speaking", st.speakingAvg30 == null ? "—" : `${Math.round(st.speakingAvg30 * 100)}%`, st.speaking30 ? `${st.speaking30} attempt${st.speaking30 === 1 ? "" : "s"} · 30 days` : "Try the mic on a line", "microphone"),
      ),
    );
    if (st.level.reason) root.append(h("div", { class: "level-reason" }, h("b", { text: "Mochi's take  " }), h("span", { text: st.level.reason })));

    const grid = h("div", { class: "panels" });
    grid.append(
      panel("Level", "Mochi's estimate, 0–100", levelChart(st), table(["Date", "Level"], st.level.history.map((p) => [p.date, String(Math.round(p.score))]))),
      panel(
        "Activity",
        "Minutes per day, last 12 weeks",
        heatmap(st.activity),
        table(["Date", "Minutes", "Messages", "New words"], st.activity.filter((d) => d.messages > 0).map((d) => [d.date, d.minutes.toFixed(1), String(d.messages), String(d.newWords)])),
      ),
      panel("Mistakes", "By kind, all time", kindBars(st)),
      panel("To review", "Words that need another go", weakList(st)),
    );
    root.append(grid);

    if (st.recentMistakes.length) {
      const list = h("div", { class: "mistakes" });
      for (const m of st.recentMistakes) {
        list.append(
          h(
            "div",
            { class: "mistake" },
            h("span", { class: "m-said", lang: "ja", text: m.said }),
            h("span", { class: "m-arrow" }, icon("arrow-right", 12)),
            h("span", { class: "m-correct", lang: "ja", text: m.correct.replace(/\{[^}]*\}/g, "") }),
            h("span", { class: "m-note", text: m.note || KIND_LABEL[m.kind] || m.kind }),
          ),
        );
      }
      root.append(panel("Recent corrections", "", list));
    }
  }

  function weakList(st: Stats): HTMLElement {
    if (st.weakWords.length === 0) return h("div", { class: "chart-empty", text: "Nothing to review. Words you stumble on will collect here." });
    const list = h("div", { class: "weak-list" });
    for (const w of st.weakWords) {
      list.append(
        h(
          "div",
          { class: "side-word" },
          playButton(w.surface, `weak:${w.surface}`),
          h("div", { class: "side-word-body" }, h("span", { class: "word-jp", lang: "ja", text: w.surface }), h("span", { class: "word-meaning", text: [w.reading !== w.surface ? w.reading : "", w.meaning].filter(Boolean).join(" · ") })),
          h("div", { class: "strength", title: `Strength ${Math.round(w.strength * 100)}%` }, h("i", { style: `width:${Math.round(w.strength * 100)}%` })),
        ),
      );
    }
    const words = st.weakWords.slice(0, 5).map((w) => w.surface).join("、");
    list.append(h("button", { class: "primary-btn", onclick: () => practise(`Let's practise these words I keep getting wrong: ${words}. Use them in a short conversation with me.`) }, h("span", { text: "Practise in Ask" }), icon("arrow-right", 12)));
    return list;
  }

  return { el: root, refresh: render };
}
