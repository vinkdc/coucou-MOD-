// Keeps State.usage fresh while the cockpit's Usage page is on screen, and
// works out the numbers that page shows. Never polls: the page asks when it is
// shown, and again on events once the answer is old.

import { Bridge, type UsageHour } from "./bridge";
import { State } from "./state";

const STALE_MS = 30_000;
const HOUR = 3600;
const WINDOW = 5 * HOUR;

let fetchedAt = 0;
let inFlight = false;

export function ensureUsage() {
  if (inFlight || Date.now() - fetchedAt < STALE_MS) return;
  inFlight = true;
  void Bridge.claudeUsage()
    .then((u) => {
      fetchedAt = Date.now();
      if (u) {
        State.usage = u;
        State.notify();
      }
    })
    .finally(() => {
      inFlight = false;
    });
}

/** Tokens that count against a limit: cache reads are cheap and would drown the rest. */
export function weight(x: UsageHour): number {
  return x.input + x.output + x.cacheWrite;
}

export interface UsageSummary {
  /** The 5-hour window in progress, if any (epoch seconds). */
  window: { start: number; end: number; tokens: number; messages: number } | null;
  /** The busiest finished window this week, to size the bar against. */
  peak: number;
  today: number;
  week: number;
  /** Tokens per local day, oldest first, today last (7 entries). */
  days: number[];
}

/**
 * Claude's limit windows last five hours and start on the hour of the first
 * message sent after the previous window ended.
 */
export function summarize(hours: UsageHour[], nowMs = Date.now()): UsageSummary {
  const now = nowMs / 1000;
  const windows: { start: number; end: number; tokens: number; messages: number }[] = [];
  for (const x of hours) {
    let w = windows[windows.length - 1];
    if (!w || x.hour >= w.end) {
      w = { start: x.hour, end: x.hour + WINDOW, tokens: 0, messages: 0 };
      windows.push(w);
    }
    w.tokens += weight(x);
    w.messages += x.messages;
  }
  const last = windows[windows.length - 1];
  const window = last && last.end > now ? last : null;
  const peak = Math.max(0, ...windows.filter((w) => w !== window).map((w) => w.tokens));

  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const days = new Array(7).fill(0);
  let week = 0;
  for (const x of hours) {
    const t = x.hour * 1000;
    // Rounded: a day across a clock change is 23 or 25 hours long.
    const ago = Math.round((midnight.getTime() - new Date(t).setHours(0, 0, 0, 0)) / 86_400_000);
    if (ago >= 0 && ago < 7) days[6 - ago] += weight(x);
    if (nowMs - t < 7 * 86_400_000) week += weight(x);
  }
  return { window, peak, today: days[6], week, days };
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

export function until(endSec: number, nowMs = Date.now()): string {
  const m = Math.max(0, Math.ceil((endSec * 1000 - nowMs) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
