// Live preview: the real character engine wearing the skin being edited, so
// what you see here is what the island will show — blinks, hops, moods and the
// gaze following your pointer. Runs only while the editor window is visible.

import { BotEngine } from "../mochi/engine";
import { HairSkin } from "../mochi/hair";
import { parseManifest } from "../mochi/manifest";
import type { BotEmoteName, BotStateName } from "../core/layout";
import type { Built } from "./doc";

const SIZE = 220;

export const PREVIEW_MOODS: { label: string; state?: BotStateName; emote?: BotEmoteName; act?: "hop" | "blink" }[] = [
  { label: "Idle", state: "idle" },
  { label: "Working", state: "working" },
  { label: "Needs you", state: "approval" },
  { label: "Error", state: "error" },
  { label: "Done", state: "finished" },
  { label: "Tired", state: "ratelimit" },
  { label: "Asleep", state: "sleeping" },
  { label: "Dizzy", state: "dizzy" },
  { label: "In love", emote: "love" },
  { label: "Proud", emote: "proud" },
  { label: "Wink", emote: "wink" },
  { label: "Annoyed", emote: "annoyed" },
  { label: "Startled", emote: "surprised" },
  { label: "Hop", act: "hop" },
  { label: "Blink", act: "blink" },
];

export class Preview {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private engine = new BotEngine();
  private raf = 0;
  private last = performance.now();
  private build = 0;
  private mouse = { x: 0, y: 0, inside: false };
  /** Shown under the preview when the skin can't be drawn yet. */
  readonly status: HTMLElement;

  constructor() {
    this.canvas = document.createElement("canvas");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = SIZE * dpr;
    this.canvas.height = (SIZE + 40) * dpr;
    this.canvas.style.width = `${SIZE}px`;
    this.canvas.style.height = `${SIZE + 40}px`;
    this.status = document.createElement("div");
    this.status.className = "hint preview-status";
    this.el = document.createElement("div");
    this.el.className = "preview-canvas";
    this.el.append(this.canvas);
    this.engine.particleOverhang = 40;
    this.canvas.addEventListener("pointermove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2, inside: true };
    });
    this.canvas.addEventListener("pointerleave", () => (this.mouse.inside = false));
    // The page also follows the pointer anywhere in the window, like the island does on screen.
    window.addEventListener("pointermove", (e) => {
      if (this.mouse.inside) return;
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - (r.left + r.width / 2);
      this.mouse.y = e.clientY - (r.top + r.height / 2);
    });
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.start()));
    this.start();
  }

  /** Wears a freshly built skin; an older build that finishes late is dropped. */
  async wear(built: Built | null) {
    const n = ++this.build;
    if (!built) {
      this.engine.skin = null;
      this.status.textContent = "Add a picture to see your skin on Mochi here.";
      return;
    }
    const m = parseManifest(built.manifest);
    if (typeof m === "string") {
      this.status.textContent = m;
      return;
    }
    const images = new Map<string, ImageBitmap>();
    for (const [name, canvas] of built.pictures) images.set(name, await createImageBitmap(canvas));
    if (n !== this.build) {
      for (const img of images.values()) img.close();
      return;
    }
    const skin = new HairSkin(m, images);
    await skin.ready;
    if (n !== this.build) return;
    this.engine.skin = skin;
    this.status.textContent = "";
  }

  play(mood: (typeof PREVIEW_MOODS)[number]) {
    if (mood.state) {
      this.engine.setPermanentEmote(null);
      this.engine.setState(mood.state, true);
    } else if (mood.emote) {
      this.engine.triggerEmote(mood.emote, 2.4);
    } else if (mood.act === "hop") {
      this.engine.squash();
    } else if (mood.act === "blink") {
      this.engine.blink();
    }
  }

  private start() {
    if (this.raf) return;
    this.last = performance.now();
    const frame = (t: number) => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.tick(dt);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick(dt: number) {
    const e = this.engine;
    e.lookX = Math.tanh(this.mouse.x / 260);
    e.lookY = Math.tanh(this.mouse.y / 260);
    e.update(dt);
    const x = this.canvas.getContext("2d")!;
    const dpr = this.canvas.width / SIZE;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, SIZE, SIZE + 40);
    // The engine draws at the size the island gives it; the preview is a big island.
    const d = SIZE * 0.82;
    x.translate((SIZE - d) / 2, (SIZE - d) / 2);
    e.draw(x, d, d + 40);
  }
}
