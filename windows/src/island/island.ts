// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { level as voiceLevel, onVoiceChange, stop as stopVoice } from "../core/voice";
import { BotEngine } from "../mochi/engine";
import { RibbonSkin } from "../mochi/skin";
import { bundleId, loadBundle } from "../mochi/bundles";
import { askInChat } from "../views/chat";
import { binding, comboFromEvent, isBare } from "../core/keys";
import { Greeting } from "../mochi/greeting";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";

const BOT_OVERHANG = 40;
/** Fixed canvas size for full-figure skins (the avatar is at most ~110 px). */
const STEADY_BOT_PX = 128;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

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
  private countdown!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;

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
  private prevViewBeforeConfused: IslandViewName = "home";
  private lastSyncedView: IslandViewName | null = null;
  /** The user clicked inside the island, so it holds the keyboard until it closes. */
  private userFocused = false;

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
    // Mochi pulses with its voice while it plays.
    onVoiceChange((key) => {
      this.engine.speaking = key !== null;
      this.ensureRunning();
    });
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
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
      openStudy: (view) => {
        Sound.play("blip");
        this.openStudy(view);
      },
      blip: () => Sound.play("blip"),
      toggleChatSize: () => {
        const shrinking = State.chatExpanded;
        State.chatExpanded = !shrinking;
        this.animateGeometry(shrinking);
        State.notify();
      },
      ask: (prompt) => {
        State.chatHistory = [];
        void Bridge.chatReset("quick");
        this.setView("prompt");
        window.setTimeout(() => askInChat(prompt), 90);
      },
      startReview: (limit, revealed, fromReminder) => this.openReview(limit, revealed, fromReminder),
      keepOpen: () => this.keepOpen(),
      releasePin: () => {
        State.isPinned = false;
        this.dropPin();
      },
    };

    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    this.clipEl = h("div", { id: "island-clip" }, this.greetingCanvas, this.contentEl);
    this.islandEl = h("div", { id: "island" }, this.clipEl, this.botGlow, this.botCanvas, this.countdown);

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
          this.expand(State.view === "greeting" ? State.defaultView() : State.view);
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
      // Opened by pointing at it: the arrow keys are meant for the island, not
      // for the app underneath (a video, an editor). Closing hands them back.
      if (this.wasInIsland) {
        this.userFocused = true;
        void Bridge.focusWindow(true);
      }
    }
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      this.userFocused = false;
      void Bridge.focusWindow(false);
      // A line still being read aloud belongs to an island that is gone.
      stopVoice();
    }
    if (mode !== "expanded") this.engine.resetMorph();
    this.syncWindowVisibility();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  expand(view: IslandViewName) {
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  /** Today → Ask → Review → Progress, in the header's order. */
  private static readonly TAB_ORDER: IslandViewName[] = ["home", "prompt", "review", "stats"];

  /** Which header tab the current view belongs to, or -1 (settings, an alert…). */
  private tabIndex(): number {
    const v = State.view;
    if (v === "home" || v === "nudge") return 0;
    if (v === "prompt") return 1;
    if (v === "review") return 2;
    if (v === "stats" || v === "study") return 3;
    return -1;
  }

  /**
   * The tab keys switch tabs — unless they would be moving a text cursor. A key
   * with Ctrl, Alt or Win is never typing, so it always works; a plain one (the
   * arrows, by default) works in a text field only while it is empty.
   */
  private tabKeyApplies(e: KeyboardEvent, combo: string): boolean {
    if (State.mode !== "expanded") return false;
    if (this.tabIndex() < 0) return false;
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
    // Passing back through Review keeps the session in progress; only a missing
    // or finished one starts afresh.
    if (next === "review" && (!State.review || State.review.done)) this.openReview(5, false, false);
    else this.setView(next);
  }

  setView(view: IslandViewName) {
    if (State.mode !== "expanded") {
      State.view = view;
      this.fsm.forceHome();
      this.animateGeometry(false);
      State.notify();
      return;
    }
    // The full progress view stays open until it is closed.
    if (view === "study" || State.view === "study") {
      State.isPinned = view === "study";
      this.fsm.pinned = State.isPinned;
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
    // Drive the state machine rather than the mode, or a click on the compact
    // island would do nothing.
    this.fsm.forcePetit();
  }

  /**
   * Open on this view (tray, hotkey, reminders). The study panel is the one
   * view that stays open until it is closed: it is where you work, not a glance.
   */
  alert(view: IslandViewName) {
    State.isPinned = view === "study";
    this.fsm.pinned = State.isPinned;
    State.view = view;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** Opens a tab from outside (tray, second launch): "chat", "review" or "stats". */
  openStudy(what?: string) {
    if (what === "review") this.openReview(5, false, false);
    else if (what === "stats") this.alert("study");
    else this.alert("prompt");
  }

  /** Shows a selection's explanation (the lookup hotkey). */
  showLookup(text: string, error?: string) {
    State.lookup = { text, error, token: (State.lookup?.token ?? 0) + 1 };
    this.alert("lookup");
  }

  /** A short review session: from Home, or offered by a reminder. */
  openReview(limit: number, revealed: boolean, fromReminder: boolean) {
    State.review = { limit, revealed, fromReminder, token: (State.review?.token ?? 0) + 1 };
    if (State.mode === "expanded") this.setView("review");
    else this.alert("review");
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length, State.chatExpanded, State.chatFitHeight);
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
    // The ears grow with the island, and vanish with it.
    this.islandEl.dataset.edge = State.settings.position === "bottom" ? "bottom" : "top";
    this.islandEl.style.setProperty("--ear", `${Math.max(0, Math.min(12, r * 0.6, hh / 3, w / 8))}px`);
    this.islandEl.style.transform = `translateX(-50%)`;
    this.islandEl.dataset.view = State.view;
    this.applyAnchor();
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;

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

  /** Pins the island to the window edge the setting asks for — the edge it springs from. */
  private applyAnchor() {
    const bottom = State.settings.position === "bottom";
    this.islandEl.style.top = bottom ? "auto" : "0";
    this.islandEl.style.bottom = bottom ? "0" : "auto";
  }

  /** Window-local y of the island's top edge. */
  private islandY(h: number): number {
    return State.settings.position === "bottom" ? PANEL_H - h : 0;
  }

  /** Island rect in window coordinates. */
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
        // The study panel closes with Esc too, but never while typing in it.
        const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
        if (State.mode === "expanded" && (!State.isPinned || (State.view === "study" && !typing))) this.collapse();
      } else if (combo && (combo === binding(keys, "tab.prev") || combo === binding(keys, "tab.next"))) {
        if (this.tabKeyApplies(e, combo)) {
          e.preventDefault();
          // A held key would race through every tab and queue resize animations.
          if (e.repeat) return;
          this.stepTab(combo === binding(keys, "tab.next") ? 1 : -1);
        }
      }
      State.lastActivity = performance.now();
    });

    // A click inside the island is deliberate: from then on it takes the keyboard
    // until it closes. Surfacing on its own never takes focus.
    const takeKeyboard = () => {
      if (State.mode !== "expanded") return;
      this.userFocused = true;
      if (!document.hasFocus()) void Bridge.focusWindow(true);
    };
    window.addEventListener("pointerdown", takeKeyboard);
    // Moving the mouse over the open island is deliberate too: without this the
    // arrow keys did nothing until the first click.
    window.addEventListener("pointermove", () => {
      if (!this.userFocused) takeKeyboard();
    });

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland).
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /** Someone is using the island with the keyboard: the auto-close countdown starts over. */
  private keepOpen() {
    if (State.mode !== "expanded" || this.fsm.state !== "home") return;
    this.fsm.mouseEntered();
    this.homeCollapseAt = null;
    if (!this.wasInIsland && !State.isPinned) {
      this.fsm.mouseLeft();
      this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
    }
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

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
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

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
      this.drawBot(dt);
    }

    this.views.get(State.view)?.tick?.(nowMs);
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either; geometry still has to finish retracting.
    const settling = this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy ||
        (State.mode === "expanded" && (this.views.get(State.view)?.animating?.() ?? false));

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  /** Island-space y for the avatar's centre: level with the newest reply. */
  private chatAvatarY(diameter: number): number | null {
    const log = this.views.get("prompt")?.el.querySelector<HTMLElement>(".chat-log");
    const mine = log?.querySelectorAll<HTMLElement>(".bubble.reply, .bubble.typing");
    const last = mine?.[mine.length - 1];
    if (!log || !last) return null;
    const island = this.islandEl.getBoundingClientRect();
    const bubble = last.getBoundingClientRect();
    const view = log.getBoundingClientRect();
    const half = diameter * 0.42;
    const centre = bubble.bottom - island.top - half;
    return clamp(centre, view.top - island.top + half, view.bottom - island.top - half);
  }

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;
    if (State.mode === "expanded" && State.view === "prompt") {
      const y = this.chatAvatarY(p.diameter);
      if (y != null) this.botCy.target = y;
    }

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    const visible = p.opacity > 0 && !greetingActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && !greetingActive && p.diameter > 0) {
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
    // pixels while the island resizes.
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
    const snapL = steady ? Math.round(left * dpr) / dpr : left;
    const snapT = steady ? Math.round(top * dpr) / dpr : top;
    this.botCanvas.style.left = `${snapL}px`;
    this.botCanvas.style.top = `${snapT}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    this.engine.bodyColor = null;
    this.engine.voiceLevel = this.engine.speaking ? voiceLevel() : -1;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    this.engine.slotHTarget = 0;
    if (this.engine.morph < 0.05) {
      this.engine.slotH = 0;
      this.engine.slotHVel = 0;
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
    return Math.tanh((State.mouse.x - (rect.x + this.botCx.value)) / 260);
  }

  private lookY(): number {
    const rect = this.islandRect();
    return -Math.tanh((State.mouse.y - (rect.y + this.botCy.value)) / 200);
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

  private syncDom() {
    const expanded = State.mode === "expanded";
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

    // Only the views with a text field (the chat, the study panel) may take the
    // keyboard; surfacing on its own never steals it.
    const takesKeyboard = (v: IslandViewName | null) => v === "prompt";
    // A closed island shows no view, so reopening on the same chat counts as
    // arriving at it again and puts the cursor in the field.
    const shownView = expanded ? State.view : null;
    if (this.lastSyncedView !== shownView) {
      const wasChat = takesKeyboard(this.lastSyncedView);
      this.lastSyncedView = shownView;
      if (shownView && takesKeyboard(shownView)) {
        void Bridge.focusWindow(true);
        const shown = shownView;
        window.setTimeout(() => {
          // If the other app still holds the keyboard, ask once more before focusing the field.
          if (!document.hasFocus()) void Bridge.focusWindow(true);
          window.setTimeout(() => this.views.get(shown)?.focus?.(), 60);
        }, 120);
      } else if (wasChat && expanded && !this.userFocused) {
        void Bridge.focusWindow(false);
      }
    }

    this.engine.setState(State.effectiveState);
  }

  private skinName = "mochi";

  /** Puts the chosen look on the character; an unknown skin falls back to Mochi. */
  private applySkin(name: string) {
    if (name === this.skinName) return;
    this.skinName = name;
    const bundle = bundleId(name);
    if (name === "ribbon") {
      this.engine.skin = new RibbonSkin();
    } else if (bundle) {
      void loadBundle(bundle).then((skin) => {
        if (this.skinName === name) this.engine.skin = skin;
        this.ensureRunning();
      });
    } else {
      this.engine.skin = null;
    }
    this.ensureRunning();
  }

  /** Wears the chosen skin again from scratch (its bundle was just replaced or removed). */
  reloadSkin() {
    const name = State.settings.skin;
    this.skinName = "";
    this.applySkin(name);
  }

  /** Applies settings coming from Rust. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.applySkin(State.settings.skin);
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
