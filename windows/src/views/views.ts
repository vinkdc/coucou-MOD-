// Island views: Mochi as a companion. Home shows today at a glance; Ask is a
// quick question from anywhere; the nudge offers a short chat once a day.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { icon } from "./phosphor";
import { State } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { buildPrompt } from "./chat";
import { buildLookup } from "./lookup";
import { buildStudyHost } from "./study";
import { buildSession } from "../study/cards";

/** The reminder card was waved away ("Later"), or the user wants none for today. */
export const REMINDER_DECLINED = "kotoba:reminder-declined";
export const REMINDER_SNOOZED = "kotoba:reminder-snoozed";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  /** The study window, on a view or with a message to send ("ask:…"). */
  openStudy(view?: string): void;
  blip(): void;
  /** Nothing is waiting on the user any more: the island may auto-close again. */
  releasePin(): void;
  /** The chat is in use (typing, waiting for a reply): don't let the island auto-close. */
  keepOpen(): void;
  /** Makes the chat large, or back to its normal size. */
  toggleChatSize(): void;
  /** Starts a fresh quick chat with this prompt and sends it. */
  ask(prompt: string): void;
  /** Opens the study panel ("chat", "review", "stats", or "ask:<text>"). */
  openStudy(view?: string): void;
  /** Opens the two-minute review on the island. */
  startReview(limit: number, revealed: boolean, fromReminder: boolean): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** True while `tick` still has an animation to finish. */
  animating?(): boolean;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(label: string, kind: "primary" | "secondary", onClick: () => void): HTMLElement {
  return h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label }));
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Today", onclick: () => go("home") }, icon("house", 13), h("span", { text: "Today" }));
  const tabChat = h("button", { class: "tab", title: "Ask Mochi", onclick: () => go("prompt") }, icon("chat-circle", 13), h("span", { text: "Ask" }));
  const tabReview = h("button", { class: "tab", title: "Review due words", onclick: () => { actions.blip(); actions.startReview(5, false, false); } }, icon("cards", 13), h("span", { text: "Review" }));
  const tabProgress = h("button", { class: "tab", title: "Your progress", onclick: () => go("stats") }, icon("chart-bar", 13), h("span", { text: "Progress" }));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.hdrGear, 15, { viewBox: 256 }));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.hdrSound, 15, { viewBox: 256 }));
  const sizeBtn = h("button", { title: "Expand chat", onclick: () => (State.view === "stats" ? actions.openStudy("stats") : State.view === "study" ? go("stats") : actions.toggleChatSize()) }, svg(ICONS.hdrExpand, 15, { viewBox: 256 }));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabReview, tabProgress),
    h("div", { class: "header-actions" }, sizeBtn, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "home" || v === "nudge" || v === "lookup");
      tabChat.classList.toggle("on", v === "prompt");
      tabReview.classList.toggle("on", v === "review");
      tabProgress.classList.toggle("on", v === "stats" || v === "study");
      gearBtn.classList.toggle("on", v === "settings");
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.hdrSound : ICONS.hdrMute, 15, { viewBox: 256 }));
      const big = v === "prompt" ? State.chatExpanded : v === "study";
      sizeBtn.style.display = v === "prompt" || v === "stats" || v === "study" ? "" : "none";
      clear(sizeBtn);
      sizeBtn.append(svg(big ? ICONS.hdrShrink : ICONS.hdrExpand, 15, { viewBox: 256 }));
      sizeBtn.title = v === "prompt" ? (big ? "Shrink chat" : "Expand chat") : big ? "Back to the summary" : "See all stats";
      sizeBtn.classList.toggle("on", big);
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Home: today at a glance ───────────────────────────────────────────────────

/** Quick questions offered on Home. */
const QUICK_ASKS = [
  { label: "How do I say…", prompt: "" },
  { label: "Word of the day", prompt: "Teach me one useful Japanese word for today, with an example sentence." },
  { label: "Quiz me", prompt: "Quiz me with ONE quick question on a word I know or am learning. Ask it in the tagged format and do not give the answer. My next message is my answer." },
];

function buildHome(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const meter = h("i", { class: "goal-fill" });
  const goal = h("div", { class: "goal" }, h("div", { class: "goal-track" }, meter));
  const chips = h("div", { class: "quick-chips" });
  const dueChip = h("button", {
    class: "quick-chip due",
    onclick: () => {
      actions.blip();
      actions.startReview(5, false, false);
    },
  });
  chips.append(dueChip);
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
  const body = h(
    "div",
    { class: "stack home-stack", style: "padding:12px 16px 12px 128px" },
    h("div", { class: "home-row" }, h("div", { class: "home-text" }, title, sub), btn("Talk", "primary", () => actions.setView("prompt"))),
    goal,
    chips,
  );
  return {
    el: h("div", { class: "view" }, card(null, body)),
    sync() {
      const st = State.stats;
      const goalMin = Math.max(1, State.settings.dailyGoalMinutes);
      const mins = st?.todayMinutes ?? 0;
      const streak = st?.streak ?? 0;
      title.textContent = mins >= goalMin ? "Goal reached today. よくできました！" : streak > 0 ? `${streak}-day streak · keep it going` : "Ready for some Japanese?";
      sub.textContent = `${Math.round(mins)} / ${goalMin} min today · ${st?.words ?? 0} words · ${st?.level.label ?? "Absolute beginner"}`;
      meter.style.width = `${Math.min(100, (mins / goalMin) * 100)}%`;
      meter.classList.toggle("done", mins >= goalMin);
      const due = st?.dueToday ?? 0;
      dueChip.style.display = due > 0 ? "" : "none";
      dueChip.textContent = `Review · ${due} due`;
    },
  };
}

// ── Daily nudge ───────────────────────────────────────────────────────────────

function buildNudge(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title", lang: "ja" });
  const sub = h("div", { class: "sub" });
  const row = h(
    "div",
    { class: "actions" },
    btn("Not today", "secondary", () => {
      window.dispatchEvent(new Event(REMINDER_SNOOZED));
      actions.collapse();
    }),
    btn("Later", "secondary", () => {
      window.dispatchEvent(new Event(REMINDER_DECLINED));
      actions.collapse();
    }),
    btn("5-minute chat", "primary", () => {
      actions.collapse();
      actions.openStudy("chat");
    }),
  );
  return {
    el: h("div", { class: "view" }, card("pink", h("div", { class: "stack", style: "padding:4px 16px 4px 124px" }, title, sub, row))),
    sync() {
      const streak = State.stats?.streak ?? 0;
      title.textContent = "今日も日本語、話そう！";
      sub.textContent = streak > 0 ? `Your ${streak}-day streak is waiting. A short chat keeps it alive.` : "Let's talk in Japanese today. A short chat is enough.";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", lang: "ja", text: "いたい！ Too many pokes." }),
    h("div", { class: "sub", text: "Give me a sec. Back in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) => h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`));

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h("div", { class: "settings-row" }, icon("clock", 12), autoLabel, h("div", { class: "seg" }, ...segButtons)),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      h("div", { class: "grow" }),
      h("button", { class: "link-btn", style: "color:#8e939c;font-size:11.5px", text: "Settings…", onclick: () => actions.openSettingsWindow() }),
    ),
  );

  return {
    el: h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows))),
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
    },
  };
}

// ── Review (two minutes on the island) ────────────────────────────────────────

function buildReview(actions: ViewActions): ViewHost {
  const holder = h("div", { class: "review-holder" });
  const foot = h(
    "div",
    { class: "review-foot" },
    h("button", {
      class: "link-btn",
      text: "Later",
      onclick: () => {
        window.dispatchEvent(new Event(REMINDER_DECLINED));
        actions.collapse();
      },
    }),
    h("button", {
      class: "link-btn",
      text: "Not today",
      onclick: () => {
        window.dispatchEvent(new Event(REMINDER_SNOOZED));
        actions.collapse();
      },
    }),
  );
  let handled = -1;
  return {
    el: h("div", { class: "view" }, card(null, h("div", { class: "review-card" }, holder, foot))),
    sync() {
      const r = State.review;
      if (!r || r.token === handled) return;
      handled = r.token;
      foot.style.display = r.fromReminder ? "" : "none";
      const session = buildSession({
        limit: r.limit,
        revealed: r.revealed,
        compact: true,
        onDone: () => {
          // A finished session leaves the island open a moment, then lets it go.
          window.setTimeout(() => {
            if (State.view === "review" && State.review?.token === handled) actions.releasePin();
          }, 2500);
        },
      });
      holder.replaceChildren(session.el);
      void session.start();
    },
  };
}

// ── Progress tab: stats at a glance ──────────────────────────────────────────

function buildStats(actions: ViewActions): ViewHost {
  const tile = (label: string) => {
    const value = h("div", { class: "stat-value" });
    return { value, el: h("div", { class: "stat-tile" }, value, h("div", { class: "stat-label", text: label })) };
  };
  const level = tile("Level");
  const due = tile("Due");
  const streak = tile("Streak");
  const words = tile("Words");
  const today = tile("Today");
  const status = h("div", { class: "sub", style: "flex:1" });
  const meter = h("i", { class: "goal-fill" });
  const allBtn = btn("See all stats", "secondary", () => {
    actions.blip();
    actions.openStudy("stats");
  });
  const body = h(
    "div",
    { class: "stack", style: "padding:6px 16px 6px 84px" },
    h("div", { class: "stat-row", title: "See all stats", onclick: () => actions.openStudy("stats") }, level.el, due.el, streak.el, words.el, today.el),
    h("div", { class: "goal stat-goal" }, h("div", { class: "goal-track" }, meter)),
    h("div", { class: "home-row" }, status, h("div", { class: "actions" }, allBtn)),
  );
  return {
    el: h("div", { class: "view" }, card(null, body)),
    sync() {
      const st = State.stats;
      const goalMin = Math.max(1, State.settings.dailyGoalMinutes);
      const mins = st?.todayMinutes ?? 0;
      const n = st?.dueToday ?? 0;
      level.value.textContent = String(Math.round(st?.level.score ?? 0));
      due.value.textContent = String(n);
      streak.value.textContent = String(st?.streak ?? 0);
      words.value.textContent = String(st?.words ?? 0);
      today.value.textContent = `${Math.round(mins)}m`;
      const done = mins >= goalMin;
      status.textContent = `${st?.level.label ?? "Absolute beginner"} · ${done ? `goal of ${goalMin} min reached` : `${Math.round(mins)} of ${goalMin} min goal`}`;
      meter.style.width = `${Math.min(100, (mins / goalMin) * 100)}%`;
      meter.classList.toggle("done", mins >= goalMin);
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(actions: ViewActions, onChatHeightChange: () => void): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("home", buildHome(actions));
  map.set("nudge", buildNudge(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange, () => actions.keepOpen()));
  map.set("lookup", buildLookup(() => actions.keepOpen(), (text) => actions.ask(`More about this text: ${text}`)));
  map.set("review", buildReview(actions));
  map.set("stats", buildStats(actions));
  map.set("study", buildStudyHost(actions));
  return map;
}
