// "What Mochi knows about you": everything the tutor remembers about the learner
// (src-tauri/src/memory.rs), grouped, each line editable or deletable. Mochi
// builds lessons from it, so the learner stays in charge of what is in it.

import { h, clear } from "../views/dom";
import { Bridge, onEvent, type Memory, type MemoryItem } from "../core/bridge";
import { today } from "../core/state";

const GROUPS: { kind: MemoryItem["kind"]; title: string }[] = [
  { kind: "about", title: "About you" },
  { kind: "preference", title: "How you like to learn" },
  { kind: "event", title: "Coming up" },
];

const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

export function buildMemory() {
  const body = h("div", { class: "memory-body" });
  const el = h(
    "section",
    { class: "panel memory-panel" },
    h("div", { class: "panel-head" }, h("h2", { text: "What Mochi knows about you" }), h("span", { class: "panel-sub", text: "Used to build your lessons. Click a line to edit it." })),
    body,
  );

  function forgetButton(onForget: () => Promise<unknown>): HTMLElement {
    const b = h("button", { class: "memory-forget", text: "Forget" }) as HTMLButtonElement;
    b.addEventListener("click", async () => {
      b.disabled = true;
      await onForget();
      b.disabled = false;
    });
    return b;
  }

  /** The text turns into a field on click; Enter saves, Escape cancels. */
  function editable(item: MemoryItem): HTMLElement {
    const text = h("button", { class: "memory-text", text: item.text, title: "Edit" });
    text.addEventListener("click", () => {
      const field = h("input", { class: "memory-field", type: "text", value: item.text, spellcheck: "false" }) as HTMLInputElement;
      const done = () => field.replaceWith(text);
      field.addEventListener("keydown", async (e) => {
        if (e.key === "Escape") done();
        if (e.key !== "Enter") return;
        const value = field.value.trim();
        if (!value || value === item.text) return done();
        try {
          await Bridge.memoryEdit(item.id, value, today());
        } catch {
          done();
        }
      });
      field.addEventListener("blur", done);
      text.replaceWith(field);
      field.focus();
      field.select();
    });
    return text;
  }

  function row(item: MemoryItem): HTMLElement {
    return h(
      "div",
      { class: "memory-row" },
      h(
        "div",
        { class: "memory-main" },
        item.kind === "event" && item.date ? h("span", { class: "memory-date", text: fmtDay(item.date) }) : null,
        editable(item),
        item.said ? h("span", { class: "memory-said", lang: "ja", text: item.said }) : null,
      ),
      forgetButton(() => Bridge.memoryForget(item.id)),
    );
  }

  function render(memory: Memory | null) {
    clear(body);
    const items = memory?.items ?? [];
    const sessions = memory?.sessions ?? [];
    if (items.length === 0 && sessions.length === 0) {
      body.append(
        h("div", {
          class: "chart-empty",
          text: "Mochi doesn't know you yet. Tell it about your day, your work or your hobbies, in Japanese if you can.",
        }),
      );
      return;
    }
    for (const g of GROUPS) {
      const rows = items.filter((i) => i.kind === g.kind);
      if (g.kind === "event") rows.sort((a, b) => a.date.localeCompare(b.date));
      if (rows.length === 0) continue;
      body.append(h("div", { class: "memory-group" }, h("h3", { text: g.title }), ...rows.map(row)));
    }
    if (sessions.length) {
      const recent = [...sessions].reverse().slice(0, 8);
      body.append(
        h(
          "div",
          { class: "memory-group" },
          h("h3", { text: "Recent conversations" }),
          ...recent.map((s) =>
            h(
              "div",
              { class: "memory-row" },
              h("div", { class: "memory-main" }, h("span", { class: "memory-date", text: fmtDay(s.date) }), h("span", { class: "memory-recap", text: s.summary })),
              forgetButton(() => Bridge.memoryForgetSession(s.id)),
            ),
          ),
        ),
      );
    }
  }

  const load = async () => render(await Bridge.memoryList());
  void onEvent<null>("memory-changed", () => void load());
  void load();
  return { el };
}
