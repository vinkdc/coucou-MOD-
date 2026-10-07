// The island's quick chat — "how do I say…" from anywhere. Same bubbles as
// before (PromptView / ChatBubble in IslandViewContent.swift); Mochi's replies
// are drawn with the study window's reply renderer (furigana, ▶).

import { h, svg, clear } from "./dom";
import { matches } from "../core/keys";
import { ICONS } from "./icons";
import { icon } from "./phosphor";
import { startVoiceChat, type VoiceChat, type VoicePhase } from "../core/voicechat";
import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { speakStream, stop, type SpeechStream } from "../core/voice";
import { State, today, type ChatMessage } from "../core/state";
import type { GoogleItem, MemoryNote } from "../core/bridge";
import { renderReply } from "../study/reply";
import { spokenLines } from "../study/markup";
import { SCENARIOS } from "../study/scenarios";
import type { ViewHost } from "./views";

let nextId = 1;

let sendFromOutside: ((query: string) => void) | null = null;

/** Sends a message as if it had been typed (Home's quick chips). */
export function askInChat(query: string) {
  sendFromOutside?.(query);
}

let fillFromOutside: ((text: string) => void) | null = null;

/** Puts text in the chat field, ready to be added to, and focuses it (the selection popup's "Ask…"). */
export function prefillChat(text: string) {
  fillFromOutside?.(text);
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

/** A quiet capsule under Mochi's reply: what it just remembered about the learner, with an undo. */
function memoryRow(message: ChatMessage, note: MemoryNote): HTMLElement {
  const row = h("div", { class: "chat-row memory-note" });
  const undo = h("button", { class: "chat-action-undo", text: "Undo" }) as HTMLButtonElement;
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    if (await Bridge.memoryForget(note.id)) {
      message.remembered = message.remembered?.filter((n) => n !== note);
      row.remove();
    } else {
      undo.disabled = false;
    }
  });
  row.append(h("div", { class: "chat-action memory", title: note.text }, h("span", { text: `Remembered: ${note.text}` }), undo));
  return row;
}

// ── From the learner's own day (Google Calendar and Tasks) ────────────────────
// A title is sent to the AI only when the learner presses its chip.

const day: { configured: boolean; connected: boolean; items: GoogleItem[]; loadedAt: number } = { configured: false, connected: false, items: [], loadedAt: 0 };

/** Set by the chat view: re-reads the day (after connecting). */
let reloadDay: (() => void) | null = null;

function dayLabel(item: GoogleItem): string {
  const title = item.title.length > 26 ? `${item.title.slice(0, 25)}…` : item.title;
  if (item.kind === "event" && !item.allDay && item.when) {
    const t = new Date(item.when);
    if (!Number.isNaN(t.getTime())) return `${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${title}`;
  }
  return title;
}

function toast(message: string) {
  State.noteMessage = message;
  State.view = "note";
  State.notify();
}

/** One tap to opt in: Google asks for consent in the browser, and the day appears here. */
function connectHint(): HTMLElement {
  const hints = h("div", { class: "chat-hints" }, h("div", { class: "hint-label", text: "From your day" }));
  const chip = h("button", {
    class: "quick-chip",
    text: "Connect Google Calendar & Tasks",
    title: "Practise phrases from your own events and tasks. Read-only until you press a button.",
    onclick: () => {
      chip.setAttribute("disabled", "");
      void Bridge.googleConnect()
        .then(() => {
          day.loadedAt = 0;
          reloadDay?.();
        })
        .catch((err) => {
          chip.removeAttribute("disabled");
          toast(String(err).replace(/^Error:\s*/, ""));
        });
    },
  });
  hints.append(h("div", { class: "quick-chips wrap" }, chip));
  return hints;
}

/** "Thursday, Oct 8 at 1:30 PM" for a timed event, the date alone otherwise. */
function whenText(item: GoogleItem): string {
  const t = new Date(item.when);
  if (!item.when || Number.isNaN(t.getTime())) return "";
  const date = t.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  return item.allDay ? date : `${date} at ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * Pressing an item asks Mochi to talk about it: what it is, what to expect or prepare, and a few
 * Japanese phrases for it, knowing what else is on that day. This one press is what lets the
 * item's details reach the AI; nothing else from the calendar is sent.
 */
function talkAboutDayItem(item: GoogleItem) {
  const dayKey = item.when && !Number.isNaN(new Date(item.when).getTime()) ? new Date(item.when).toDateString() : "";
  const sameDay = dayKey ? day.items.filter((o) => o !== item && o.when && new Date(o.when).toDateString() === dayKey) : [];
  const at = (o: GoogleItem) => (o.allDay ? "" : ` (${new Date(o.when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`);
  const lines = [
    "Here is something from my calendar. Talk to me about it like a friendly tutor: what it is, what I should expect or prepare, and two or three Japanese phrases I could use for it (with furigana).",
    `Title: ${item.title}`,
    item.kind === "task" ? `Type: task${whenText(item) ? `, due ${whenText(item)}` : ""}` : `When: ${whenText(item) || "(no time)"}`,
    item.location ? `Where: ${item.location}` : "",
    item.notes ? `Notes: ${item.notes}` : "",
    sameDay.length ? `Also that day: ${sameDay.map((o) => o.title + at(o)).join("; ")}` : "",
  ].filter(Boolean);
  askInChat(lines.join("\n"));
}

function dayHints(): HTMLElement {
  const hints = h("div", { class: "chat-hints" }, h("div", { class: "hint-label", text: "From your day" }));
  const row = h("div", { class: "quick-chips wrap" });
  for (const item of day.items.slice(0, 5)) {
    row.append(
      h("button", {
        class: "quick-chip",
        title: "Mochi talks about this",
        text: dayLabel(item),
        onclick: () => talkAboutDayItem(item),
      }),
    );
  }
  const when = (utc: string) => new Date(utc).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  row.append(
    h("button", {
      class: "quick-chip",
      text: "＋ 15 min study",
      title: "Add a short study block to your calendar, in the next free slot",
      onclick: () =>
        void Bridge.googleStudyBlock(15)
          .then((start) => toast(`Added a 15-minute study block to your calendar: ${when(start)}.`))
          .catch((err) => toast(String(err).replace(/^Error:\s*/, ""))),
    }),
    h("button", {
      class: "quick-chip",
      text: "＋ Review task",
      title: "Add a review task to Google Tasks",
      onclick: () =>
        void Bridge.googleAddTask("Review Japanese cards (Kotoba)")
          .then(() => toast("Added “Review Japanese cards” to Google Tasks."))
          .catch((err) => toast(String(err).replace(/^Error:\s*/, ""))),
    }),
  );
  hints.append(row);
  return hints;
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
    for (const note of m.remembered ?? []) log.append(memoryRow(m, note));
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
    if (day.connected) log.append(dayHints());
    else if (day.configured) log.append(connectHint());
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
  const mic = h("button", { class: "voice-btn", title: "Voice chat", "aria-label": "Voice chat" }, icon("microphone", 13));
  const bar = h("div", { class: "chat-bar" }, input, mic, send);
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
  /** The field holds a quote from the selection popup ("Ask…"), not an old draft. */
  let quoted = false;
  /** Auto-play of the reply being received, and how many of its lines it has queued. */
  let speech: SpeechStream | null = null;
  let spoken = 0;

  /** Queues the reply's Japanese lines in `text` that aren't queued yet. */
  const speakNew = (msg: ChatMessage, text: string) => {
    if (!speech) return;
    const lines = spokenLines(text, replyOpts(msg.id).keyPrefix);
    for (const line of lines.slice(spoken)) speech.push(line);
    spoken = Math.max(spoken, lines.length);
  };

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
    // Speak each Japanese line as soon as it is complete, while the rest still streams in.
    speakNew(streamed, streamed.content.slice(0, streamed.content.lastIndexOf("\n") + 1));
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

  /** Reads today's events and tasks (at most every five minutes) when the chat is shown. */
  async function loadDay() {
    if (Date.now() - day.loadedAt < 5 * 60_000) return;
    day.loadedAt = Date.now();
    const status = await Bridge.googleStatus();
    day.configured = status?.configured ?? false;
    day.connected = status?.connected ?? false;
    day.items = [];
    if (day.connected) {
      try {
        day.items = await Bridge.googleAgenda();
      } catch {
        day.loadedAt = 0; // try again next time the chat opens
      }
    }
    renderedCount = "";
    State.notify();
  }

  reloadDay = () => void loadDay();

  // ── Voice chat: the mic stays open, each utterance is sent, replies are spoken ──
  let voice: VoiceChat | null = null;
  let voicePhase: VoicePhase = "listening";

  const syncVoice = () => {
    mic.classList.toggle("live", voice !== null);
    mic.classList.toggle("hearing", voice !== null && voicePhase === "hearing");
    mic.title = voice ? "Stop voice chat" : "Voice chat";
    if (voice) {
      input.placeholder = voicePhase === "hearing" ? "Listening to you…" : voicePhase === "thinking" ? "Mochi is thinking…" : "Speak any time — Mochi is listening";
    }
  };

  /** The island must not auto-close on a conversation that is merely quiet. */
  let voiceKeepAlive = 0;

  const stopVoice = () => {
    voice?.stop();
    voice = null;
    window.clearInterval(voiceKeepAlive);
    stop();
    syncVoice();
  };

  async function toggleVoice() {
    if (voice) return stopVoice();
    try {
      voice = await startVoiceChat({
        onPhase: (p) => {
          voicePhase = p;
          syncVoice();
          onActivity();
        },
        onUtterance: async (text) => {
          while (sending) await new Promise((r) => setTimeout(r, 100));
          await submit(text);
        },
        onError: (m) => {
          State.noteMessage = m;
          State.view = "note";
          State.notify();
        },
      });
      voiceKeepAlive = window.setInterval(onActivity, 2000);
      syncVoice();
    } catch (err) {
      voice = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      State.notify();
    }
  }

  mic.addEventListener("click", () => void toggleVoice());

  async function submit(heard?: string) {
    const query = (heard ?? input.value).trim();
    if (!query || sending) return;
    if (heard === undefined) input.value = "";
    quoted = false;
    sending = true;
    streamed = null;
    streamRound = -1;
    stop();
    speech = State.settings.autoPlay || voice ? speakStream() : null;
    spoken = 0;
    Sound.play("send");
    onActivity();
    const keepAlive = window.setInterval(onActivity, 2000);

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    try {
      const reply = await Bridge.chatSend("quick", query, null, today());
      const msg: ChatMessage = streamed ?? { id: nextId++, role: "assistant", content: "" };
      if (!streamed) State.chatHistory.push(msg);
      msg.content = reply.text;
      if (reply.remembered?.length) msg.remembered = reply.remembered;
      State.stateOverride = null;
      Sound.play("finish");
      // The last line, which had no newline after it yet (or all of them, if nothing streamed).
      speakNew(msg, reply.text);
    } catch (err) {
      if (speech) stop();
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
      speech = null;
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

  fillFromOutside = (text) => {
    input.value = text;
    quoted = true;
    syncSend();
    input.focus();
    input.setSelectionRange(text.length, text.length);
  };

  send.addEventListener("click", () => void submit());
  // While an IME is composing, Enter / arrows / Esc belong to it (convert, pick a
  // clause, cancel): never send or switch tabs on them. The commit Enter can
  // arrive just after compositionend, so it is covered for a moment too.
  let composing = false;
  let composedAt = -Infinity;
  input.addEventListener("compositionstart", () => (composing = true));
  input.addEventListener("compositionend", () => {
    composing = false;
    composedAt = performance.now();
  });
  input.addEventListener("keydown", (e) => {
    const ev = e as KeyboardEvent;
    const keys = State.settings.keys;
    if (composing || ev.isComposing || ev.keyCode === 229 || performance.now() - composedAt < 40) {
      e.stopPropagation();
      return;
    }
    if (matches(ev, keys, "chat.send")) {
      e.preventDefault();
      void submit();
    }
    if (matches(ev, keys, "chat.voice")) {
      e.preventDefault();
      void toggleVoice();
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
      if (voice && State.view !== "prompt") stopVoice();
      if (voice) syncVoice();
      else input.placeholder = State.chatHistory.length === 0 ? "How do I say…?" : "Reply to Mochi";
      syncSend();
    },
    focus() {
      void loadDay();
      input.focus();
      // A quote just put there is to be added to: the caret goes after it, nothing is selected.
      if (quoted) input.setSelectionRange(input.value.length, input.value.length);
      else input.select();
    },
  };
}
