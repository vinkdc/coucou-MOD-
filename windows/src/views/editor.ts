// The tall Home view: what Claude Code is doing to a file, drawn like an editor.
// Mochi (drawn by the island, see VIEW_LAYOUTS.editor) sits top left, the steps
// of the session under it, and the file with its change on the right.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { codeLines, fileTab } from "./code";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

/** Steps shown under the name: the last tool calls, then "Done". */
const STEPS = 4;

function stepRow(kind: "done" | "now" | "todo", verb: string, target = ""): HTMLElement {
  const icon = h("span", { class: "st-icon" });
  if (kind === "done") icon.append(svg(ICONS.check, 9, { stroke: 2.6 }));
  else if (kind === "now") icon.append(h("i", { class: "st-spin" }));
  else icon.append(h("i", { class: "st-ring" }));
  return h(
    "div",
    { class: `st ${kind}` },
    icon,
    h("span", { class: "st-verb", text: verb }),
    target ? h("span", { class: "st-target", text: target }) : null,
  );
}

export function buildEditor(actions: ViewActions): ViewHost {
  const left = h("div", { class: "ed-left" });
  const right = h("div", { class: "ed-right" });
  const card = h("div", { class: "card ed-card" }, left, right);
  const el = h("div", { class: "view editor" }, card);
  let key = "";

  return {
    el,
    sync() {
      const task = State.focusTask;
      const a = task?.activity;
      const shell = task?.shell;
      // Nothing to show any more (another pill, a cleared session): back to Home.
      if (!task || (!a && !shell)) {
        queueMicrotask(() => {
          if (State.view === "editor") actions.setView("overview");
        });
        return;
      }
      const log = task.log ?? [];
      const live = task.state === "working";
      const finished = task.state === "finished";
      const next = [
        task.id, task.name, task.state, a?.seq, a?.numbered, a?.lines.length, shell?.command, shell?.status,
        log.map((l) => l.verb + l.target).join("|"),
      ].join("~");
      if (next === key) return;
      key = next;

      // Left: who, then the steps.
      left.replaceChildren(
        h(
          "div",
          { class: "ed-who" },
          h("div", { class: "ed-name", text: task.name }),
          h("div", { class: "ed-agent", text: task.source === "claudeCode" ? "Claude Code" : task.source === "agent" ? "Agent" : "n8n" }),
        ),
        h(
          "div",
          { class: "ed-steps" },
          ...log.slice(-STEPS).map((l, i, arr) =>
            stepRow(i === arr.length - 1 && live ? "now" : "done", l.verb, l.target),
          ),
          stepRow(finished ? "done" : "todo", "Done"),
        ),
      );

      // Right: the file tab and its lines, then the shell command.
      // The caret blinks at the end of the last added line while the tool runs.
      right.replaceChildren();
      if (a) {
        const lines = codeLines(a.lines, a.lang);
        const adds = lines.querySelectorAll(".cl.add");
        if (live && !shell) adds[adds.length - 1]?.classList.add("live");
        right.append(
          fileTab(a),
          h("div", { class: "ed-code" }, a.lines.length ? lines : h("div", { class: "ed-empty", text: `${a.verb === "Read" ? "Reading" : "Working on"} ${a.name}…` })),
        );
      } else {
        right.append(h("div", { class: "ed-code" }));
      }
      if (shell) {
        const label = shell.status === "running" ? "RUNNING" : shell.status === "ok" ? "DONE" : "FAILED";
        right.append(
          h("div", { class: "ed-term" },
            h("div", { class: "term-cmd" }, h("span", { class: "term-ps", text: "$" }), h("span", { text: shell.command })),
            h("span", { class: `term-chip ${shell.status}`, text: label }),
          ),
        );
      }
    },
  };
}
