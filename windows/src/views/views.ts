// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { buildPrompt } from "./chat";
import { buildCockpit } from "./cockpit";
import { buildEditor } from "./editor";
import { codeLines, miniLines } from "./code";
import { buildUpload, buildUploading } from "./upload";
import { buildTools } from "./tools";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
  /** "Choose a file…" — the same swallow sequence as a drop, from a dialog. */
  pickFile(): void;
  /** Snip part of the screen; the snip arrives like a dropped file. */
  snip(): void;
  /** Nothing is waiting on the user any more: the island may auto-close again. */
  releasePin(): void;
  /** The chat is in use (typing, waiting for a reply): don't let the island auto-close. */
  keepOpen(): void;
  /** Makes the chat large, or back to its normal size. */
  toggleChatSize(): void;
  /** Starts a fresh chat with this prompt and sends it. */
  ask(prompt: string): void;
  /** Back to the terminal window of a session (folder as the fallback). */
  focusSession(pids: number[], cwd: string | null): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /**
   * True while `tick` still has an animation to finish. The island's frame
   * loop stops when nothing moves, and a view animated from `tick` must keep it
   * alive until it lands — or it freezes half-way.
   */
  animating?(): boolean;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13), h("span", { text: "Home" }));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13), h("span", { text: "Chat" }));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13), h("span", { text: "File" }));
  const tabTools = h("button", { class: "tab", title: "Tools", onclick: () => go("tools") }, svg(ICONS.wrench, 13), h("span", { text: "Tools" }));

  const snipBtn = h("button", { title: "Snip (also copied to the clipboard)", onclick: () => actions.snip() }, svg(ICONS.hdrSnip, 15, { viewBox: 256 }));
  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.hdrGear, 15, { viewBox: 256 }));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.hdrSound, 15, { viewBox: 256 }));
  // Only in the chat: shows it large so a long answer can be read comfortably.
  const sizeBtn = h("button", { title: "Expand chat", onclick: () => actions.toggleChatSize() }, svg(ICONS.hdrExpand, 15, { viewBox: 256 }));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop, tabTools),
    h("div", { class: "header-actions" }, sizeBtn, snipBtn, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty" || v === "editor");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      tabTools.classList.toggle("on", v === "tools");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(ICONS.hdrGear, 15, { viewBox: 256 }));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.hdrSound : ICONS.hdrMute, 15, { viewBox: 256 }));
      sizeBtn.style.display = v === "prompt" ? "" : "none";
      clear(sizeBtn);
      sizeBtn.append(svg(State.chatExpanded ? ICONS.hdrShrink : ICONS.hdrExpand, 15, { viewBox: 256 }));
      sizeBtn.title = State.chatExpanded ? "Shrink chat" : "Expand chat";
      sizeBtn.classList.toggle("on", State.chatExpanded);
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  // The card: who, the file (or latest tool) and a few lines of it.
  const actWho = h("div", { class: "who" });
  const actLine = h("div", { class: "act-line" });
  const actCode = h("div", { class: "act-code" });
  const activityBody = h("div", { class: "card-body act", title: "Open the editor", onclick: () => { if (!State.focusTask?.activity && !State.focusTask?.shell) return; actions.blip(); actions.setView("editor"); } },
    actWho, actLine, actCode);
  let actKey = "";
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const cockpit = buildCockpit(actions);
  const right = card(null, cockpit.el);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "activity" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const sessionActive =
        task?.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0);

      if (task && sessionActive) {
        const activity = task.activity;
        if (mode !== "activity") {
          clear(leftBody);
          leftBody.append(activityBody);
          mode = "activity";
          cardKey = "";
          actKey = "";
        }
        clear(actWho);
        actWho.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.source === "claudeCode" ? "Claude Code" : "n8n" }),
        );
        if (task.steps.length > 1) {
          actWho.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        // The new card is always the one shown: with a file it carries the file
        // and its lines, before the first file it carries the latest steps.
        const sh = task.shell?.status === "running" ? task.shell.command : "";
        const recent = task.steps.slice(-3);
        const k = activity
          ? `${activity.seq}~${activity.numbered}~${activity.lines.length}~${sh}`
          : `steps~${recent.join("|")}~${sh}`;
        if (k !== actKey) {
          actKey = k;
          clear(actLine);
          clear(actCode);
          if (activity) {
            actLine.append(
              svg(ICONS.doc, 12),
              h("b", { text: sh ? "Bash" : activity.verb }),
              h("span", { class: "act-path", text: sh || activity.rel }),
            );
            const lines = miniLines(activity);
            actCode.append(
              lines.length
                ? codeLines(lines, activity.lang)
                : h("div", { class: "ed-empty", text: `${activity.verb === "Read" ? "Reading" : "Working on"} ${activity.name}…` }),
            );
          } else {
            const last = task.log?.at(-1);
            actLine.append(
              svg(ICONS.doc, 12),
              h("b", { text: sh ? "Bash" : last?.verb ?? "Working" }),
              h("span", { class: "act-path", text: sh || last?.target || "" }),
            );
            for (const step of recent.length ? recent : ["…"]) actCode.append(h("div", { class: "act-step", text: step }));
          }
        }
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      cockpit.sync();
    },
  };
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code is asking a question"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude needs an answer.";
      clear(row);
      row.append(h("div", { class: "sub", text: "Answer in your terminal — Coucou can't reply for you yet." }));
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Guide ─────────────────────────────────────────────────────────────────────

/** Mochi walking the user through a task, one step at a time. */
function buildGuide(actions: ViewActions): ViewHost {
  const who = h("div", { class: "who-row" });
  const text = h("div", { class: "title guide-step" });
  const back = btn("Back", "secondary", () => move(-1));
  const next = btn("Next", "primary", () => move(1));
  const done = btn("Done", "primary", () => {
    actions.blip();
    void Bridge.guideClear();
    State.guide = null;
    actions.releasePin();
    actions.setView(State.defaultView());
  });
  const open = h("button", {
    class: "link-btn guide-open",
    text: "Open page",
    onclick: () => {
      if (State.guide?.page) void Bridge.openWindowsSettings(State.guide.page);
    },
  });
  const check = btn("Check", "secondary", () => {
    const g = State.guide;
    if (!g || g.check?.busy) return;
    actions.blip();
    const at = g.index;
    g.check = { busy: true };
    State.notify();
    // The screenshot goes to the model only from this click.
    Bridge.guideCheck(g.title, g.steps[at] ?? "").then(
      (r) => {
        if (State.guide === g && g.index === at) g.check = { busy: false, done: r?.done ?? false, hint: r?.hint ?? "Couldn't check." };
        State.notify();
      },
      (err) => {
        if (State.guide === g && g.index === at) g.check = { busy: false, done: false, hint: String(err) };
        State.notify();
      },
    );
  });
  const show = btn("Show me", "secondary", () => {
    const g = State.guide;
    if (!g || g.check?.busy) return;
    actions.blip();
    const at = g.index;
    g.check = { busy: true };
    State.notify();
    // Same as Check: the screenshot goes to the model only from this click.
    Bridge.guideLocate(g.title, g.steps[at] ?? "").then(
      (r) => {
        if (State.guide === g && g.index === at) {
          g.check = { busy: false, done: r?.found ?? false, hint: r?.found ? (r.label ? `Orange ring: ${r.label}` : "Look for the orange ring.") : "Nothing to point at on this screen." };
        }
        State.notify();
      },
      (err) => {
        if (State.guide === g && g.index === at) g.check = { busy: false, done: false, hint: String(err) };
        State.notify();
      },
    );
  });
  // Built once: rebuilding buttons between a mouse-down and a mouse-up would
  // swallow the click (same reason as the approval card).
  const row = h("div", { class: "actions" }, back, show, check, next, done, open);

  function move(by: number) {
    const g = State.guide;
    if (!g) return;
    g.check = null;
    void Bridge.guideClear();
    g.index = Math.max(0, Math.min(g.steps.length - 1, g.index + by));
    actions.blip();
    State.notify();
  }

  return {
    el: h("div", { class: "view" }, card("cyan", stack(116, 16, who, text, row))),
    sync() {
      const g = State.guide;
      if (!g) return;
      clear(who);
      who.append(h("span", { class: "n", text: g.title }));
      const c = g.check;
      if (c?.busy) {
        who.append(h("span", { text: "Looking at your screen…" }));
      } else if (c) {
        who.append(h("span", { class: c.done ? "guide-ok" : "guide-no", text: c.hint ?? "" }));
      } else {
        who.append(h("span", { text: `Step ${g.index + 1} of ${g.steps.length}` }));
      }
      check.style.opacity = show.style.opacity = c?.busy ? "0.5" : "";
      text.textContent = g.steps[g.index] ?? "";
      const last = g.index >= g.steps.length - 1;
      back.style.display = g.index > 0 ? "" : "none";
      next.style.display = last ? "none" : "";
      done.style.display = last ? "" : "none";
      open.style.display = g.page ? "" : "none";
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("editor", buildEditor(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion());
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("guide", buildGuide(actions));
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange, () => actions.releasePin(), () => actions.keepOpen()));
  map.set("upload", buildUpload(actions));
  map.set("tools", buildTools());
  map.set("uploading", buildUploading());
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
