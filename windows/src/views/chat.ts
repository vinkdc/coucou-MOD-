// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { matches } from "../core/keys";
import { ICONS } from "./icons";
import { Bridge, onEvent, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import { localPersona } from "../mochi/localSkins";
import { bundlePersona } from "../mochi/bundles";

let nextId = 1;

let sendFromOutside: ((query: string) => void) | null = null;

/** Sends a message as if it had been typed (the cockpit's one-tap actions). */
export function askInChat(query: string) {
  sendFromOutside?.(query);
}

/** Ids for messages added outside this view (confirmation cards). */
export function nextChatId(): number {
  return nextId++;
}

const CONFIRM_STATUS: Record<string, string> = {
  allowed: "Allowed",
  denied: "Denied",
  expired: "No answer — not done",
};

/**
 * An Allow/Deny card for a risky action. The exact command, path or app is the
 * whole point: what is shown is what runs. Buttons answer once, then the card
 * keeps the verdict.
 */
function confirmCard(message: ChatMessage, onAnswered: () => void): HTMLElement {
  // Laid out like an iOS alert: what it wants to do, the exact thing in a
  // well, then two full-width buttons with the safe choice on the left.
  const buttons = h("div", { class: "chat-confirm-buttons" });
  const card = h(
    "div",
    { class: "chat-confirm" },
    h(
      "div",
      { class: "chat-confirm-body" },
      h("div", { class: "chat-confirm-title", text: message.content }),
      message.detail ? h("div", { class: "chat-confirm-detail", text: message.detail }) : null,
    ),
    buttons,
  );
  const settle = () => {
    clear(buttons);
    const allowed = message.status === "allowed";
    buttons.classList.add("settled");
    card.classList.toggle("allowed", allowed);
    buttons.append(
      h(
        "div",
        { class: "chat-confirm-status" },
        svg(allowed ? ICONS.check : ICONS.xmark, 9),
        h("span", { text: CONFIRM_STATUS[message.status ?? ""] ?? "" }),
      ),
    );
  };
  const answer = (allow: boolean) => {
    if (message.status !== "pending" || !message.confirmId) return;
    message.status = allow ? "allowed" : "denied";
    Sound.play(allow ? "approve" : "blip");
    void Bridge.assistantConfirm(message.confirmId, allow);
    settle();
    onAnswered();
  };
  if (message.status === "pending") {
    buttons.append(
      h("button", { class: "chat-confirm-btn", text: "Deny", onclick: () => answer(false) }),
      h("button", { class: "chat-confirm-btn default", text: "Allow", onclick: () => answer(true) }),
    );
  } else {
    settle();
  }
  return h("div", { class: "chat-row" }, card);
}

/** One step the assistant took: a quiet capsule, ✓ when it worked, ✕ when not. */
function actionPill(text: string): HTMLElement {
  const failed = text.endsWith("(failed)") || text.startsWith("Declined");
  const label = text.replace(/\s*\(failed\)$/, "");
  return h(
    "div",
    { class: "chat-row" },
    h(
      "div",
      { class: failed ? "chat-action failed" : "chat-action" },
      svg(failed ? ICONS.xmark : ICONS.check, 8),
      h("span", { text: label }),
    ),
  );
}

function bubble(message: ChatMessage, onAnswered: () => void): HTMLElement {
  if (message.role === "confirm") return confirmCard(message, onAnswered);
  if (message.role === "action") return actionPill(message.content);
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "bubble reply", "data-id": String(message.id), text: message.content }),
  );
}

/** You on one side; Mochi, its steps and its cards on the other. */
const side = (m: ChatMessage) => (m.role === "user" ? "user" : "mochi");
/** Bubbles of the same kind run together, like consecutive texts in Messages. */
const isBubble = (m: ChatMessage | undefined, role: ChatMessage["role"]) => m?.role === role;

/**
 * Lays out the conversation with Messages' rhythm: tight spacing inside one
 * speaker's run, a clear gap when the speaker changes, and the bubble "tail"
 * only on the last bubble of a run.
 */
function renderLog(log: HTMLElement, history: ChatMessage[], thinking: boolean, onAnswered: () => void) {
  clear(log);
  history.forEach((m, i) => {
    const row = bubble(m, onAnswered);
    const prev = history[i - 1];
    const next = history[i + 1];
    if (i > 0 && side(prev) !== side(m)) row.classList.add("turn-start");
    const b = row.querySelector(".bubble");
    if (b && !isBubble(next, m.role) && !(thinking && i === history.length - 1 && m.role === "assistant")) {
      b.classList.add("tail");
    }
    log.append(row);
  });
  if (thinking) {
    const dots = typingDots();
    const last = history.at(-1);
    if (last && side(last) !== "mochi") dots.classList.add("turn-start");
    log.append(dots);
  }
  log.scrollTop = log.scrollHeight;
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "bubble typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string, onRemove: () => void): HTMLElement {
  // Not a nested <button>: the chip itself is one (it folds a picture's preview).
  const remove = h(
    "span",
    { class: "chip-remove", role: "button", tabindex: "0", title: "Remove the attachment" },
    svg(ICONS.xmark, 9),
  );
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  const chip = h("button", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }), remove);
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

/**
 * @param onConfirmAnswered called once a confirmation card has been answered,
 *   so the island stops holding itself open for it.
 */
export function buildPrompt(
  onHeightChange: () => void,
  onConfirmAnswered: () => void,
  onActivity: () => void,
): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  /**
   * Measures how tall the island must be to show everything: the attachment
   * (chip and thumbnail), the whole conversation, and the message field. Each
   * part is added up on its own, so a thumbnail that has squeezed the
   * conversation to nothing still gets the room it needs. The conversation
   * always keeps at least MIN_LOG, so there is space to chat under a picture.
   * Once per frame at most; the island resizes only when the answer moves by
   * more than a couple of pixels.
   */
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

      const parts = [Math.max(MIN_LOG, conversation), bar.offsetHeight];
      if (chipRow.offsetHeight > 0) parts.push(chipRow.offsetHeight);
      const inside =
        parseFloat(bs.paddingTop) + parseFloat(bs.paddingBottom) + parts.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
      // Everything around the chat card: header, insets.
      const around = island.offsetHeight - body.clientHeight;
      const want = Math.ceil(around + inside);
      if (Math.abs(want - State.chatFitHeight) <= 2) return;
      State.chatFitHeight = want;
      onHeightChange();
    });
  };
  // Scrolling moves the newest reply, and the avatar sits beside it.
  log.addEventListener("scroll", () => State.notify(), { passive: true });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Message Mochi",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card chat-card" }, h("div", { class: "chat-body" }, chipRow, log, bar)),
  );

  // The send button lights up only when there is something to send.
  const syncSend = () => send.classList.toggle("ready", input.value.trim().length > 0 && !sending);
  input.addEventListener("input", () => {
    syncSend();
    onActivity();
  });

  let sending = false;
  let renderedCount = "";

  // ── Streaming ──────────────────────────────────────────────────────────────
  // While a message is being answered, Rust sends the reply as it is written
  // ("assistant-stream", one bubble per model call) and each step the moment
  // it happens ("assistant-action"). Text goes straight into its bubble's DOM
  // node, so a stream costs no re-render per word.
  let streamed: ChatMessage | null = null;
  let streamRound = -1;
  /** Everything added live during the current message, to undo on failure. */
  let liveIds = new Set<number>();
  let liveCount = 0;

  void onEvent<{ round: number; delta: string }>("assistant-stream", ({ round, delta }) => {
    if (!sending || !delta) return;
    if (!streamed || streamRound !== round) {
      streamed = { id: nextId++, role: "assistant", content: "" };
      streamRound = round;
      liveIds.add(streamed.id);
      State.chatHistory.push(streamed);
      liveCount++;
      streamed.content = delta.replace(/^\s+/, "");
      State.notify();
      onHeightChange();
      return;
    }
    streamed.content += delta;
    const node = log.querySelector<HTMLElement>(`[data-id="${streamed.id}"]`);
    if (node) {
      node.textContent = streamed.content;
      fit();
      log.scrollTop = log.scrollHeight;
      // The bubble grew: let the avatar follow its bottom edge.
      State.notify();
    } else {
      State.notify();
    }
  });

  void onEvent<string>("assistant-action", (line) => {
    if (!sending) return;
    // The text before a step is finished; anything after it is a new bubble.
    streamed = null;
    const m: ChatMessage = { id: nextId++, role: "action", content: line };
    liveIds.add(m.id);
    liveCount++;
    State.chatHistory.push(m);
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
    liveIds = new Set();
    liveCount = 0;
    Sound.play("send");
    // A reply can take a while with nothing happening on screen: stay open.
    onActivity();
    const keepAlive = window.setInterval(onActivity, 2000);

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      // The character Mochi wears may also say how it talks (imported and local skins).
      const persona = (await bundlePersona(State.settings.skin)) ?? (await localPersona(State.settings.skin));
      const reply = await Bridge.chatSend(query, context, persona);
      // Normally everything already arrived live. If nothing did (an event
      // lost on the way), fall back to what the reply carries.
      if (liveCount === 0) {
        for (const line of reply.actions) {
          State.chatHistory.push({ id: nextId++, role: "action", content: line });
        }
        if (reply.text) State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      }
      for (const m of State.chatHistory) if (liveIds.has(m.id)) m.content = m.content.trimEnd();
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      // A half-written answer is not an answer: take back the partial bubbles,
      // keep the steps (they really happened).
      State.chatHistory = State.chatHistory.filter((m) => !(liveIds.has(m.id) && m.role === "assistant"));
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      window.clearInterval(keepAlive);
      sending = false;
      streamed = null;
      onActivity();
      State.notify();
      onHeightChange();
      // Ready for the next message without a click.
      input.focus();
      void takeKeyboardBack();
    }
  }

  /**
   * The reply is in, so the next thing is the user typing here. If they clicked
   * into another app while waiting (or Mochi opened one), Windows gave it the
   * keyboard: ask for it back — but only once they pause, so a sentence being
   * typed elsewhere is never cut in half.
   */
  async function takeKeyboardBack() {
    for (let i = 0; i < 14; i++) {
      if (State.mode !== "expanded" || State.view !== "prompt") return;
      if (document.hasFocus()) {
        input.focus();
        return;
      }
      const idle = (await Bridge.idleMs()) ?? Number.MAX_SAFE_INTEGER;
      if (idle >= 800) {
        await Bridge.focusWindow(true);
        // The page only gets the caret once the window is really active.
        window.setTimeout(() => input.focus(), 60);
        window.setTimeout(() => input.focus(), 250);
        return;
      }
      await new Promise((r) => window.setTimeout(r, 300));
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
    // Keys typed here stay here (Escape does not close the island from the chat)
    // — except the tab keys, which the island decides on: it only acts on a plain
    // one while this field is empty.
    if (!matches(ev, keys, "tab.prev") && !matches(ev, keys, "tab.next")) e.stopPropagation();
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      // Keyed on the path too: it changes once the copy lands in the inbox,
      // which is when a picture can be previewed.
      const wantChip = file ? `${file.name}
${file.path}` : "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        fit();
        if (file) {
          const chip = contextChip(file.name, () => {
            // Gone from the question too: the next message goes without it.
            State.droppedFile = null;
            State.promptContext = null;
            State.notify();
          });
          chipRow.append(chip);
          void Bridge.filePreview(file.path).then((url) => {
            // Still the same attachment, and a picture.
            if (!url || chipRow.dataset.label !== wantChip) return;
            const img = h("img", { class: "chip-thumb", alt: file.name });
            const caret = svg(ICONS.chevronRight, 9, { stroke: 2.2 });
            caret.classList.add("chip-caret");
            chip.append(caret);
            // Open by default; the chip folds it away and back.
            let open = true;
            const apply = () => {
              img.classList.toggle("folded", !open);
              chip.classList.toggle("open", open);
              chip.title = open ? "Hide preview" : "Show preview";
              fit();
            };
            chip.onclick = () => {
              open = !open;
              apply();
            };
            img.onclick = () => {
              open = false;
              apply();
            };
            img.onload = apply;
            img.src = url;
            chipRow.append(img);
          });
        }
      }

      // The dots mean "Mochi is working on it" — not while its words are
      // already appearing.
      const thinking = State.stateOverride === "thinking" && streamed === null;
      // Rebuilt only when something visible changed: a message, the dots, or a
      // card's verdict (an expired card is settled from outside this view).
      // Streamed text is written into its bubble directly, not through here.
      const count = `${State.chatHistory.length}|${thinking}|${State.chatHistory
        .filter((m) => m.role === "confirm")
        .map((m) => m.status)
        .join()}`;
      if (count !== renderedCount) {
        renderedCount = count;
        renderLog(log, State.chatHistory, thinking, onConfirmAnswered);
        fit();
      }
      // Arriving on the chat (or the island opening on it) re-measures.
      if (State.view === "prompt" && State.mode === "expanded" && State.chatFitHeight === 0) fit();

      input.placeholder = State.chatHistory.length === 0 ? "Message Mochi" : "Reply to Mochi";
      // Never disabled while Mochi answers: a disabled field drops the cursor, and
      // would not take it back until it was enabled again. Like any chat, you can
      // keep typing the next message; sending waits for the reply (see submit).
      syncSend();
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
