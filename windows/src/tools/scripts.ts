// Scripts: what a project defines (package.json, Cargo.toml, Makefile) and a
// Run button that opens a visible terminal. The command line is rebuilt in
// Rust from the project's own files; nothing typed here reaches a shell.

import { h, clear } from "../views/dom";
import { Bridge, IS_TAURI, type ProjectScript } from "../core/bridge";
import { State } from "../core/state";
import type { ToolCard } from "./types";

const ARM_MS = 3000;
const REFETCH_MS = 5000;
/** Scripts that ship or publish something ask twice, like Kill. */
const RISKY = /deploy|publish|release/i;

const baseName = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;

/** Pinned folders first, then the folders sessions work in; each once. */
function projects(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const key = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  for (const dir of [...State.settings.projects, ...Object.values(State.sessions).map((s) => s.cwd)]) {
    if (!dir || seen.has(key(dir))) continue;
    seen.add(key(dir));
    out.push(dir);
  }
  return out;
}

export function buildScripts(): ToolCard {
  const note = h("div", { class: "tl-note" });
  const chips = h("div", { class: "tl-chips" });
  const list = h("div", { class: "tl-list" });
  const el = h(
    "div",
    { class: "card tl-card" },
    h("div", { class: "tl-head" }, h("span", { class: "tl-title", text: "Scripts" })),
    note,
    chips,
    list,
  );

  let active: string | null = null;
  let scripts: ProjectScript[] = [];
  let fetchedAt = 0;
  let fetchedFor = "";
  let chipsKey = "";
  let listKey = "";
  let noteTimer: number | undefined;
  let armedKey: string | null = null;
  let armTimer: number | undefined;

  function say(text: string) {
    note.textContent = text;
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => (note.textContent = ""), 4000);
  }

  function renderChips(all: string[]) {
    const key = `${all.join("|")}#${active}#${State.settings.projects.join("|")}`;
    if (key === chipsKey) return;
    chipsKey = key;
    clear(chips);
    for (const dir of all) {
      const pinned = State.settings.projects.includes(dir);
      chips.append(
        h(
          "div",
          { class: dir === active ? "tl-chip on" : "tl-chip", title: dir },
          h("button", { class: "tl-chip-main", text: baseName(dir), onclick: () => select(dir) }),
          pinned ? h("button", { class: "tl-chip-x", title: "Unpin", text: "×", onclick: () => unpin(dir) }) : null,
        ),
      );
    }
    chips.append(h("button", { class: "tl-chip add", title: "Add a project folder", text: "+", onclick: () => void add() }));
  }

  function renderList() {
    const key = `${active}|${scripts.map((s) => s.cmd).join(",")}|${armedKey}|${fetchedFor}`;
    if (key === listKey) return;
    listKey = key;
    clear(list);
    if (!IS_TAURI) {
      list.append(h("div", { class: "tl-empty", text: "Scripts show up in the app." }));
    } else if (!active) {
      list.append(h("div", { class: "tl-empty", text: "Add a project folder with +." }));
    } else if (!scripts.length) {
      list.append(h("div", { class: "tl-empty", text: "No scripts in this folder." }));
    }
    for (const s of scripts) {
      const id = `${s.kind}:${s.name}`;
      const isArmed = armedKey === id;
      list.append(
        h(
          "div",
          { class: "tl-row" },
          h("span", { class: "tl-name script", text: s.name }),
          h("span", { class: "tl-kind", text: s.kind }),
          h("button", {
            class: isArmed ? "tl-btn armed" : "tl-btn",
            text: isArmed ? "Run?" : "Run",
            onclick: () => (RISKY.test(s.name) && !isArmed ? arm(id) : run(s)),
          }),
        ),
      );
    }
  }

  function arm(id: string) {
    armedKey = id;
    window.clearTimeout(armTimer);
    armTimer = window.setTimeout(() => { armedKey = null; renderList(); }, ARM_MS);
    renderList();
  }

  function run(s: ProjectScript) {
    armedKey = null;
    if (!active) return;
    Bridge.runScript(active, s.kind, s.name).catch((e) => say(String(e)));
    renderList();
  }

  function select(dir: string) {
    active = dir;
    scripts = [];
    fetchedAt = 0;
    refresh();
  }

  async function add() {
    const dir = await Bridge.pickFolder();
    if (!dir || State.settings.projects.includes(dir)) return;
    State.settings = { ...State.settings, projects: [...State.settings.projects, dir] };
    void Bridge.saveSettings(State.settings);
    select(dir);
  }

  function unpin(dir: string) {
    State.settings = { ...State.settings, projects: State.settings.projects.filter((p) => p !== dir) };
    void Bridge.saveSettings(State.settings);
    if (active === dir) active = null;
    refresh();
  }

  async function load() {
    if (!active) { scripts = []; fetchedFor = ""; return; }
    if (fetchedFor === active && Date.now() - fetchedAt < REFETCH_MS) return;
    const dir = active;
    const next = await Bridge.projectScripts(dir);
    if (dir !== active) return;
    scripts = next ?? [];
    fetchedFor = dir;
    fetchedAt = Date.now();
  }

  function refresh() {
    const all = projects();
    if (!active || !all.includes(active)) active = all[0] ?? null;
    renderChips(all);
    void load().then(() => { renderChips(projects()); renderList(); });
    renderList();
  }

  refresh();
  return { el, refresh };
}
