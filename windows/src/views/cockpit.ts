// The home view's right-hand card: a developer's cockpit instead of a wall of
// dots. From the top: where you are (repo), what the AI can do about it
// (one-tap actions), and the integrations you actually configured.
//
// Swipe sideways (trackpad, wheel or touch) for more pages: the second one is
// Claude Code usage. Everything here is read from State and re-rendered only
// when what it shows changes; the only timer is the reset countdown, and it
// runs only while that page is on screen.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { ensureRepo } from "../core/repo";
import { compact, ensureUsage, summarize, until } from "../core/usage";
import { State, type AgentTask } from "../core/state";
import type { ViewActions } from "./views";
import { chipsFor } from "./actions";

/** The folder the selected Claude Code session works in, if one has reported yet. */
function sessionCwd(): string | null {
  return State.currentSession?.cwd || State.tasks.find((t) => t.id === "integration_claude")?.sessionCwd || null;
}

function sessionPids(): number[] {
  return State.currentSession?.pids ?? State.tasks.find((t) => t.id === "integration_claude")?.sessionPids ?? [];
}

function quietRow(text: string): HTMLElement {
  return h(
    "div",
    { class: "cp-row quiet" },
    svg(ICONS.branch, 12, { stroke: 2 }),
    h("span", { class: "cp-main", text }),
  );
}

function repoRow(actions: ViewActions): HTMLElement {
  const cwd = sessionCwd();
  if (!cwd) return quietRow("No session yet");
  const repo = State.repos[cwd];
  if (!repo) return quietRow("Reading repo…");
  if (!repo.isRepo) return quietRow("Not a git repository");

  const dirty = repo.changed > 0;
  const meta: string[] = [];
  if (dirty) meta.push(`${repo.changed} changed`);
  if (repo.ahead) meta.push(`↑${repo.ahead}`);
  if (repo.behind) meta.push(`↓${repo.behind}`);
  if (!dirty && !repo.ahead && !repo.behind) meta.push("clean");

  const row = h(
    "div",
    { class: dirty || repo.behind > 0 ? "cp-row warn" : "cp-row", title: repo.lastCommit ? `Last commit: ${repo.lastCommit}` : "" },
    svg(ICONS.branch, 12, { stroke: 2 }),
    h("span", { class: "cp-main", text: repo.branch }),
    h("span", { class: "cp-meta", text: meta.join(" · ") }),
  );
  // Back to the terminal this session runs in.
  row.onclick = () => {
    actions.focusSession(sessionPids(), cwd);
  };
  return row;
}

const STATE_COLOR = { working: "#34d399", idle: "#6b7079", approval: "#f5a524", error: "#f4505e" } as const;

function minutes(since: number): string {
  const m = Math.floor((Date.now() - since) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

/** One chip per live session; shown only when there is more than one to choose between. */
function sessionsRow(actions: ViewActions): HTMLElement | null {
  const live = State.liveSessions;
  if (live.length < 2) return null;
  const current = State.currentSession?.id;
  const row = h("div", { class: "cp-sessions" });
  for (const x of live.slice(0, 3)) {
    const chip = h(
      "button",
      {
        class: x.id === current ? "cp-ses on" : "cp-ses",
        title: `${x.project} · ${minutes(x.startedAt)}${x.step ? ` · ${x.step}` : ""}`,
        onclick: () => {
          // First tap selects the session; tapping the selected one jumps to its terminal.
          if (x.id === current) actions.focusSession(x.pids, x.cwd);
          else {
            State.activeSessionId = x.id;
            State.notify();
          }
        },
      },
      dot(STATE_COLOR[x.state], 6),
      h("span", { class: "cp-ses-name", text: x.project }),
    );
    row.append(chip);
  }
  return row;
}

/**
 * What is waiting on you on GitHub, and whether the session's branch passes CI.
 * Only shown when the GitHub integration has answered with something to say.
 */
function githubRow(actions: ViewActions): HTMLElement | null {
  const info = State.integrations["integration_github"];
  if (!info?.loaded || info.error) return null;
  const d = info.data as {
    prsToReview?: number;
    myPrs?: number;
    ci?: "success" | "pending" | "failure" | "none";
    ciUrl?: string;
    reviewPr?: { number?: number; title?: string; url?: string };
  };

  const toReview = d.prsToReview ?? 0;
  const ci = d.ci && d.ci !== "none" ? d.ci : null;
  if (!toReview && !ci && !(d.myPrs ?? 0)) return null;

  const parts: string[] = [];
  if (toReview) parts.push(`${toReview} to review`);
  else if (d.myPrs) parts.push(`${d.myPrs} open PR${d.myPrs === 1 ? "" : "s"}`);

  const ciText = ci === "failure" ? "CI failing" : ci === "pending" ? "CI running" : ci === "success" ? "CI passing" : "";
  const row = h("div", { class: ci === "failure" ? "cp-row bad" : "cp-row" });
  row.append(
    h("i", { class: `cp-state ${ci ?? "idle"}` }),
    h("span", { class: "cp-main", text: parts.join(" · ") || "No PRs" }),
    h("span", { class: "cp-meta", text: ciText }),
  );
  row.title = d.reviewPr?.title ? `#${d.reviewPr.number}: ${d.reviewPr.title}` : "";
  // A failing check is what you want to see; otherwise the PR that needs you.
  row.onclick = () => {
    const url = ci === "failure" ? d.ciUrl : (toReview ? d.reviewPr?.url : d.ciUrl) ?? d.ciUrl;
    if (url) actions.openUrl(url);
  };
  return row;
}

function chipRow(actions: ViewActions): HTMLElement | null {
  const cwd = sessionCwd();
  const repo = cwd ? State.repos[cwd] : undefined;
  if (!cwd || !repo?.isRepo) return null;
  const row = h("div", { class: "cp-chips" });
  for (const chip of chipsFor(repo, cwd)) {
    row.append(
      h("button", { class: "cp-chip", title: chip.hint, text: chip.label, onclick: () => actions.ask(chip.prompt) }),
    );
  }
  return row;
}

/** Integrations the user has set up, as one compact line of chips. */
function strip(actions: ViewActions): HTMLElement | null {
  const others: AgentTask[] = State.otherTasks.slice(0, 4);
  if (!others.length) return null;
  const row = h("div", { class: "cp-strip" });
  for (const t of others) {
    const label = t.id === "integration_claude" && !t.sessionCwd ? State.ideLabel : t.name;
    const chip = h(
      "button",
      { class: "cp-int", title: label, onclick: () => actions.setFocus(t.id) },
      dot(t.color, 6),
      h("span", { text: label }),
    );
    if (t.pillBadge) {
      const colors = { approval: "#f5a524", finished: "#22c55e", error: "#f4505e" } as const;
      chip.append(h("i", { class: "cp-flag", style: `background:${colors[t.pillBadge]}` }));
    }
    row.append(chip);
  }
  return row;
}

/** Claude Code usage: the 5-hour window in progress, then the last seven days. */
function usagePage(page: HTMLElement) {
  const u = State.usage;
  if (!u) {
    page.append(quietRow("Reading usage…"));
    return;
  }
  if (!u.found) {
    page.append(quietRow("No Claude Code history yet"));
    return;
  }
  const sum = summarize(u.hours);
  const w = sum.window;

  const head = h(
    "div",
    { class: w ? "cp-row" : "cp-row quiet" },
    svg(ICONS.timer, 12),
    h("span", { class: "cp-main", text: w ? "5-hour window" : "No active window" }),
  );
  if (w) {
    const at = new Date(w.end * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    head.append(h("span", { class: "cp-meta", text: `resets in ${until(w.end)}` }));
    head.title = `Resets at ${at}`;
  }
  page.append(head);

  if (w) {
    // Anthropic doesn't publish the limit, so the bar is sized against your own
    // busiest window this week: full means "as much as you've ever done".
    const ratio = sum.peak > 0 ? Math.min(1, w.tokens / sum.peak) : 0;
    const meter = h("div", { class: "cp-meter" }, h("i", { style: `width:${(ratio * 100).toFixed(1)}%` }));
    if (ratio >= 0.9) meter.classList.add("hot");
    page.append(
      meter,
      h(
        "div",
        { class: "cp-legend" },
        h("span", { text: `${compact(w.tokens)} tokens · ${w.messages} msg${w.messages === 1 ? "" : "s"}` }),
        h("span", { text: sum.peak > 0 ? `peak ${compact(sum.peak)}` : "first window" }),
      ),
    );
  }

  const max = Math.max(1, ...sum.days);
  const bars = h("div", { class: "cp-days", title: "Tokens per day, last 7 days" });
  sum.days.forEach((n, i) => {
    const bar = h("i", { style: `height:${Math.max(n ? 12 : 4, (n / max) * 100).toFixed(0)}%` });
    if (i === 6) bar.classList.add("today");
    bars.append(bar);
  });
  page.append(
    h(
      "div",
      { class: "cp-row cp-week" },
      bars,
      h("span", { class: "cp-main", text: `Today ${compact(sum.today)}` }),
      h("span", { class: "cp-meta", text: `7 days ${compact(sum.week)}` }),
    ),
  );
}

export interface Cockpit {
  el: HTMLElement;
  sync(): void;
}

const PAGES = 2;
const PAGE_KEY = "coucou.cockpitPage";

function savedPage(): number {
  try {
    const n = Number(localStorage.getItem(PAGE_KEY));
    return Number.isInteger(n) && n >= 0 && n < PAGES ? n : 0;
  } catch {
    return 0;
  }
}

export function buildCockpit(actions: ViewActions): Cockpit {
  const repoPage = h("div", { class: "cockpit" });
  const usage = h("div", { class: "cockpit" });
  const track = h("div", { class: "cp-track" }, repoPage, usage);
  const dots = h("div", { class: "cp-dots" });
  const el = h("div", { class: "cp-pager" }, track, dots);
  let key = "";
  let usageKey = "";
  let page = savedPage();
  let tick: number | null = null;

  const titles = ["Repo", "Usage"];
  const dotEls = titles.map((t, i) =>
    h("button", { class: "cp-dot", title: t, onclick: () => go(i) }),
  );
  dots.append(...dotEls);

  function place() {
    track.style.transform = `translateX(${-page * 100}%)`;
    dotEls.forEach((d, i) => d.classList.toggle("on", i === page));
  }

  function go(next: number) {
    next = Math.max(0, Math.min(PAGES - 1, next));
    if (next === page) return;
    page = next;
    try {
      localStorage.setItem(PAGE_KEY, String(page));
    } catch {
      /* per-viewer convenience only */
    }
    place();
    cockpit.sync();
  }

  // One page per gesture: a trackpad flick sends a long tail of wheel events,
  // so after a turn the rest of that gesture is swallowed.
  let acc = 0;
  let locked = false;
  let quiet: number | null = null;
  el.addEventListener(
    "wheel",
    (e) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      if (quiet != null) window.clearTimeout(quiet);
      quiet = window.setTimeout(() => {
        acc = 0;
        locked = false;
      }, 180);
      if (locked) return;
      acc += d;
      if (Math.abs(acc) > 40) {
        go(page + Math.sign(acc));
        locked = true;
        acc = 0;
      }
    },
    { passive: false },
  );

  // Touch screens: a horizontal drag.
  let downX: number | null = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") downX = e.clientX;
  });
  el.addEventListener("pointerup", (e) => {
    if (downX == null) return;
    const dx = e.clientX - downX;
    downX = null;
    if (Math.abs(dx) > 40) go(page - Math.sign(dx));
  });

  function syncRepo() {
    const cwd = sessionCwd();
    // Opening the island on an old answer refreshes it; a fresh one is left alone.
    if (State.mode === "expanded") ensureRepo(cwd);

    const repo = cwd ? State.repos[cwd] : undefined;
    const others = State.otherTasks.slice(0, 4).map((t) => `${t.id}:${t.pillBadge ?? ""}`).join("|");
    const gh = State.integrations["integration_github"];
    const ses = State.liveSessions.slice(0, 3).map((x) => `${x.id}:${x.state}:${x.project}`).join("|") + State.currentSession?.id;
    const next = [cwd, ses, JSON.stringify(repo ?? null), others, gh?.loaded, gh?.error, JSON.stringify(gh?.data ?? null)].join("~");
    if (next === key) return;
    key = next;

    clear(repoPage);
    const sessions = sessionsRow(actions);
    if (sessions) repoPage.append(sessions);
    repoPage.append(repoRow(actions));
    const github = githubRow(actions);
    if (github) repoPage.append(github);
    const chips = chipRow(actions);
    if (chips) repoPage.append(chips);
    const ints = strip(actions);
    if (ints) repoPage.append(ints);
  }

  function syncUsage() {
    const showing = page === 1 && State.mode === "expanded";
    if (showing) ensureUsage();
    // The countdown moves on its own; nothing else needs a clock.
    if (showing && tick == null) tick = window.setInterval(() => cockpit.sync(), 30_000);
    if (!showing && tick != null) {
      window.clearInterval(tick);
      tick = null;
    }
    const minute = Math.floor(Date.now() / 60_000);
    const next = `${State.usage?.hours.length}:${JSON.stringify(State.usage?.hours.at(-1) ?? null)}:${minute}`;
    if (next === usageKey) return;
    usageKey = next;
    clear(usage);
    usagePage(usage);
  }

  const cockpit: Cockpit = {
    el,
    sync() {
      syncRepo();
      syncUsage();
    },
  };
  place();
  return cockpit;
}
