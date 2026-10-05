// The Tools tab: the cards of the user's workspace preset, side by side.

import { h } from "./dom";
import { State } from "../core/state";
import { currentPreset, type ToolId } from "../presets";
import { buildPorts } from "../tools/ports";
import { buildScripts } from "../tools/scripts";
import type { ToolCard } from "../tools/types";
import type { ViewHost } from "./views";

const BUILDERS: Record<ToolId, () => ToolCard> = {
  ports: buildPorts,
  scripts: buildScripts,
};

/** How often the cards look again while the tab is on screen. */
const REFRESH_MS = 3000;

export function buildTools(): ViewHost {
  const grid = h("div", { class: "tools-grid" });
  const el = h("div", { class: "view" }, grid);
  let cards: ToolCard[] = [];
  let builtFor = "";
  let timer: number | undefined;

  const visible = () => State.view === "tools" && State.mode === "expanded";

  function refreshAll() {
    for (const c of cards) c.refresh();
  }

  return {
    el,
    sync() {
      const preset = currentPreset();
      if (builtFor !== preset.id) {
        builtFor = preset.id;
        cards = preset.tools.map((id) => BUILDERS[id]());
        grid.replaceChildren(...cards.map((c) => c.el));
      }
      // Looks again only while this tab is the one on screen; the timer ends itself.
      if (timer === undefined && visible()) {
        refreshAll();
        timer = window.setInterval(() => {
          if (!visible()) {
            window.clearInterval(timer);
            timer = undefined;
            return;
          }
          refreshAll();
        }, REFRESH_MS);
      }
    },
  };
}
