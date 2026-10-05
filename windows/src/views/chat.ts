// The island's quick chat — "how do I say…" from anywhere. Same bubbles as
// before (PromptView / ChatBubble in IslandViewContent.swift); Mochi's replies
// are drawn with the study window's reply renderer (furigana, ▶).

import { h, svg, clear } from "./dom";
import { matches } from "../core/keys";
import { ICONS } from "./icons";
import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { speakAll, stop } from "../core/voice";
import { State, today, type ChatMessage } from "../core/state";
import { renderReply } from "../study/reply";
import { SCENARIOS } from "../study/scenarios";
import type { ViewHost } from "./views";

let nextId = 1;

let sendFromOutside: ((query: string) => void) | null = null;

/** Sends a message as if it had been typed (Home's quick chips). */
export function askInChat(query: string) {
  sendFromOutside?.(query);
}

function replyOpts(id: number) {
  return {
    settings: State.settings,
    known: new Set(State.stats?.known ?? []),
    keyPrefix: `q${id}`,
    onVoiceError: (m: string) => {
      State.noteMessage = m;
      State.view = "note";
      State.notify();
    },
  };
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h("div", { class: "chat-row user" }, h("div", { class: "bubble", lang: "ja", text: message.content }));
  }
  const b = h("div", { class: "bubble reply", "data-id": String(message.id) }, renderReply(message.content, replyOpts(message.id)).el);
  return h("div", { class: "chat-row" }, b);
}

/** Lays out the conversation with Messages' rhythm: tight runs, a gap when the speaker changes. */
function renderLog(log: HTMLElement, history: ChatMessage[], thinking: boolean) {
  clear(log);
  history.forEach((m, i) => {
    const row = bubble(m);
    const prev = history[i - 1];
    const next = history[i + 1];
    if (i > 0 && prev.role !== m.role) row.classList.add("turn-start");
    const b = row.querySelector(".bubble");
    if (b && next?.role !== m.role && !(thinking && i === history.length - 1 && m.role === "assistant")) b.classList.add("tail");
    log.append(row);
  });
  // A fresh conversation offers talks to start, in this same chat.
  if (history.length === 0 && !thinking) {
    const hints = h("div", { class: "chat-hints" }, h("div", { class: "hint-label", text: "Start a talk" }));
    const row = h("div", { class: "quick-chips wrap" });
    for (const s of SCENARIOS.slice(1)) {
      row.append(h("button", { class: "quick-chip", text: s.label, onclick: () => askInChat(s.opener) }));
    }
    hints.append(row);
    log.append(hints);
  }
  if (thinking) {
    const dots = h("div", { class: "chat-row" }, h("div", { class: "bubble typing" }, h("i"), h("i"), h("i")));
    if (history.at(-1)?.role === "user") dots.classList.add("turn-start");
    log.append(dots);
  }
  log.scrollTop = log.scrollHeight;
}

export function buildPrompt(onHeightChange: () => void, onActivity: () => void): ViewHost {
  const log = h("div", { class: "chat-log" });
  /** Measures how tall the island must be to show the conversation and the field. */
  const MIN_LOG = 56;
  let fitQueued = false;
  const fit = () => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      const island = document.getElementById("island");
      const body = log.parentElement;
      if (!island || !body || !log.isConnected || body.clientHeight === 0) return;
      const bs = getComputedStyle(body);
      const ls = getComputedStyle(log);
      const gap = parseFloat(bs.rowGap) || 0;
      let conversation = parseFloat(ls.paddingTop) + parseFloat(ls.paddingBottom);
      const first = log.firstElementChild as HTMLElement | null;
      const last = log.lastElementChild as HTMLElement | null;
      if (first && last) conversation += last.offsetTop + last.offsetHeight - first.offsetTop;
      const inside = parseFloat(bs.paddingTop) + parseFloat(bs.paddingBottom) + Math.max(MIN_LOG, conversation) + bar.offsetHeight + gap;
      const around = island.offsetHeight - body.clientHeight;
      const want = Math.ceil(around + inside);
      if (Math.abs(want - State.chatFitHeight) <= 2) return;
      State.chatFitHeight = want;
      onHeightChange();
    });
  };
  log.addEventListener("scroll", () => State.notify(), { passive: true });
  const input = h("input", { type: "text", class: "chat-input", placeholder: "How do I say…?", spellcheck: "false", lang: "ja" }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);
  const el = h("div", { class: "view" }, h("div", { class: "card chat-card" }, h("div", { class: "chat-body" }, log, bar)));

  const syncSend = () => send.classList.toggle("ready", input.value.trim().length > 0 && !sending);
  input.addEventListener("input", () => {
    syncSend();
    onActivity();
  });

  let sending = false;
  let renderedCount = "";
  let streamed: ChatMessage | null = null;
  let streamRound = -1;

  void onEvent<{ chat: string; round: number; delta: string }>("assistant-stream", ({ chat, round, delta }) => {
    if (chat !== "quick" || !sending || !delta) return;
    if (!streamed) {
      streamed = { id: nextId++, role: "assistant", content: "" };
      State.chatHistory.push(streamed);
    } else if (streamRound !== round && streamed.content) {
      streamed.content += "\n";
    }
    streamRound = round;
    streamed.content += delta;
    const node = log.querySelector<HTMLElement>(`[data-id="${streamed.id}"]`);
    if (node) {
      clear(node);
      node.append(renderReply(streamed.content, replyOpts(streamed.id)).el);
      fit();
      log.scrollTop = log.scrollHeight;
    }
    State.notify();
    onHeightChange();
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    streamed = null;
    streamRound = -1;
    stop();
    Sound.play("send");
    onActivity();
    const keepAlive = window.setInterval(onActivity, 2000);

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    try {
      const reply = await Bridge.chatSend("quick", query, null, today());
      const msg = streamed ?? { id: nextId++, role: "assistant" as const, content: "" };
      if (!streamed) State.chatHistory.push(msg);
      msg.content = reply.text;
      State.stateOverride = null;
      Sound.play("finish");
      if (State.settings.autoPlay) {
        const { lines } = renderReply(reply.text, replyOpts(msg.id));
        speakAll(lines).catch(() => {});
      }
    } catch (err) {
      const half = streamed;
      State.chatHistory = State.chatHistory.filter((m) => m !== half);
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      window.clearInterval(keepAlive);
      sending = false;
      streamed = null;
      renderedCount = "";
      onActivity();
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  sendFromOutside = (query) => {
    if (sending) return;
    input.value = query;
    void submit();
  };

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    const ev = e as KeyboardEvent;
    const keys = State.settings.keys;
    if (matches(ev, keys, "chat.send") && !ev.isComposing) {
      e.preventDefault();
      void submit();
    }
    // Keys typed here stay here, except the tab keys, which the island decides on.
    if (!matches(ev, keys, "tab.prev") && !matches(ev, keys, "tab.next")) e.stopPropagation();
  });

  return {
    el,
    sync() {
      const thinking = State.stateOverride === "thinking" && streamed === null;
      const count = `${State.chatHistory.length}|${thinking}|${sending}`;
      if (count !== renderedCount) {
        renderedCount = count;
        renderLog(log, State.chatHistory, thinking);
        fit();
      }
      if (State.view === "prompt" && State.mode === "expanded" && State.chatFitHeight === 0) fit();
      input.placeholder = State.chatHistory.length === 0 ? "How do I say…?" : "Reply to Mochi";
      syncSend();
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
