// A short memory of what Mochi has told the learner: a new upload, cards due, a streak
// at risk. Kept on this PC (the page's local storage), newest first, last 30. The Today
// tab's Notifications page shows them, and a dot says when one has not been looked at.

export interface Notice {
  id: string;
  kind: "upload" | "study" | "streak" | "event" | "agent";
  title: string;
  detail: string;
  /** Epoch ms. */
  at: number;
  /** Opens in the browser when pressed. */
  url?: string;
  /** Sent to Mochi when pressed. */
  ask?: string;
}

const KEY = "kotoba.notices";
const SEEN = "kotoba.notices.seen";
const MAX = 30;

function read(): Notice[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? (v as Notice[]) : [];
  } catch {
    return [];
  }
}

export function history(): Notice[] {
  return read().sort((a, b) => b.at - a.at);
}

/** Adds a notice unless one with the same id exists. True when it is new. */
export function record(n: Omit<Notice, "at">, at = Date.now()): boolean {
  const all = read();
  if (all.some((x) => x.id === n.id)) return false;
  all.push({ ...n, at });
  try {
    localStorage.setItem(KEY, JSON.stringify(all.sort((a, b) => b.at - a.at).slice(0, MAX)));
  } catch {
    /* storage can be unavailable: the notice is simply not kept */
  }
  return true;
}

function lastSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Something arrived since the learner last looked. */
export function hasUnread(): boolean {
  const seen = lastSeen();
  return read().some((n) => n.at > seen);
}

export function markAllSeen() {
  try {
    localStorage.setItem(SEEN, String(Date.now()));
  } catch {
    /* the dot just stays */
  }
}

/** "5 min ago", "yesterday". */
export function ago(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
