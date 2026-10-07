// The Today tab: one card, two pages you slide between with the wheel or by dragging.
//
//   Goal  Am I on track? A progress ring, one headline, and ONE main action that follows
//         the situation (cards due → Review; goal reached → keep chatting; else Talk).
//   Work  Does anything need me? The AI agents on this PC: those that need you or are
//         busy at full size first, idle ones shrunk to a line.
//
// A small label row shows where you are and can be clicked. When an agent needs you the
// "Work" label carries a count and the top Today tab a dot, so it is noticed from Goal.

import { h, clear } from "./dom";
import { icon } from "./phosphor";
import { brandIcon } from "./brands";
import { State } from "../core/state";
import { Agents, refreshAgents, setAgents, startAgents, type AgentSession } from "../core/agents";
import { Approvals, clearQuestions, decide, type Approval, type Question } from "../core/approvals";
import type { ViewActions, ViewHost } from "./views";

/** The few helpers views.ts owns. */
export interface TodayUI {
  card(...children: (Node | string)[]): HTMLElement;
  btn(label: string, kind: "primary" | "secondary", onClick: () => void): HTMLElement;
}

const QUICK_ASKS = [
  { label: "How do I say…", prompt: "" },
  { label: "Word of the day", prompt: "Teach me one useful Japanese word for today, with an example sentence." },
  { label: "Quiz me", prompt: "Quiz me with ONE quick question on a word I know or am learning. Ask it in the tagged format and do not give the answer. My next message is my answer." },
];

const PAGES = ["Goal", "Work"] as const;
const SVG_NS = "http://www.w3.org/2000/svg";
const RING = { size: 56, stroke: 5 };

/** A circular progress ring with the minutes in its middle. */
function ring() {
  const r = (RING.size - RING.stroke) / 2;
  const c = 2 * Math.PI * r;
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", `0 0 ${RING.size} ${RING.size}`);
  el.setAttribute("class", "ring");
  const circle = (cls: string) => {
    const e = document.createElementNS(SVG_NS, "circle");
    e.setAttribute("cx", String(RING.size / 2));
    e.setAttribute("cy", String(RING.size / 2));
    e.setAttribute("r", String(r));
    e.setAttribute("class", cls);
    e.setAttribute("fill", "none");
    e.setAttribute("stroke-width", String(RING.stroke));
    return e;
  };
  const track = circle("ring-track");
  const bar = circle("ring-bar");
  bar.setAttribute("stroke-linecap", "round");
  bar.setAttribute("stroke-dasharray", String(c));
  bar.setAttribute("transform", `rotate(-90 ${RING.size / 2} ${RING.size / 2})`);
  el.append(track, bar);
  const value = h("div", { class: "ring-value" });
  const unit = h("div", { class: "ring-unit", text: "min" });
  return {
    el: h("div", { class: "ring-wrap" }, el, h("div", { class: "ring-text" }, value, unit)),
    set(fraction: number, minutes: number, done: boolean) {
      bar.setAttribute("stroke-dashoffset", String(c * (1 - Math.max(0, Math.min(1, fraction)))));
      bar.classList.toggle("done", done);
      value.textContent = String(Math.round(minutes));
    },
  };
}

export function buildToday(actions: ViewActions, ui: TodayUI): ViewHost {
  // ── Goal ────────────────────────────────────────────────────────────────────
  const progress = ring();
  const title = h("div", { class: "goal-title" });
  const sub = h("div", { class: "goal-sub" });
  const main = h("div", { class: "goal-cta" });
  const chips = h("div", { class: "quick-chips" });
  for (const q of QUICK_ASKS) {
    chips.append(
      h("button", {
        class: "quick-chip",
        text: q.label,
        onclick: () => {
          actions.blip();
          if (q.prompt) actions.ask(q.prompt);
          else actions.setView("prompt");
        },
      }),
    );
  }
  const goalPage = h(
    "div",
    { class: "page goal-page" },
    h("div", { class: "goal-hero" }, progress.el, h("div", { class: "goal-text" }, title, sub), main),
    chips,
  );
  let ctaSig = "";
  const syncCta = (primary: [string, () => void], secondary: [string, () => void] | null) => {
    const sig = primary[0] + (secondary?.[0] ?? "");
    if (sig === ctaSig) return;
    ctaSig = sig;
    clear(main);
    if (secondary) main.append(ui.btn(secondary[0], "secondary", secondary[1]));
    main.append(ui.btn(primary[0], "primary", primary[1]));
  };

  // ── Work ────────────────────────────────────────────────────────────────────
  const workList = h("div", { class: "work-list" });
  const workPage = h("div", { class: "page work-page" }, workList);
  let workSig = "";
  const kilo = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const short = (at: number) => {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    return s < 10 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
  };
  const who = (s: AgentSession) => h("span", { class: `agent-av ${s.agent}` }, s.agent === "claude" ? brandIcon("claude", 20) : icon("chat-circle", 20));
  const modelOf = (s: AgentSession) => s.model || (s.agent === "claude" ? "claude" : "codex");

  /** The decision block: the exact request with Allow / Always / Deny, or a question with its choices. */
  const askBlock = (approval: Approval | undefined, questions: Question[]) => {
    if (approval) {
      return h(
        "div",
        { class: "agent-ask" },
        h("code", { class: "agent-cmd", text: approval.summary }),
        h(
          "div",
          { class: "agent-actions" },
          ui.btn("Deny", "secondary", () => void decide(approval, "deny")),
          ui.btn(approval.tool === "Bash" && approval.prefix ? `Always allow ${approval.prefix}` : "Always allow", "secondary", () => void decide(approval, "always")),
          ui.btn("Allow", "primary", () => void decide(approval, "allow")),
        ),
      );
    }
    if (questions.length) {
      return h(
        "div",
        { class: "agent-ask" },
        ...questions.map((q) =>
          h(
            "div",
            { class: "agent-q" },
            h("div", { class: "agent-q-text", text: q.question }),
            h("div", { class: "agent-opts" }, ...q.options.slice(0, 5).map((o, i) => h("span", { class: "agent-opt", title: o.description ?? "", text: `${i + 1}. ${o.label}` }))),
          ),
        ),
        h("div", { class: "agent-hint", text: "Answer in the terminal" }),
      );
    }
    return null;
  };

  /** An agent that needs you or is busy: the tool, the facts, the task. */
  const fullRow = (s: AgentSession, approval?: Approval, questions: Question[] = []) => {
    const line1 = approval ? `${approval.tool} needs approval` : s.target ? `${s.tool} · ${s.target}` : s.tool || s.detail;
    const diff = s.added || s.removed ? h("span", { class: "agent-diff" }, h("b", { class: "add", text: `+${s.added}` }), h("b", { class: "del", text: `-${s.removed}` })) : null;
    const facts: Node[] = [];
    if (s.tokensIn || s.tokensOut) facts.push(h("span", { class: "agent-fact" }, icon("arrow-up", 10), h("span", { text: `${kilo(s.tokensIn)} / ${kilo(s.tokensOut)}` })));
    if (s.branch) facts.push(h("span", { class: "agent-fact" }, icon("git-branch", 10), h("span", { text: s.branch })));
    facts.push(h("span", { class: "agent-fact", text: s.project }));
    return h(
      "div",
      { class: `agent-row ${s.state}` },
      who(s),
      h("div", { class: "agent-main" }, h("div", { class: "agent-l1" }, h("i", { class: "agent-dot" }), h("span", { class: "agent-tool", text: line1 }), diff), h("div", { class: "agent-l2" }, ...facts), s.prompt ? h("div", { class: "agent-task", text: s.prompt }) : null, askBlock(approval, questions)),
      h("div", { class: "agent-side" }, h("span", { class: `agent-model ${s.agent}`, text: modelOf(s) }), h("span", { class: "agent-ago", text: short(s.at) })),
    );
  };

  /** An idle agent: one line, so a long list stays calm. */
  const slimRow = (s: AgentSession) =>
    h(
      "div",
      { class: "agent-row idle slim" },
      who(s),
      h("span", { class: "agent-slim-project", text: s.project }),
      h("span", { class: "agent-slim-detail", text: s.detail }),
      h("span", { class: "agent-ago", text: short(s.at) }),
    );

  /** "1 needs you · 7": who is waiting, or who is busy, out of how many are running. */
  const workHead = (list: AgentSession[]) => {
    const waiting = list.filter((x) => x.state === "waiting").length;
    const working = list.filter((x) => x.state === "working").length;
    const lead = waiting ? `${waiting} needs you` : working ? `${working} working` : "All idle";
    return h("div", { class: "agent-head" }, h("span", { class: waiting ? "need" : working ? "busy" : "", text: lead }), h("span", { class: "total", text: ` · ${list.length}` }));
  };

  const renderWork = () => {
    const rank = { waiting: 0, working: 1, idle: 2 } as const;
    // A request makes its session "waiting" for sure, and a request from a session not seen yet still gets a row.
    const sessions: AgentSession[] = Agents.sessions.map((x) => (Approvals.pending.some((a) => a.session === x.id) ? { ...x, state: "waiting" as const } : x));
    for (const a of Approvals.pending) {
      if (!sessions.some((x) => x.id === a.session)) {
        sessions.push({ id: a.session, agent: "claude", project: a.project, state: "waiting", detail: a.tool, at: a.at, prompt: "", tool: a.tool, target: "", added: 0, removed: 0, model: "", branch: "", tokensIn: 0, tokensOut: 0 });
      }
    }
    // A question belongs to a session that is still waiting; once it moves on the question is stale.
    for (const q of Approvals.questions) {
      const owner = sessions.find((x) => x.id === q.session);
      if (owner && owner.state !== "waiting" && Date.now() - q.at > 5000) clearQuestions(q.session);
    }
    const list = sessions.sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at);
    const sig = JSON.stringify([Agents.enabled, Approvals.pending.map((a) => a.id), Approvals.questions.map((q) => q.question), list.map((x) => [x.id, x.state, x.detail, x.tokensOut, x.at > Date.now() - 60_000 ? x.at : Math.round(x.at / 60_000)])]);
    if (sig === workSig) return;
    workSig = sig;
    clear(workList);
    if (!Agents.enabled) {
      workList.append(
        h(
          "div",
          { class: "work-empty" },
          h("div", { class: "work-empty-title", text: "See your AI agents" }),
          h("div", { class: "work-empty-text", text: "Claude Code and Codex on this PC: working, waiting, done. Only the end of their session files is read; nothing is changed or sent." }),
          ui.btn("Show my agents", "primary", () => {
            setAgents(true);
            void refreshAgents();
          }),
        ),
      );
      return;
    }
    if (!list.length) {
      workList.append(h("div", { class: "work-empty" }, h("div", { class: "work-empty-title", text: "No agents running" }), h("div", { class: "work-empty-text", text: "Start Claude Code or Codex and it shows up here." })));
    } else {
      workList.append(workHead(list));
      for (const x of list.filter((r) => r.state !== "idle")) {
        workList.append(fullRow(x, Approvals.pending.find((a) => a.session === x.id), Approvals.questions.filter((q) => q.session === x.id)));
      }
      for (const s of list.filter((x) => x.state === "idle").slice(0, 4)) workList.append(slimRow(s));
    }
    workList.append(h("button", { class: "page-link", text: "Stop showing agents", onclick: () => setAgents(false) }));
  };

  // ── The pager ───────────────────────────────────────────────────────────────
  const pages = h("div", { class: "today-pages" }, goalPage, workPage);
  const workBadge = h("i", { class: "today-count" });
  const navButtons = PAGES.map((name, i) => h("button", { class: "today-tab", onclick: () => goTo(i) }, h("span", { text: name }), i === 1 ? workBadge : null));
  const nav = h("div", { class: "today-nav" }, ...navButtons);
  let page = 0;

  const width = () => pages.clientWidth;
  function goTo(i: number) {
    actions.blip();
    // The label answers the press at once; the page then glides over to it.
    page = i;
    syncNav();
    pages.scrollTo({ left: i * width(), behavior: "smooth" });
  }
  const syncNav = () => navButtons.forEach((b, i) => b.classList.toggle("on", i === page));
  syncNav();
  // While sliding or dragging, the label switches as soon as the other page is the nearer one.
  pages.addEventListener("scroll", () => {
    const w = width();
    if (w <= 0) return;
    const nearest = Math.max(0, Math.min(PAGES.length - 1, Math.round(pages.scrollLeft / w)));
    if (nearest !== page) {
      page = nearest;
      syncNav();
    }
  }, { passive: true });

  // Hold and drag with the mouse, with a snap on release.
  let down = false;
  let moved = false;
  let startX = 0;
  let startLeft = 0;
  pages.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    down = true;
    moved = false;
    startX = e.clientX;
    startLeft = pages.scrollLeft;
  });
  pages.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > 6) {
      moved = true;
      pages.setPointerCapture(e.pointerId);
      pages.classList.add("dragging");
    }
    if (moved) pages.scrollLeft = startLeft - dx;
  });
  const release = () => {
    if (!down) return;
    down = false;
    if (!moved) return;
    pages.classList.remove("dragging");
    const w = width();
    const dragged = pages.scrollLeft - startLeft;
    // A decent flick moves one page even when it did not pass the halfway mark.
    let i = Math.round(pages.scrollLeft / w);
    if (Math.abs(dragged) > w * 0.15) i = Math.max(0, Math.min(PAGES.length - 1, Math.round(startLeft / w) + Math.sign(dragged)));
    pages.scrollTo({ left: i * w, behavior: "smooth" });
    window.setTimeout(() => (moved = false), 0);
  };
  pages.addEventListener("pointerup", release);
  pages.addEventListener("pointercancel", release);
  // A drag must not press the button it started on.
  pages.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);

  // The wheel pages left and right, unless the page's own list can still scroll that way.
  let wheelLock = 0;
  pages.addEventListener("wheel", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".work-list");
    const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    if (vertical && el && el.scrollHeight > el.clientHeight + 1) {
      const atTop = el.scrollTop <= 0 && e.deltaY < 0;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atEnd) return;
    }
    e.preventDefault();
    const now = performance.now();
    if (now - wheelLock < 380) return;
    wheelLock = now;
    const d = vertical ? e.deltaY : e.deltaX;
    goTo(Math.max(0, Math.min(PAGES.length - 1, page + (d > 0 ? 1 : -1))));
  }, { passive: false });

  // The island peeks open on Work when an agent asks for a decision.
  window.addEventListener("kotoba-today-page", (e) => {
    const i = Number((e as CustomEvent).detail);
    if (i >= 0 && i < PAGES.length) pages.scrollTo({ left: i * width(), behavior: "auto" });
  });

  const el = h("div", { class: "view" }, ui.card(h("div", { class: "today" }, nav, pages)));

  return {
    el,
    sync() {
      startAgents();
      renderWork();

      // Who needs you, from anywhere: a count on "Work" and a dot on the top Today tab.
      const waitingIds = new Set([...Agents.sessions.filter((x) => x.state === "waiting").map((x) => x.id), ...Approvals.pending.map((a) => a.session)]);
      const waiting = waitingIds.size;
      if (waiting !== State.agentsWaiting) {
        State.agentsWaiting = waiting;
        State.notify();
      }
      workBadge.textContent = waiting ? String(waiting) : "";
      workBadge.classList.toggle("on", waiting > 0);

      // Goal: one headline, one main action.
      const st = State.stats;
      const goalMin = Math.max(1, State.settings.dailyGoalMinutes);
      const mins = st?.todayMinutes ?? 0;
      const streak = st?.streak ?? 0;
      const due = st?.dueToday ?? 0;
      const done = mins >= goalMin;
      progress.set(mins / goalMin, mins, done);
      if (due > 0) {
        title.textContent = `${due} card${due === 1 ? "" : "s"} due`;
        syncCta(["Review", () => { actions.blip(); actions.startReview(5, false, false); }], ["Talk", () => actions.setView("prompt")]);
      } else if (done) {
        title.textContent = "Goal reached. よくできました！";
        syncCta(["Keep chatting", () => actions.setView("prompt")], null);
      } else {
        title.textContent = mins > 0 ? `${Math.max(1, Math.round(goalMin - mins))} min to your goal` : "Ready for some Japanese?";
        syncCta(["Talk", () => actions.setView("prompt")], null);
      }
      clear(sub);
      if (streak > 0) sub.append(h("span", { class: "goal-fact flame" }, icon("flame", 12), h("span", { text: `${streak}-day streak` })));
      sub.append(h("span", { class: "goal-fact", text: `${st?.words ?? 0} words` }), h("span", { class: "goal-fact", text: st?.level.label ?? "Absolute beginner" }));
    },
  };
}
