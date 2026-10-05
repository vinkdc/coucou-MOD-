// The full progress view: every stat, chart and list. It is a view of the island
// (views/study.ts), which grows into a large panel for it.

import "./study.css";
import { h } from "../views/dom";
import type { Stats } from "../core/bridge";
import type { Settings } from "../core/state";
import { buildStats } from "./stats";

export interface StudyContext {
  readonly settings: Settings;
  readonly stats: Stats | null;
}

export function buildStudyApp(ctx: StudyContext, practise: (text: string) => void) {
  const stats = buildStats(ctx, practise);
  const el = h("div", { class: "study-embed" }, stats.el);
  return { el, refresh: stats.refresh };
}
