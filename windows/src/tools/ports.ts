// Ports: what is listening on this machine, with Open and Kill. Development
// servers come first; Windows' own services never appear (devtools.rs).

import { h, clear } from "../views/dom";
import { Bridge, IS_TAURI, type ListeningPort } from "../core/bridge";
import type { ToolCard } from "./types";

/** A Kill button asks twice: the first click arms it for this long. */
const ARM_MS = 3000;

export function buildPorts(): ToolCard {
  const count = h("span", { class: "tl-count" });
  const note = h("div", { class: "tl-note" });
  const list = h("div", { class: "tl-list" });
  const el = h(
    "div",
    { class: "card tl-card" },
    h("div", { class: "tl-head" }, h("span", { class: "tl-title", text: "Ports" }), count),
    note,
    list,
  );

  let ports: ListeningPort[] = [];
  let loaded = false;
  let shownKey = "";
  let noteTimer: number | undefined;
  const armed = new Map<number, number>();

  function say(text: string) {
    note.textContent = text;
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => (note.textContent = ""), 4000);
  }

  function render() {
    const key = `${loaded}|${ports.map((p) => `${p.port}:${p.pid}`).join(",")}|${[...armed.keys()].join(",")}`;
    if (key === shownKey) return;
    shownKey = key;
    count.textContent = ports.length ? String(ports.length) : "";
    clear(list);
    if (!IS_TAURI) {
      list.append(h("div", { class: "tl-empty", text: "Ports show up in the app." }));
      return;
    }
    if (!ports.length) {
      list.append(h("div", { class: "tl-empty", text: loaded ? "No servers running." : "Looking…" }));
      return;
    }
    for (const p of ports) {
      const isArmed = armed.has(p.pid);
      list.append(
        h(
          "div",
          { class: "tl-row" },
          h("span", { class: "tl-port", text: `:${p.port}` }),
          h("span", { class: p.dev ? "tl-name dev" : "tl-name", text: p.process }),
          h("button", { class: "tl-btn", text: "Open", onclick: () => Bridge.openUrl(`http://localhost:${p.port}`) }),
          h("button", {
            class: isArmed ? "tl-btn danger armed" : "tl-btn danger",
            text: isArmed ? "Kill?" : "Kill",
            onclick: () => (isArmed ? kill(p) : arm(p)),
          }),
        ),
      );
    }
  }

  function arm(p: ListeningPort) {
    armed.set(p.pid, window.setTimeout(() => { armed.delete(p.pid); render(); }, ARM_MS));
    render();
  }

  function kill(p: ListeningPort) {
    window.clearTimeout(armed.get(p.pid));
    armed.delete(p.pid);
    Bridge.killPortProcess(p.pid)
      .catch((e) => say(String(e)))
      .finally(() => void refresh());
    render();
  }

  async function refresh() {
    const next = await Bridge.listeningPorts();
    if (next) ports = next;
    loaded = true;
    render();
  }

  render();
  return { el, refresh: () => void refresh() };
}
