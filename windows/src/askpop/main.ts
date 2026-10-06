// The selection popup's page (see src-tauri/src/selection.rs): a capsule of text
// buttons. In an ordinary selection: Explain, Ask…, Listen. In a text field (a
// chat box) a first button, Japanese, translates what was typed and puts the
// translation in its place. The selected text never reaches this page; a press
// only names the action and Rust does the rest.

import "@fontsource-variable/inter/opsz.css";
import "./askpop.css";
import { Bridge, onEvent } from "../core/bridge";

type Action = "japanese" | "explain" | "ask" | "listen";

const root = document.getElementById("root")!;

const BUTTONS: { action: Action; label: string; primary?: boolean; fieldOnly?: boolean }[] = [
  { action: "japanese", label: "Japanese", primary: true, fieldOnly: true },
  { action: "explain", label: "Explain" },
  { action: "ask", label: "Ask…", primary: true },
  { action: "listen", label: "Listen" },
];

function bar(): HTMLElement {
  const el = document.createElement("div");
  el.className = "bar";
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", "Ask Mochi about the selection");
  return el;
}

function show(editable: boolean) {
  const el = bar();
  for (const b of BUTTONS) {
    if (b.fieldOnly && !editable) continue;
    const btn = document.createElement("button");
    btn.textContent = b.label;
    // One accent per popup: the field action when there is one, otherwise Ask….
    if (b.primary && (b.fieldOnly || !editable)) btn.className = "primary";
    btn.addEventListener("click", () => void Bridge.selectionAction(b.action));
    el.append(btn);
  }
  root.replaceChildren(el);
}

function message(text: string, busy: boolean) {
  const el = bar();
  el.classList.add("note");
  if (busy) el.classList.add("busy");
  const span = document.createElement("span");
  span.textContent = text;
  el.append(span);
  root.replaceChildren(el);
}

void onEvent<{ state: "ready" | "busy" | "error"; editable?: boolean; message?: string }>("askpop-state", (e) => {
  if (e.state === "ready") show(!!e.editable);
  else if (e.state === "busy") message("Translating…", true);
  else message(e.message ?? "Something went wrong.", false);
});

show(false);
