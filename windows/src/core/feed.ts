// What is happening, for the Today tab: the track playing, new uploads from the
// channels the learner follows, and their next events and tasks. Each source is
// opt-in (connected from the Today tab or Settings); nothing is fetched for one
// that is not connected. Only titles are read, and a title goes to the AI only
// when the learner presses that row.

import { Bridge, IS_TAURI, type GoogleItem, type SpotifyTrack, type YoutubeUpload } from "./bridge";
import { State, today } from "./state";
import { hasUnread, markAllSeen, record } from "./notifications";

export interface FeedState {
  /** Connections that can be offered (the app ships a client for them) and their state. */
  google: { configured: boolean; connected: boolean };
  spotify: { configured: boolean; connected: boolean };
  agenda: GoogleItem[];
  uploads: YoutubeUpload[];
  track: SpotifyTrack | null;
}

export const Feed: FeedState = {
  google: { configured: false, connected: false },
  spotify: { configured: false, connected: false },
  agenda: [],
  uploads: [],
  track: null,
};

/** The learner looked at Today: whatever arrived is no longer new. */
export function markSeen() {
  markAllSeen();
  if (State.feedFresh) {
    State.feedFresh = false;
    State.notify();
  }
}

/** New uploads and study alerts become notices (kept for a while, so they can be scrolled back to). */
function recordNotices() {
  const day = today();
  const recent = Date.now() - 3 * 86_400_000;
  for (const u of Feed.uploads.slice(0, 5)) {
    const at = Date.parse(u.published);
    if (Number.isFinite(at) && at >= recent) {
      record({ id: `yt:${u.id}`, kind: "upload", title: u.title, detail: `New video · ${u.channel}`, url: u.url }, at);
    }
  }
  const due = State.stats?.dueToday ?? 0;
  if (due > 0) record({ id: `due:${day}`, kind: "study", title: `${due} card${due === 1 ? "" : "s"} due for review`, detail: "A two-minute review keeps them fresh" });
  const streak = State.stats?.streak ?? 0;
  if (streak > 0 && (State.stats?.todayMinutes ?? 0) < 1 && new Date().getHours() >= 18) {
    record({ id: `streak:${day}`, kind: "streak", title: `Your ${streak}-day streak is at risk`, detail: "A short chat today keeps it alive" });
  }
  State.feedFresh = hasUnread();
}

/** Rows the feed will show, newest and most useful first. */
export interface Row {
  key: string;
  kind: "track" | "upload" | "event" | "task";
  title: string;
  detail: string;
  /** Text sent to Mochi when the learner presses the row's phrase button; null = no button. */
  ask: string | null;
  url: string | null;
}

function clock(item: GoogleItem): string {
  if (item.kind === "event" && !item.allDay && item.when) {
    const t = new Date(item.when);
    if (!Number.isNaN(t.getTime())) {
      const day = t.toDateString() === new Date().toDateString() ? "" : `${t.toLocaleDateString([], { weekday: "short" })} `;
      return `${day}${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    }
  }
  return item.kind === "task" ? "Task" : "All day";
}

/** The same event on two calendars (or typed in capitals) is one event. */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * At most three tiles, one per source, most useful first: the song playing now, the next
 * timed event, the newest upload (a channel with several new videos is one tile). A task
 * only fills a free place.
 */
export function rows(max = 3): Row[] {
  const out: Row[] = [];
  const t = Feed.track;
  if (t && t.playing) {
    out.push({
      key: `track:${t.id}`,
      kind: "track",
      title: t.title,
      detail: ["Now playing", t.app, t.artist].filter(Boolean).join(" · "),
      ask: `I'm listening to "${t.title}" by ${t.artist}. Teach me two useful Japanese words or phrases connected to this song's title or theme.`,
      url: null,
    });
  }
  const seenTitles = new Set<string>();
  const timed = Feed.agenda.filter((i) => i.kind === "event" && !i.allDay).filter((i) => !seenTitles.has(norm(i.title)) && !!seenTitles.add(norm(i.title)));
  const next = timed[0];
  if (next) {
    out.push({ key: next.id, kind: "event", title: next.title, detail: clock(next), ask: `How do I say "${next.title}" in Japanese? Give one short, natural phrase I could use today.`, url: null });
  }
  const newest = Feed.uploads[0];
  if (newest) {
    const same = Feed.uploads.filter((u) => u.channel === newest.channel);
    out.push({
      key: `yt:${newest.id}:${same.length}`,
      kind: "upload",
      title: same.length > 1 ? `${newest.channel} · ${same.length} new videos` : newest.title,
      detail: same.length > 1 ? newest.title : newest.channel,
      ask: null,
      url: newest.url,
    });
  }
  const task = Feed.agenda.find((i) => i.kind === "task");
  if (task && out.length < max) {
    out.push({ key: task.id, kind: "task", title: task.title, detail: "Task", ask: `How do I say "${task.title}" in Japanese? Give one short, natural phrase I could use today.`, url: null });
  }
  return out.slice(0, max);
}

// ── Polling ───────────────────────────────────────────────────────────────────

let started = false;

async function refreshStatus() {
  Feed.google = (await Bridge.googleStatus()) ?? Feed.google;
  Feed.spotify = (await Bridge.spotifyStatus()) ?? Feed.spotify;
}

async function refreshAgenda() {
  if (!Feed.google.connected) return void (Feed.agenda = []);
  try {
    Feed.agenda = await Bridge.googleAgenda();
  } catch {
    /* kept as it was: the next round tries again */
  }
}

async function refreshUploads() {
  if (!Feed.google.connected) return void (Feed.uploads = []);
  try {
    Feed.uploads = await Bridge.googleUploads();
  } catch {
    /* an older Google sign-in lacks the YouTube permission until it is reconnected */
  }
}

/** Friendly name of a player from its Windows app id. */
function playerName(app: string): string {
  const a = app.toLowerCase();
  if (a.includes("spotify")) return "Spotify";
  if (/(chrome|brave|msedge|edge|firefox|opera|vivaldi|arc)/.test(a)) return "Browser";
  if (a.includes("music") || a.includes("itunes")) return "Music";
  return app.replace(/.exe$/i, "").split("!").pop() || "Player";
}

/** What is playing: Windows' media controls first (any player, no account), else the Spotify account. */
async function refreshTrack() {
  const local = await Bridge.mediaNow();
  if (local && local.title && local.playing) {
    Feed.track = { id: `${local.app}:${local.title}:${local.artist}`, title: local.title, artist: local.artist, playing: true, app: playerName(local.app) };
    return;
  }
  if (!Feed.spotify.connected) return void (Feed.track = null);
  try {
    Feed.track = await Bridge.spotifyNow();
  } catch {
    Feed.track = null;
  }
}

function todayShown(): boolean {
  return State.mode === "expanded" && State.view === "home";
}

/** Reads every connected source now (when the Today tab opens, or after connecting). */
export async function refreshAll() {
  await refreshStatus();
  await Promise.all([refreshAgenda(), refreshUploads(), refreshTrack()]);
  recordNotices();
  State.notify();
}

export function startFeed() {
  if (started) return;
  started = true;
  if (!IS_TAURI) return;
  void refreshAll();
  // The calendar and uploads change slowly; the song changes often but only matters while Today is on screen.
  window.setInterval(() => void refreshAgenda().then(() => State.notify()), 5 * 60_000);
  window.setInterval(() => void refreshUploads().then(() => { recordNotices(); State.notify(); }), 15 * 60_000);
  // Study alerts come from local stats, so they need no sign-in.
  window.setInterval(() => { recordNotices(); State.notify(); }, 10 * 60_000);
  window.setInterval(() => {
    if (todayShown()) void refreshTrack().then(() => State.notify());
  }, 15_000);
}
