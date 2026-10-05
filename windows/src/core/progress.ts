// Today's progress: asks Rust for the learner's stats and keeps them in State,
// where the island's Home, the tray line and the study view all read them.

import { Bridge } from "./bridge";
import { State, today } from "./state";

export async function refreshStats(): Promise<void> {
  const s = await Bridge.learnerStats(today());
  if (s) {
    State.stats = s;
    State.notify();
  }
}
