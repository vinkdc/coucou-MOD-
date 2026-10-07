// Island entry point: boot the bridge, wire Mochi, keep today's progress in
// view, answer the hotkeys, and offer short moments at natural breaks.

// Inter, bundled (never fetched): the closest free match to Apple's SF Pro,
// whose licence keeps it on Apple platforms. Optical sizes, like SF Text/Display.
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/noto-sans-jp";
import "./style.css";
import { Bridge, IS_TAURI, onEvent, type HotkeyEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { startApprovals } from "./core/approvals";
import { State, today, type Settings } from "./core/state";
import { Island } from "./island/island";
import { askInChat } from "./views/chat";
import { REMINDER_DECLINED, REMINDER_SNOOZED } from "./views/views";
import { refreshStats } from "./core/progress";
import { decide, loadState, saveState, shown, RETURN_AFTER_MS, type Moment } from "./island/reminders";

/** How often the reminder rules look at the clock: a cheap local check, once a minute. */
const CHECK_EVERY_MS = 60_000;
/** After a break ends, the offer stays possible for this many checks (it may be mid-sentence at first). */
const RETURN_WINDOW_CHECKS = 4;

const QUIZ_PROMPT =
  "Quiz me with ONE quick question on a word I know or am learning (prefer my weak words). Ask it in the tagged format and do not give the answer. My next message is my answer.";

/** One line for the tray: today at a glance. */
function trayStatus(): string {
  const st = State.stats;
  if (!st) return "Kotoba";
  const mins = Math.round(st.todayMinutes);
  const due = st.dueToday > 0 ? ` · ${st.dueToday} due` : "";
  const streak = st.streak > 0 ? ` · ${st.streak}-day streak` : "";
  return `${mins > 0 ? `${mins} min today` : "No study yet today"}${due}${streak}`;
}

/** Opens the island on a moment: a hello, a short review, a word, or a quiz question. */
function offer(island: Island, moment: Moment) {
  Sound.play("peek");
  switch (moment) {
    case "nudge":
      island.alert("nudge");
      break;
    case "review":
      island.openReview(3, false, true);
      break;
    case "word":
      island.openReview(1, true, true);
      break;
    case "quiz":
      State.chatHistory = [];
      void Bridge.chatReset("quick");
      island.alert("prompt");
      window.setTimeout(() => askInChat(QUIZ_PROMPT), 350);
      break;
  }
}

/** The reminder loop: gathers the facts and asks the pure rules (island/reminders.ts). */
function startReminders(island: Island) {
  let prevIdle = 0;
  let afterReturn = 0;

  // The user's answer to the last offer is remembered for the rest of the day.
  window.addEventListener(REMINDER_DECLINED, () => saveState({ ...loadState(today()), declined: true }));
  window.addEventListener(REMINDER_SNOOZED, () => saveState({ ...loadState(today()), snoozed: true }));

  async function check() {
    const idle = (await Bridge.idleMs()) ?? 0;
    // A break ends when input comes back after a long pause; the offer window
    // then lasts a few checks, since the first one may find the user mid-sentence.
    if (prevIdle >= RETURN_AFTER_MS && idle < RETURN_AFTER_MS) afterReturn = RETURN_WINDOW_CHECKS;
    else if (afterReturn > 0) afterReturn--;
    const returning = afterReturn > 0;
    prevIdle = idle;

    const s = State.settings;
    if (!s.reminders || State.mode !== "hidden") return;
    const canShow = (await Bridge.canSummon()) ?? true;
    await refreshStats();
    const now = new Date();
    const st = loadState(today());
    const moment = decide(s, st, {
      now,
      idleMs: idle,
      prevIdleMs: returning ? RETURN_AFTER_MS : 0,
      canShow,
      dueCount: State.stats?.dueToday ?? 0,
      words: State.stats?.words ?? 0,
      todayMessages: State.stats?.todayMessages ?? 0,
      todayMinutes: State.stats?.todayMinutes ?? 0,
    });
    if (!moment) return;
    // Connected to Google: stay quiet during a meeting (nothing is recorded, so the offer comes later).
    if ((await Bridge.googleStatus())?.connected && (await Bridge.googleBusyNow()) === true) return;
    saveState(shown(st, moment, now));
    afterReturn = 0;
    offer(island, moment);
  }

  window.setInterval(() => void check(), CHECK_EVERY_MS);
  // Dev only: `__kotobaRemind("review")` shows a moment now, past every guard.
  if (import.meta.env.DEV) {
    (window as unknown as { __kotobaRemind: (m: Moment) => void }).__kotobaRemind = (m) => offer(island, m);
  }
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);
  const boot = await Bridge.boot();
  if (boot) State.settings = { ...State.settings, ...boot.settings };
  island.applySettings();
  if (boot && !boot.cursorPoll) island.followPageCursor();
  void refreshStats();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  await onEvent<string>("tray", (what) => {
    if (what === "toggle") {
      if (State.mode !== "hidden") island.fsm.forceHidden();
      else island.alert("prompt");
    }
  });

  // Global hotkeys. "summon" is a toggle that opens on the quick question, ready
  // to type; "lookup" carries the text selected in whatever app was in front.
  await onEvent<HotkeyEvent>("hotkey", (e) => {
    if (e.action === "lookup") {
      island.showLookup(e.text ?? "", e.error);
      return;
    }
    if (e.action === "ask") {
      island.askAbout(e.text);
      return;
    }
    if (e.action === "listen") {
      island.listenTo(e.text);
      return;
    }
    // Pressed again, it puts the island (or the study panel) away.
    if (State.mode === "expanded") {
      island.collapse();
      return;
    }
    island.alert("prompt");
  });

  // The tray, a second launch, or Home asks for the study panel.
  await onEvent<string>("study-open", (what) => island.openStudy(what));

  await onEvent<null>("screen-changed", () => void Bridge.reposition());
  await onEvent<null>("skins-changed", () => island.reloadSkin());
  await onEvent<null>("learner-changed", () => void refreshStats());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
  });

  // The tray is the ambient channel while the island is hidden. Pushed only when
  // the text actually changes, so State updates stay free.
  let lastTray = "";
  State.subscribe(() => {
    const status = trayStatus();
    const visible = State.mode !== "hidden";
    const key = `${status}|${visible}`;
    if (key === lastTray) return;
    lastTray = key;
    void Bridge.traySync(status, visible);
  });

  startReminders(island);
  // An agent asking for a decision opens the island on Today's Work page, unless it must not
  // (a meeting, a full-screen app): then the agent asks in the terminal at once.
  startApprovals(async () => {
    const ok = (await Bridge.canSummon()) ?? true;
    if (ok) island.peekAgents();
    return ok;
  });
  // Nothing left to decide: the island may close again.
  window.addEventListener("kotoba-approvals-idle", () => {
    State.isPinned = false;
    island.dropPin();
  });
  island.launch();

  // In a plain browser, unlock audio on the first click so the visuals and
  // sounds can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
