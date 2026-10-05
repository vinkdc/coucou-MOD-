// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop, onEvent } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { RibbonSkin } from "../mochi/skin";
import { loadLocalSkin, localSkinNames } from "../mochi/localSkins";
import { bundleId, loadBundle } from "../mochi/bundles";
import { askInChat } from "../views/chat";
import { binding, comboFromEvent, isBare } from "../core/keys";
import { refreshIde } from "../core/ide";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";

const BOT_OVERHANG = 40;
/** Fixed canvas size for full-figure skins (the avatar is at most ~110 px). */
const STEADY_BOT_PX = 128;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

/** Where each integration's ↗ goes — same targets as openAgentTarget() on macOS. */
const INTEGRATION_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

/** Opens an integration's dashboard (the ↗ button, and the assistant's tool). */
export function openIntegrationTarget(id: string): boolean {
  if (id === "integration_claude") {
    const task = State.tasks.find((t) => t.id === id);
    void Bridge.focusSession(task?.sessionPids ?? [], task?.sessionCwd ?? null);
  } else if (id === "integration_n8n") {
    void Bridge.openN8n();
  } else if (INTEGRATION_URLS[id]) {
    void Bridge.openUrl(INTEGRATION_URLS[id]);
  } else {
    return false;
  }
  return true;
}

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);
  private steadyBot = false;

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window hidden; the launch greeting is its first summon.
  private windowHidden = true;
  private hideTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;
  /** The user clicked inside the island, so it holds the keyboard until it closes. */
  private userFocused = false;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;
  /** A file dialog is up; a second one must not open behind it. */
  private picking = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      // Back to the terminal window the session runs in, not just its folder.
      openTerminal: () => {
        const task = State.focusTask;
        void Bridge.focusSession(task?.sessionPids ?? [], task?.sessionCwd ?? null);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (task) openIntegrationTarget(task.id);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        State.pendingApproval = null;
        State.isPinned = false;
        this.fsm.pinned = false;
        State.updateTask("integration_claude", "working");
        State.setPillBadge("integration_claude", null);
        this.setView(State.defaultView());
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      pickFile: () => void this.openPicker(),
      snip: () => void this.snip(),
      toggleChatSize: () => {
        const shrinking = State.chatExpanded;
        State.chatExpanded = !shrinking;
        this.animateGeometry(shrinking);
        State.notify();
      },
      focusSession: (pids, cwd) => void Bridge.focusSession(pids, cwd),
      ask: (prompt) => {
        // A new topic: no leftover file or conversation, then straight to the chat.
        State.chatHistory = [];
        State.droppedFile = null;
        State.promptContext = null;
        void Bridge.chatReset();
        this.setView("prompt");
        window.setTimeout(() => askInChat(prompt), 90);
      },
      keepOpen: () => this.keepOpen(),
      releasePin: () => {
        State.isPinned = false;
        this.dropPin();
      },
    };

    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas();

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") {
      Sound.play("open");
      // An editor may have been opened or closed since: Home names the right one.
      void refreshIde();
    }
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      this.userFocused = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.syncWindowVisibility();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  /** Home → Chat → File → Tools, in the header's order. */
  private static readonly TAB_ORDER: IslandViewName[] = ["overview", "prompt", "upload", "tools"];

  /** Which header tab the current view belongs to, or -1 (settings, an alert…). */
  private tabIndex(): number {
    const v = State.view;
    if (v === "overview" || v === "empty" || v === "editor") return 0;
    if (v === "prompt") return 1;
    if (v === "upload" || v === "uploading") return 2;
    if (v === "tools") return 3;
    return -1;
  }

  /**
   * The tab keys switch tabs — unless they would be moving a text cursor. A key
   * with Ctrl, Alt or Win is never typing, so it always works; a plain one (the
   * arrows, by default) works in a text field only while it is empty.
   */
  private tabKeyApplies(e: KeyboardEvent, combo: string): boolean {
    if (State.mode !== "expanded") return false;
    if (this.tabIndex() < 0 || UploadSeq.isActive) return false;
    const el = e.target as HTMLElement | null;
    if (el?.isContentEditable) return false;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return !isBare(combo) || el.value === "";
    }
    return true;
  }

  private stepTab(delta: number) {
    const order = Island.TAB_ORDER;
    const next = order[(this.tabIndex() + delta + order.length) % order.length];
    Sound.play("blip");
    this.setView(next);
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.dragSession = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        this.dragSession = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  // ── Snip and paste ──────────────────────────────────────────────────────────

  /**
   * The Snip button. The island gets out of the way first so it isn't in the
   * picture, then Windows' snipping overlay takes over; snip.rs saves the
   * result and sends `snip-ready`, which opens the island on it.
   */
  async snip() {
    if (State.paused) return;
    this.fsm.forceHidden();
    try {
      await Bridge.snipStart();
    } catch (err) {
      this.showNote(String(err).replace(/^Error:\s*/, ""));
    }
  }

  private watchSnipsAndPastes() {
    void onEvent<{ name: string; path: string }>("snip-ready", (file) => {
      if (State.paused) return;
      this.alert("upload");
      UploadSeq.enterZone(USC.REST_X, USC.REST_Y - 14);
      this.swallowWith(file.name, file.path, () => Promise.resolve(file));
    });
    void onEvent<string>("snip-ended", (err) => {
      if (err) this.showNote(err);
    });
    // Ctrl+V with a picture or file on the clipboard (a snip from
    // Win+Shift+S, a copied file): Mochi takes it like a drop. Plain text is
    // left alone for the chat field.
    window.addEventListener("paste", (e) => {
      const file = e.clipboardData?.files[0];
      if (!file || State.paused) return;
      e.preventDefault();
      if (State.view !== "upload") this.setView("upload");
      UploadSeq.enterZone(USC.REST_X, USC.REST_Y - 14);
      this.swallowFile(file);
    });
  }

  private showNote(message: string) {
    State.noteMessage = message;
    this.alert("note");
    Sound.play("error");
    window.setTimeout(() => {
      if (State.view === "note") this.setView(State.defaultView());
    }, 2400);
  }

  /**
   * Drops WebView2 delivers to the page as HTML drag-and-drop. On current
   * runtimes this is how most drops arrive (see platform::allow_webview_drops);
   * they feed the same handler as Tauri's drag events.
   *
   * Only the island itself is a drop zone, never the empty panel around it:
   * outside it the drag is refused, so the file is not taken.
   */
  private watchPageDrops() {
    const MARGIN = 28;
    let inside = false;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const overIsland = (e: DragEvent) => {
      const r = this.islandEl.getBoundingClientRect();
      return (
        r.width > 0 &&
        e.clientX >= r.left - MARGIN &&
        e.clientX <= r.right + MARGIN &&
        e.clientY >= r.top - MARGIN &&
        e.clientY <= r.bottom + MARGIN
      );
    };
    const track = (e: DragEvent): boolean => {
      const now = overIsland(e);
      if (now !== inside) {
        inside = now;
        this.onDragDrop({ type: now ? "enter" : "leave" });
      }
      return now;
    };
    const accept = (e: DragEvent) => {
      // Without preventDefault the drop is refused, which is what we want
      // anywhere but over the island.
      if (!hasFiles(e) || !track(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    window.addEventListener("dragenter", accept);
    window.addEventListener("dragover", accept);
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      // Leaving the window altogether reports (0, 0) or no related target.
      if (e.relatedTarget === null && inside) {
        inside = false;
        this.onDragDrop({ type: "leave" });
      }
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!inside) return;
      inside = false;
      const file = e.dataTransfer?.files[0];
      void Bridge.log(`drag drop (page) ${e.dataTransfer?.files.length ?? 0} file(s)`);
      if (State.paused) return;
      State.fileDragOver = false;
      this.dragSession = false;
      if (!file) {
        this.engine.animateMorph(0);
        this.setView(State.defaultView());
        return;
      }
      this.swallowFile(file);
    });
  }

  /** A file drag has entered the island and has not ended yet. */
  private dragSession = false;

  /**
   * The mouse button came up somewhere on screen. A drag that ended outside the
   * island (dropped elsewhere, or cancelled with Escape) never sends us a drop,
   * so without this the drop card would wait forever. Over the island the drop
   * event is on its way; if it never comes, give it a moment and then let go.
   */
  private onPointerUp() {
    if (!this.dragSession) return;
    if (State.fileDragOver) {
      window.setTimeout(() => {
        if (this.dragSession && !UploadSeq.dropped) this.endDragSession();
      }, 700);
      return;
    }
    this.endDragSession();
  }

  private endDragSession() {
    this.dragSession = false;
    if (UploadSeq.dropped) return;
    State.fileDragOver = false;
    this.engine.animateMorph(0);
    // Leaving the upload view also stops the sequence (see setView).
    if (State.view === "upload") this.setView(State.defaultView());
    if (!this.wasInIsland) this.fsm.mouseLeft();
    State.notify();
  }

  /**
   * "Choose a file…" (drop card, tray). Opens on the drop card so there is
   * somewhere for the file to land, keeps it open while the dialog is up — the
   * cursor is over the dialog, not the island — then runs the same swallow
   * sequence a drop does.
   */
  async openPicker() {
    if (State.paused || this.picking) return;
    this.picking = true;
    this.fsm.pinned = true;
    if (State.mode !== "expanded" || State.view !== "upload") this.alert("upload");
    const path = await Bridge.pickFile();
    this.picking = false;
    this.fsm.pinned = State.isPinned;
    if (!path || State.paused) {
      // Cancelled: back to the normal auto-close countdown.
      if (!this.wasInIsland) this.fsm.mouseLeft();
      return;
    }
    // A drop arrives with the sequence already running from the drag; a picked
    // file has no drag, so start it with the cursor resting on Mochi.
    UploadSeq.enterZone(USC.REST_X, USC.REST_Y - 14);
    this.swallow(path);
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    this.swallowWith(name, path, () => Bridge.ingestFile(path));
  }

  /**
   * A file dropped on the page itself (WebView2's own drop, see
   * watchPageDrops): only its contents are known, so they go to the inbox as
   * bytes. Folders and unreadable files fail the read and show the note.
   */
  private swallowFile(file: File) {
    const name = file.name || "file";
    this.swallowWith(name, name, async () => {
      const buf = await file.arrayBuffer().catch(() => {
        throw new Error("Folders can't be dropped yet.");
      });
      return Bridge.ingestBytes(name, new Uint8Array(buf));
    });
  }

  private swallowWith(name: string, path: string, ingest: () => Promise<{ name: string; path: string }>) {
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void ingest()
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then the chat once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back. There is nothing else to do with a
    // dropped file, so it goes straight to the chat instead of asking first.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.askAboutFile();
    }
  }

  /** The dropped file becomes the chat's subject, and the chat opens. */
  private askAboutFile() {
    State.promptContext = State.droppedFile
      ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
      : null;
    this.setView("prompt");
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(
      State.mode,
      State.view,
      State.chatHistory.length,
      this.overviewExtra,
      State.chatExpanded,
      State.chatFitHeight,
    );
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    // Square against the screen edge it is anchored to, rounded away from it.
    this.islandEl.style.borderRadius =
      State.settings.position === "bottom" ? `${r}px ${r}px 0 0` : `0 0 ${r}px ${r}px`;
    // The ears grow with the island, and vanish with it, so a shut island
    // leaves nothing behind.
    this.islandEl.dataset.edge = State.settings.position === "bottom" ? "bottom" : "top";
    this.islandEl.style.setProperty("--ear", `${Math.max(0, Math.min(12, r * 0.6, hh / 3, w / 8))}px`);
    this.islandEl.style.transform = `translateX(-50%)`;
    this.applyAnchor();
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: this.islandY(hh), w, h: hh };
    const p = this.pushedRect;
    if (
      Math.abs(p.x - rect.x) > 0.5 ||
      Math.abs(p.y - rect.y) > 0.5 ||
      Math.abs(p.w - rect.w) > 0.5 ||
      Math.abs(p.h - rect.h) > 0.5
    ) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /**
   * Pins the island to the window edge the setting asks for — the edge it
   * springs from. `top` has to be cleared when anchoring to the bottom: with both
   * set the box is over-constrained and stretches instead of keeping its height.
   */
  private applyAnchor() {
    const bottom = State.settings.position === "bottom";
    this.islandEl.style.top = bottom ? "auto" : "0";
    this.islandEl.style.bottom = bottom ? "0" : "auto";
  }

  /**
   * Window-local y of the island's top edge. Anchored to the top of the window in
   * "top" mode; in "bottom" mode it is pushed down so the island's own bottom edge
   * lands on the window's, which is what clears the taskbar. Everything inside the
   * island still draws from its own top-left, so only this offset moves.
   */
  private islandY(h: number): number {
    return State.settings.position === "bottom" ? PANEL_H - h : 0;
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: this.islandY(hh), w, h: hh };
  }

  // ── Window visibility (hidden → no window at all, zero polling) ─────────────

  private syncWindowVisibility() {
    if (this.hideTimer != null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting into the edge, then hide the window:
      // nothing is left under the cursor and nothing polls at all.
      this.hideTimer = window.setTimeout(() => {
        this.hideTimer = null;
        if (State.mode !== "hidden") return;
        this.windowHidden = true;
        void Bridge.setVisible(false);
      }, 420);
    } else if (this.windowHidden) {
      // Bring the window up before the island springs open.
      this.windowHidden = false;
      void Bridge.setVisible(true);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    window.addEventListener("keydown", (e) => {
      const keys = State.settings.keys;
      const combo = comboFromEvent(e);
      if (combo && combo === binding(keys, "island.close")) {
        if (State.mode === "expanded" && !State.isPinned) this.collapse();
      } else if (combo && (combo === binding(keys, "tab.prev") || combo === binding(keys, "tab.next"))) {
        if (this.tabKeyApplies(e, combo)) {
          e.preventDefault();
          this.stepTab(combo === binding(keys, "tab.next") ? 1 : -1);
        }
      }
      State.lastActivity = performance.now();
    });

    // A click inside the island is deliberate: from then on it takes the keyboard
    // (arrows switch tabs, Escape closes it) until it closes. Surfacing on its own
    // never takes focus from what the user is typing in.
    window.addEventListener("pointerdown", () => {
      if (State.mode !== "expanded") return;
      this.userFocused = true;
      // Every click, not just the first: clicking into another app takes the
      // keyboard away while the island stays open, and the next click on it must
      // bring it back or the arrows and Esc would do nothing.
      if (!document.hasFocus()) void Bridge.focusWindow(true);
    });

    void onDragDrop((e) => this.onDragDrop(e));
    void onEvent<null>("pointer-up", () => this.onPointerUp());
    this.watchPageDrops();
    this.watchSnipsAndPastes();

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * Someone is using the island with the keyboard: typing in the chat, or waiting
   * for its reply. The auto-close countdown only means "the mouse left and nothing
   * happened", so it starts over; it runs again once the activity stops.
   */
  private keepOpen() {
    if (State.mode !== "expanded" || this.fsm.state !== "home") return;
    this.fsm.mouseEntered();
    this.homeCollapseAt = null;
    if (!this.wasInIsland && !State.isPinned && !this.picking) {
      this.fsm.mouseLeft();
      this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
    }
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned && !this.picking) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive ||
        // A view mid-animation (the overview's step ticker). Without this the
        // loop could stop between two frames of a scroll and leave two steps
        // drawn on top of each other until something else moved.
        (State.mode === "expanded" && (this.views.get(State.view)?.animating?.() ?? false));

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  /**
   * Island-space y for the avatar's centre: level with the bottom of the
   * newest bubble from Mochi, kept inside the visible part of the log. Null
   * when Mochi hasn't said anything yet (it then sits in its usual place).
   */
  private chatAvatarY(diameter: number): number | null {
    const log = this.views.get("prompt")?.el.querySelector<HTMLElement>(".chat-log");
    const mine = log?.querySelectorAll<HTMLElement>(".bubble.reply, .bubble.typing");
    const last = mine?.[mine.length - 1];
    if (!log || !last) return null;
    const island = this.islandEl.getBoundingClientRect();
    const bubble = last.getBoundingClientRect();
    const view = log.getBoundingClientRect();
    // The body is a little shorter than its diameter; its bottom lines up with
    // the bubble's bottom edge.
    const half = diameter * 0.42;
    const centre = bubble.bottom - island.top - half;
    return clamp(centre, view.top - island.top + half, view.bottom - island.top - half);
  }

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;
    // In the chat, Mochi is the avatar of its own messages, like in Messages:
    // it sits beside the newest reply (or the typing dots), bottom-aligned.
    if (State.mode === "expanded" && State.view === "prompt") {
      const y = this.chatAvatarY(p.diameter);
      if (y != null) this.botCy.target = y;
    }

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    // A full-figure skin is detailed artwork: it must not bounce or snap to whole
    // pixels while the island resizes. It gets springs without overshoot and a
    // canvas that never changes size, with the figure drawn inside it at its exact
    // sub-pixel position. (Mochi keeps its springy, pixel-snapped self.)
    const steady = this.engine.skin != null && "full" in this.engine.skin;
    if (steady !== this.steadyBot) {
      this.steadyBot = steady;
      const [response, damping] = steady ? [0.42, 1] : [0.5, 0.72];
      for (const sp of [this.botCx, this.botCy, this.botSize]) sp.configure(response, damping);
    }
    const w = steady ? STEADY_BOT_PX : Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    const left = this.botCx.value - w / 2;
    const top = this.botCy.value - BOT_OVERHANG / 2 - hCss / 2;
    // In steady mode the canvas sits on a whole device pixel and the leftover
    // fraction is applied when drawing, so the figure itself moves smoothly.
    const snapL = steady ? Math.round(left * dpr) / dpr : left;
    const snapT = steady ? Math.round(top * dpr) / dpr : top;
    this.botCanvas.style.left = `${snapL}px`;
    this.botCanvas.style.top = `${snapT}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    if (steady) {
      const d = Math.min(size, w);
      ctx.translate((w - d) / 2 + (left - snapL), (w - d) / 2 + (top - snapT));
      this.engine.draw(ctx, d, d + BOT_OVERHANG);
    } else {
      this.engine.draw(ctx, w, hCss);
    }
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    const rect = this.islandRect();
    // State.mouse is window-logical, like the rect, so the island's own offset has
    // to be added — without it the eyes only track while the island sits at y = 0.
    const botScreenY = rect.y + this.botCy.value;
    return -Math.tanh((State.mouse.y - botScreenY) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  /** Rows added to the home view (the session chips appear with two sessions). */
  private overviewExtra = 0;

  private syncDom() {
    const expanded = State.mode === "expanded";
    const extra = State.liveSessions.length >= 2 ? 26 : 0;
    if (extra !== this.overviewExtra) {
      const shrinking = extra < this.overviewExtra;
      this.overviewExtra = extra;
      if (State.view === "overview") this.animateGeometry(shrinking);
    }
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat && !this.userFocused) {
        void Bridge.focusWindow(false);
      }
    }

    // Compact mini grid
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  private skinName = "mochi";

  /**
   * Puts the chosen look on the character: Mochi, Ribbon, or a local dev-only
   * skin (src/mochi/local/, see localSkins.ts). Only rebuilt when the choice
   * changes, so the hair keeps its swing across unrelated settings changes.
   * An unknown or unavailable skin falls back to Mochi.
   */
  private applySkin(name: string) {
    if (name === this.skinName) return;
    this.skinName = name;
    const bundle = bundleId(name);
    if (name === "ribbon") {
      this.engine.skin = new RibbonSkin();
    } else if (bundle) {
      // An imported bundle; Mochi stays until it can draw, and if it can't, for good.
      void loadBundle(bundle).then((skin) => {
        if (this.skinName === name) this.engine.skin = skin;
        this.ensureRunning();
      });
    } else if (name === "mochi" || !localSkinNames().includes(name)) {
      this.engine.skin = null;
    } else {
      void loadLocalSkin(name).then((skin) => {
        if (this.skinName === name) this.engine.skin = skin;
        this.ensureRunning();
      });
    }
    this.ensureRunning();
  }

  /** Wears the chosen skin again from scratch (its bundle was just replaced or removed). */
  reloadSkin() {
    const name = State.settings.skin;
    this.skinName = "";
    this.applySkin(name);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    // Character look. A fresh rig only when switching, so the hair keeps its
    // swing across unrelated settings changes.
    this.applySkin(State.settings.skin);
    // Re-anchor and re-push the island rect: changing the screen edge moves the
    // island inside the window, and Rust hit-tests against the rect we send.
    this.applyGeometry();
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
