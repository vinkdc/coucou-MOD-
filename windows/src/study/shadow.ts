// Shadowing: say a Japanese line out loud, get it transcribed, and see how close
// it was. Click once to start recording, again to stop.

import { h, clear } from "../views/dom";
import { icon } from "../views/phosphor";
import { Bridge } from "../core/bridge";
import { startRecording, MIN_MS, type Recording } from "../core/mic";
import { today } from "../core/state";
import { compare, type Comparison } from "./pronounce";

const VERDICT: Record<Comparison["verdict"], string> = {
  great: "Great, that's what I heard.",
  close: "Close. Here's what differed.",
  again: "Not quite. Listen once more, then try again.",
};

/**
 * A mic button and, below it, the result of the attempt. `target` is the plain
 * Japanese of the line. Returns the button and the panel to insert after the line.
 */
export function shadowControls(target: string, onError: (m: string) => void): { button: HTMLElement; panel: HTMLElement } {
  const button = h("button", { class: "mic-btn", title: "Say it: record yourself and check", "aria-label": "Say it" }, icon("microphone", 13));
  const panel = h("div", { class: "shadow-panel" });
  let rec: Recording | null = null;
  let busy = false;

  function result(c: Comparison, heard: string) {
    clear(panel);
    const row = (label: string, parts: Comparison["target"]) =>
      h(
        "div",
        { class: "shadow-row" },
        h("span", { class: "shadow-k", text: label }),
        h("span", { class: "shadow-text", lang: "ja" }, ...parts.map((p) => h("span", { class: `sh-${p.kind}`, text: p.text }))),
      );
    panel.append(
      h(
        "div",
        { class: `shadow-head ${c.verdict}` },
        h("b", { text: `${Math.round(c.score * 100)}%` }),
        h("span", { text: VERDICT[c.verdict] }),
      ),
      row("You said", c.heard),
      row("Line", c.target),
      h("div", { class: "shadow-note", text: "Checks what was recognised, not pitch accent." }),
    );
    panel.classList.add("on");
    void heard;
  }

  async function toggle() {
    if (busy) return;
    if (!rec) {
      try {
        rec = await startRecording();
      } catch (err) {
        return onError(String((err as Error).message ?? err));
      }
      button.classList.add("recording");
      button.title = "Stop";
      clear(panel);
      panel.classList.remove("on");
      return;
    }
    const r = rec;
    rec = null;
    button.classList.remove("recording");
    button.title = "Say it: record yourself and check";
    busy = true;
    button.classList.add("busy");
    try {
      const { bytes, mime, ms } = await r.stop();
      if (ms < MIN_MS) return;
      const heard = await Bridge.transcribe(bytes, mime);
      if (!heard) {
        clear(panel);
        panel.append(h("div", { class: "shadow-note", text: "I didn't catch anything. Try again a little closer to the mic." }));
        panel.classList.add("on");
        return;
      }
      const c = compare(target, heard);
      result(c, heard);
      void Bridge.speakingLog(c.score, today());
    } catch (err) {
      onError(String((err as Error).message ?? err).replace(/^Error:\s*/, ""));
    } finally {
      busy = false;
      button.classList.remove("busy");
    }
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggle();
  });
  return { button, panel };
}
