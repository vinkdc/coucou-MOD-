// Lookup: Japanese (or English) selected anywhere on the PC, explained by Mochi
// in the island — reading, meaning, a short breakdown, audio, and a button to
// keep the new words for review. One answer, no conversation.

import { h, clear } from "./dom";
import { Bridge, onEvent } from "../core/bridge";
import { speakAll, stop } from "../core/voice";
import { State, today } from "../core/state";
import { newWordsOf, renderReply } from "../study/reply";
import type { ViewHost } from "./views";

/** Longest selection sent to the AI: a sentence or two, not a page. */
export const MAX_LOOKUP_CHARS = 400;

export function buildLookup(onActivity: () => void, askMore: (text: string) => void): ViewHost {
  const source = h("div", { class: "lookup-source", lang: "ja" });
  const body = h("div", { class: "lookup-reply" });
  const words = h("div", { class: "lookup-words" });
  const more = h("button", { class: "quick-chip", text: "Ask Mochi more", onclick: () => State.lookup && askMore(State.lookup.text) });
  const footer = h("div", { class: "lookup-footer" }, words, more);
  const el = h("div", { class: "view" }, h("div", { class: "card lookup-card" }, source, body, footer));

  let handled = -1;
  let running = false;
  /** The reply streamed so far, and the round it is on. */
  let text = "";
  let round = -1;

  const opts = (id: string) => ({
    settings: State.settings,
    known: new Set(State.stats?.known ?? []),
    keyPrefix: `l${id}`,
    onVoiceError: (m: string) => message(m),
  });

  function message(m: string) {
    clear(body);
    body.append(h("div", { class: "lookup-note", text: m }));
    footer.style.display = "none";
  }

  function paint(final: boolean) {
    const { el: reply, lines } = renderReply(text, opts(String(handled)));
    clear(body);
    body.append(reply);
    if (!final) return;
    const found = newWordsOf(text);
    clear(words);
    for (const w of found) {
      const btn = h("button", { class: "add-word", title: `Add ${w.word} to your reviews`, text: `+ ${w.word}` });
      btn.addEventListener("click", () => {
        btn.setAttribute("disabled", "");
        Bridge.addWord(w.word, w.reading, w.meaning, today()).then(
          (added) => {
            btn.textContent = added ? `✓ ${w.word}` : `✓ ${w.word} (already known)`;
          },
          () => {
            btn.removeAttribute("disabled");
            btn.textContent = `Couldn't add ${w.word}`;
          },
        );
      });
      words.append(btn);
    }
    footer.style.display = "";
    if (State.settings.autoPlay && lines.length) speakAll(lines.slice(0, 3)).catch(() => {});
  }

  void onEvent<{ chat: string; round: number; delta: string }>("assistant-stream", (e) => {
    if (e.chat !== "lookup" || !running || !e.delta) return;
    if (round !== -1 && round !== e.round && text) text += "\n";
    round = e.round;
    text += e.delta;
    paint(false);
    onActivity();
  });

  async function run(lookup: { text: string; error?: string }) {
    stop();
    text = "";
    round = -1;
    clear(words);
    source.textContent = lookup.text;
    source.style.display = lookup.text ? "" : "none";
    if (lookup.error) return message(lookup.error);
    if ([...lookup.text].length > MAX_LOOKUP_CHARS) {
      return message(`That's ${[...lookup.text].length} characters. Select a sentence or two and try again.`);
    }
    footer.style.display = "none";
    body.replaceChildren(h("div", { class: "bubble typing" }, h("i"), h("i"), h("i")));
    running = true;
    State.stateOverride = "thinking";
    State.notify();
    const keepAlive = window.setInterval(onActivity, 2000);
    try {
      const reply = await Bridge.chatSend("lookup", `Selected text:\n"""\n${lookup.text}\n"""`, null, today());
      text = reply.text;
      paint(true);
    } catch (err) {
      message(String(err).replace(/^Error:\s*/, ""));
    } finally {
      window.clearInterval(keepAlive);
      running = false;
      State.stateOverride = null;
      State.notify();
    }
  }

  return {
    el,
    sync() {
      const l = State.lookup;
      if (!l || l.token === handled) return;
      handled = l.token;
      void run(l);
    },
  };
}
