// The full progress view of the island: all stats and charts in a large panel.
// The island grows to fit it and stays open until it is closed.

import { h } from "./dom";
import { State } from "../core/state";
import { buildStudyApp } from "../study/app";
import type { ViewActions, ViewHost } from "./views";

export function buildStudyHost(actions: ViewActions): ViewHost {
  // The app reads State through getters, so it always sees the latest.
  const ctx = {
    get settings() {
      return State.settings;
    },
    get stats() {
      return State.stats;
    },
  };
  const app = buildStudyApp(ctx, (text) => actions.ask(text));
  const el = h("div", { class: "view study-view" }, h("div", { class: "card" }, app.el));

  // Redrawn only when the stats object was replaced.
  let seenStats: unknown;

  return {
    el,
    sync() {
      if (State.stats === seenStats) return;
      seenStats = State.stats;
      app.refresh();
    },
  };
}
