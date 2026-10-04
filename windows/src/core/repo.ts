// Keeps State.repos fresh without ever polling: a folder's git status is
// fetched when a session first reports it, after a burst of tool activity has
// settled, and when the island opens on a stale answer.

import { Bridge } from "./bridge";
import { State } from "./state";

/** After this long an open island refreshes the answer it is showing. */
const STALE_MS = 15_000;
/** Tool events come in bursts; ask once the burst has gone quiet. */
const QUIET_MS = 1_500;

const fetchedAt = new Map<string, number>();
const inFlight = new Set<string>();
let timer: number | null = null;
/** "owner/repo@branch" the GitHub poll was last pointed at. */
let lastWatched = "";

async function load(cwd: string) {
  if (inFlight.has(cwd)) return;
  inFlight.add(cwd);
  try {
    const status = await Bridge.repoStatus(cwd);
    fetchedAt.set(cwd, Date.now());
    if (status) {
      State.repos[cwd] = status;
      State.notify();
      // A different repo or branch has a different CI result: don't wait for the
      // next scheduled GitHub poll to find out what it is.
      const watching = status.isRepo && status.github && !status.detached ? `${status.github}@${status.branch}` : null;
      if (watching && watching !== lastWatched) {
        lastWatched = watching;
        void Bridge.refreshIntegration("integration_github");
      }
    }
  } finally {
    inFlight.delete(cwd);
  }
}

/** Fetches `cwd` if it was never fetched or the answer is old. */
export function ensureRepo(cwd: string | null | undefined) {
  if (!cwd) return;
  const at = fetchedAt.get(cwd);
  if (at === undefined || Date.now() - at > STALE_MS) void load(cwd);
}

/** Something happened in `cwd` that may have changed the tree: ask once things calm down. */
export function repoMayHaveChanged(cwd: string | null | undefined) {
  if (!cwd) return;
  if (timer != null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void load(cwd);
  }, QUIET_MS);
}
