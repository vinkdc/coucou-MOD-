// Reminders: when Mochi may offer a short moment (a review, a word, a question)
// instead of waiting to be opened. The rules are a pure function so the guards
// can be tested; the runtime below only gathers the facts once a minute.
//
// The point is natural breaks, not pressure: after the user comes back from a
// pause, never while typing or in a full-screen app, never in quiet hours,
// never more than a few a day, and never the same kind twice in a row once it
// was waved away.

export type Moment = "nudge" | "review" | "quiz" | "word";

export interface ReminderSettings {
  reminders: boolean;
  reminderMaxPerDay: number;
  quietStart: string;
  quietEnd: string;
  reminderReview: boolean;
  reminderWord: boolean;
  reminderQuiz: boolean;
  dailyGoalMinutes: number;
}

/** What is remembered between checks (per day), kept in localStorage. */
export interface ReminderState {
  date: string;
  shown: number;
  /** ms since epoch. */
  lastAt: number;
  lastType: Moment | null;
  /** The last moment was waved away ("Later"). */
  declined: boolean;
  snoozed: boolean;
}

export interface Facts {
  now: Date;
  /** Idle time right now, and at the previous check. */
  idleMs: number;
  prevIdleMs: number;
  /** The island is hidden and nothing full-screen is up. */
  canShow: boolean;
  dueCount: number;
  words: number;
  todayMessages: number;
  todayMinutes: number;
}

/** A pause this long, then input again, is a natural break to speak up after. */
export const RETURN_AFTER_MS = 10 * 60_000;
/** Back at the keyboard, but not so recently that it is mid-sentence. */
export const SETTLED_MS = 5_000;
export const MIN_GAP_MS = 90 * 60_000;
/** A big backlog is worth a mention even without a break. */
export const BACKLOG = 10;

export function emptyState(date: string): ReminderState {
  return { date, shown: 0, lastAt: 0, lastType: null, declined: false, snoozed: false };
}

const minutes = (hhmm: string, fallback: number): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return fallback;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
};

/** Quiet hours may span midnight (22:00 → 08:00). Equal times mean no quiet hours. */
export function inQuietHours(now: Date, start: string, end: string): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const a = minutes(start, 22 * 60);
  const b = minutes(end, 8 * 60);
  if (a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** Which moment to offer next, or null to stay quiet. */
export function decide(s: ReminderSettings, st: ReminderState, f: Facts): Moment | null {
  if (!s.reminders || st.snoozed || !f.canShow) return null;
  if (st.shown >= s.reminderMaxPerDay) return null;
  if (f.now.getTime() - st.lastAt < MIN_GAP_MS) return null;
  if (inQuietHours(f.now, s.quietStart, s.quietEnd)) return null;
  if (f.idleMs < SETTLED_MS) return null;

  const returned = f.prevIdleMs >= RETURN_AFTER_MS && f.idleMs < RETURN_AFTER_MS;
  const firstOfDay = st.shown === 0 && f.todayMessages === 0 && f.todayMinutes === 0 && f.now.getHours() >= 9;
  const backlog = f.dueCount >= BACKLOG;
  if (!returned && !firstOfDay && !backlog) return null;

  // First thing: a gentle hello, once a day, before anything that asks for work.
  if (firstOfDay) return "nudge";

  const options: Moment[] = [];
  if (s.reminderReview && f.dueCount > 0) options.push("review");
  if (s.reminderQuiz && f.words >= 3) options.push("quiz");
  if (s.reminderWord && f.words > 0) options.push("word");
  if (options.length === 0) return null;
  // Waved away once: try something else, never the same thing straight after.
  const fresh = st.declined ? options.filter((o) => o !== st.lastType) : options;
  const pool = fresh.length ? fresh : options;
  // A backlog beats rotation.
  if (backlog && pool.includes("review")) return "review";
  // Otherwise rotate through what is on offer.
  const at = st.lastType ? (pool.indexOf(st.lastType) + 1) % pool.length : 0;
  return pool[at < 0 ? 0 : at];
}

/** The state after offering `moment` at `now`. */
export function shown(st: ReminderState, moment: Moment, now: Date): ReminderState {
  return { ...st, shown: st.shown + 1, lastAt: now.getTime(), lastType: moment, declined: false };
}

// ── Runtime ───────────────────────────────────────────────────────────────────

const KEY = "kotoba.reminders";

export function loadState(date: string): ReminderState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as ReminderState | null;
    if (raw && raw.date === date) return { ...emptyState(date), ...raw };
  } catch {
    // Unreadable or blocked storage: start the day fresh.
  }
  return emptyState(date);
}

export function saveState(st: ReminderState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {
    // Without storage the limits only hold for this session; harmless.
  }
}
