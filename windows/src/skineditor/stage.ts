// The editor's canvas: the figure on a checkerboard, with handles to drag. What
// can be dragged depends on what is selected — a picture (move it, resize it,
// set where it swings from), the face (head circle, chin, eyes, cheeks, face
// area) or an expression picture (move it over the face area).

import { pool, bake, type Box, type Doc, type Mood, type Placed } from "./doc";
import type { Pt } from "../mochi/puppet";
import { paintCover } from "../mochi/rig";

export type Focus =
  | { kind: "part"; index: number }
  | { kind: "face" }
  | { kind: "expr"; mood: Mood };

interface Handle {
  /** Picture coordinates. */
  x: number;
  y: number;
  shape: "dot" | "square" | "ring";
  colour: string;
  label?: string;
  /** Picture-space drag: new position of the handle. */
  drag(x: number, y: number, start: { x: number; y: number; snapshot: unknown }): void;
  /** Remembers what `drag` needs to move things relative to where they started. */
  grab?(): unknown;
  cursor?: string;
}

const HIT = 9;

export class Stage {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Picture px → screen px, and where the picture's origin is on screen. */
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private fitted = false;
  private composite: HTMLCanvasElement | null = null;
  private compositeKey = "";
  private dragging: { handle: Handle; start: { x: number; y: number; snapshot: unknown } } | null = null;
  private panning: { x: number; y: number; px: number; py: number } | null = null;
  private hover: Handle | null = null;
  /** Set while the colour picker is armed: the next click samples the figure. */
  pickColour: ((hex: string | null) => void) | null = null;

  constructor(
    private get: () => { doc: Doc; focus: Focus },
    /** A drag is about to change the document (undo point). */
    private onBegin: () => void,
    /** The document changed (redraw everything that shows it). */
    private onChange: () => void,
  ) {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d")!;
    this.el = document.createElement("div");
    this.el.className = "stage";
    this.el.append(this.canvas);
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("pointercancel", (e) => this.up(e));
    this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
  }

  /** Fit the whole picture in view. */
  fit() {
    const { doc } = this.get();
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.zoom = Math.min((w - 48) / doc.w, (h - 48) / doc.h);
    this.panX = (w - doc.w * this.zoom) / 2;
    this.panY = (h - doc.h * this.zoom) / 2;
    this.fitted = true;
    this.draw();
  }

  get zoomPercent(): number {
    return Math.round(this.zoom * 100);
  }

  /** Forget the cached figure (pictures or their places changed). */
  invalidate() {
    this.compositeKey = "";
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.el.clientWidth * dpr);
    this.canvas.height = Math.round(this.el.clientHeight * dpr);
    this.canvas.style.width = `${this.el.clientWidth}px`;
    this.canvas.style.height = `${this.el.clientHeight}px`;
    if (!this.fitted) this.fit();
    this.draw();
  }

  private toPic(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.panX) / this.zoom, y: (e.clientY - r.top - this.panY) / this.zoom };
  }

  /** The figure as it will look, cached until something moves. */
  figure(): HTMLCanvasElement {
    const { doc, focus } = this.get();
    const key = JSON.stringify([doc.w, doc.h, doc.pixel, doc.parts, focus.kind === "expr" ? [focus.mood, doc.expressions[focus.mood], doc.cover, doc.lid] : null]);
    if (this.composite && key === this.compositeKey) return this.composite;
    this.compositeKey = key;
    const order = [...doc.parts.filter((p) => p.role === "back"), ...doc.parts.filter((p) => p.role === "head"), ...doc.parts.filter((p) => p.role === "iris"), ...doc.parts.filter((p) => p.role === "front")];
    const c = bake(doc, order, this.composite ?? undefined);
    if (focus.kind === "expr") {
      // What the expression will look like: the face area painted over, the picture on top.
      const x = c.getContext("2d")!;
      const b = doc.cover;
      paintCover(x, [b.x0, b.y0, b.x1, b.y1], doc.pixel ? "rect" : "oval", doc.lid);
      const placed = doc.expressions[focus.mood];
      if (placed) {
        const face = bake(doc, [placed]);
        x.drawImage(face, 0, 0);
      }
    }
    this.composite = c;
    return c;
  }

  draw() {
    const { doc, focus } = this.get();
    const x = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Checkerboard under the picture, so transparency reads as transparency.
    x.save();
    x.translate(this.panX, this.panY);
    const pw = doc.w * this.zoom, ph = doc.h * this.zoom;
    x.fillStyle = "#1a1c20";
    x.fillRect(0, 0, pw, ph);
    x.fillStyle = "#22252a";
    const cell = 12;
    x.beginPath();
    for (let j = 0; j * cell < ph; j++) for (let i = (j % 2); i * cell < pw; i += 2) {
      x.rect(i * cell, j * cell, Math.min(cell, pw - i * cell), Math.min(cell, ph - j * cell));
    }
    x.fill();
    x.imageSmoothingEnabled = !doc.pixel || this.zoom < 1;
    x.drawImage(this.figure(), 0, 0, pw, ph);
    x.restore();

    // Nothing to point at before the first picture.
    if (!doc.parts.length) return;

    // Guides for what is selected.
    x.save();
    x.translate(this.panX, this.panY);
    x.scale(this.zoom, this.zoom);
    const line = 1.5 / this.zoom;
    x.lineWidth = line;
    if (focus.kind === "part") {
      const part = doc.parts[focus.index];
      const img = part && pool.get(part.img);
      if (part && img) {
        x.strokeStyle = "rgba(99, 179, 255, 0.9)";
        x.setLineDash([6 / this.zoom, 4 / this.zoom]);
        x.strokeRect(part.x, part.y, img.width * part.scale, img.height * part.scale);
        x.setLineDash([]);
        if (part.motion === "bend") {
          x.strokeStyle = "rgba(245, 165, 36, 0.9)";
          x.beginPath();
          x.moveTo(part.pivot[0], part.pivot[1]);
          x.lineTo(part.pivot[0], part.tipY);
          x.stroke();
        }
      }
    } else if (focus.kind === "face") {
      const { cx, cy, r } = doc.head;
      x.strokeStyle = "rgba(99, 179, 255, 0.9)";
      x.beginPath();
      x.arc(cx, cy, r, 0, Math.PI * 2);
      x.stroke();
      x.strokeStyle = "rgba(245, 165, 36, 0.9)";
      x.setLineDash([6 / this.zoom, 4 / this.zoom]);
      x.beginPath();
      x.moveTo(cx - r * 1.2, doc.chin);
      x.lineTo(cx + r * 1.2, doc.chin);
      x.stroke();
      x.setLineDash([]);
      x.strokeStyle = "rgba(52, 211, 153, 0.95)";
      for (const e of doc.eyes) {
        x.beginPath();
        x.ellipse((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2, (e.x1 - e.x0) / 2, (e.y1 - e.y0) / 2, 0, 0, Math.PI * 2);
        x.stroke();
      }
      x.fillStyle = "rgba(255, 140, 155, 0.35)";
      for (const [px, py] of doc.cheeks) {
        x.beginPath();
        x.ellipse(px, py, doc.head.r * 0.13, doc.head.r * 0.09, 0, 0, Math.PI * 2);
        x.fill();
      }
      if (Object.keys(doc.expressions).length) this.box(x, doc.cover, "rgba(196, 139, 255, 0.9)");
    } else {
      this.box(x, doc.cover, "rgba(196, 139, 255, 0.9)");
    }
    x.restore();

    // Handles, in screen pixels so they stay the same size at any zoom.
    for (const hd of this.handles()) {
      const sx = this.panX + hd.x * this.zoom, sy = this.panY + hd.y * this.zoom;
      const on = hd === this.hover || hd === this.dragging?.handle;
      x.fillStyle = hd.colour;
      x.strokeStyle = "#0b0c0e";
      x.lineWidth = 2;
      x.beginPath();
      const s = on ? 7 : 5.5;
      if (hd.shape === "square") x.rect(sx - s, sy - s, s * 2, s * 2);
      else x.arc(sx, sy, s, 0, Math.PI * 2);
      x.fill();
      x.stroke();
      if (hd.shape === "ring") {
        x.strokeStyle = hd.colour;
        x.beginPath();
        x.arc(sx, sy, s + 4, 0, Math.PI * 2);
        x.stroke();
      }
      if (hd.label && on) {
        x.font = "500 11px Inter Variable, system-ui, sans-serif";
        const tw = x.measureText(hd.label).width;
        x.fillStyle = "rgba(11, 12, 14, 0.85)";
        x.fillRect(sx + 10, sy - 20, tw + 10, 18);
        x.fillStyle = "#f5f6f8";
        x.fillText(hd.label, sx + 15, sy - 7);
      }
    }
  }

  private box(x: CanvasRenderingContext2D, b: Box, colour: string) {
    x.strokeStyle = colour;
    x.setLineDash([6 / this.zoom, 4 / this.zoom]);
    x.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    x.setLineDash([]);
  }

  // ── Handles ─────────────────────────────────────────────────────────────────

  private handles(): Handle[] {
    const { doc, focus } = this.get();
    const out: Handle[] = [];
    if (!doc.parts.length) return out;
    const placedHandles = (p: Placed, colour: string) => {
      const img = pool.get(p.img);
      if (!img) return;
      const w = img.width * p.scale, h = img.height * p.scale;
      out.push({
        x: p.x + w, y: p.y + h, shape: "square", colour, label: "Resize", cursor: "nwse-resize",
        grab: () => ({ x: p.x, y: p.y, scale: p.scale }),
        drag: (nx, ny, s) => {
          const g = s.snapshot as { x: number; y: number; scale: number };
          const scale = Math.max((nx - g.x) / img.width, (ny - g.y) / img.height, 0.02);
          p.scale = Math.min(scale, 8);
        },
      });
    };
    if (focus.kind === "part") {
      const part = doc.parts[focus.index];
      if (!part) return out;
      placedHandles(part, "#63b3ff");
      if (part.motion !== "still" && part.role !== "iris") {
        out.push(this.point(part.pivot, "#f5a524", part.motion === "bend" ? "Root (stays put)" : "Swings from here"));
        if (part.motion === "bend") {
          out.push({
            x: part.pivot[0], y: part.tipY, shape: "dot", colour: "#f5a524", label: "Tip (moves most)", cursor: "ns-resize",
            drag: (_x, y) => (part.tipY = Math.max(y, part.pivot[1] + 4)),
          });
        }
      }
    } else if (focus.kind === "face") {
      const hd = doc.head;
      out.push({
        x: hd.cx, y: hd.cy, shape: "ring", colour: "#63b3ff", label: "Head centre", cursor: "move",
        drag: (x, y) => {
          hd.cx = x;
          hd.cy = y;
        },
      });
      out.push({
        x: hd.cx + hd.r, y: hd.cy, shape: "dot", colour: "#63b3ff", label: "Head size", cursor: "ew-resize",
        drag: (x, y) => (hd.r = Math.max(4, Math.hypot(x - hd.cx, y - hd.cy))),
      });
      out.push({
        x: hd.cx, y: doc.chin, shape: "square", colour: "#f5a524", label: "Chin (squash and tilt from here)", cursor: "ns-resize",
        drag: (_x, y) => (doc.chin = y),
      });
      doc.eyes.forEach((e, i) => out.push(...this.boxHandles(e, "#34d399", i ? "Right eye" : "Left eye")));
      doc.cheeks.forEach((c, i) => out.push(this.point(c, "#ff8c9b", i ? "Right cheek" : "Left cheek")));
      if (Object.keys(doc.expressions).length) out.push(...this.boxHandles(doc.cover, "#c48bff", "Face area"));
    } else {
      const placed = doc.expressions[focus.mood];
      out.push(...this.boxHandles(doc.cover, "#c48bff", "Face area"));
      if (placed) placedHandles(placed, "#63b3ff");
    }
    return out;
  }

  private point(p: Pt, colour: string, label: string): Handle {
    const m = p as unknown as number[];
    return { x: m[0], y: m[1], shape: "dot", colour, label, cursor: "move", drag: (x, y) => { m[0] = x; m[1] = y; } };
  }

  /** Move by the centre, size by the bottom-right corner. */
  private boxHandles(b: Box, colour: string, label: string): Handle[] {
    return [
      {
        x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, shape: "ring", colour, label, cursor: "move",
        grab: () => ({ ...b }),
        drag: (x, y, s) => {
          const g = s.snapshot as Box;
          const dx = x - s.x, dy = y - s.y;
          b.x0 = g.x0 + dx; b.x1 = g.x1 + dx; b.y0 = g.y0 + dy; b.y1 = g.y1 + dy;
        },
      },
      {
        x: b.x1, y: b.y1, shape: "square", colour, label: `${label} size`, cursor: "nwse-resize",
        drag: (x, y) => {
          b.x1 = Math.max(x, b.x0 + 4);
          b.y1 = Math.max(y, b.y0 + 4);
        },
      },
    ];
  }

  private hit(e: PointerEvent): Handle | null {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best: Handle | null = null, bestD = HIT;
    for (const hd of this.handles()) {
      const d = Math.hypot(this.panX + hd.x * this.zoom - mx, this.panY + hd.y * this.zoom - my);
      if (d <= bestD) {
        best = hd;
        bestD = d;
      }
    }
    return best;
  }

  /** The picture under the pointer, when a picture is selected: dragging it moves it. */
  private bodyDrag(e: PointerEvent): Handle | null {
    const { doc, focus } = this.get();
    const placed = focus.kind === "part" ? doc.parts[focus.index] : focus.kind === "expr" ? doc.expressions[focus.mood] : null;
    const img = placed && pool.get(placed.img);
    if (!placed || !img) return null;
    const p = this.toPic(e);
    const inside = p.x >= placed.x && p.y >= placed.y && p.x <= placed.x + img.width * placed.scale && p.y <= placed.y + img.height * placed.scale;
    if (!inside) return null;
    const part = focus.kind === "part" ? doc.parts[focus.index] : null;
    return {
      x: p.x, y: p.y, shape: "dot", colour: "", cursor: "grabbing",
      grab: () => ({ x: placed.x, y: placed.y, pivot: part ? [...part.pivot] : null, tipY: part?.tipY ?? 0 }),
      drag: (x, y, s) => {
        const g = s.snapshot as { x: number; y: number; pivot: number[] | null; tipY: number };
        const dx = x - s.x, dy = y - s.y;
        placed.x = Math.round(g.x + dx);
        placed.y = Math.round(g.y + dy);
        // The motion points travel with the picture.
        if (part && g.pivot) {
          part.pivot = [g.pivot[0] + dx, g.pivot[1] + dy];
          part.tipY = g.tipY + dy;
        }
      },
    };
  }

  // ── Pointer ─────────────────────────────────────────────────────────────────

  private down(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    if (this.pickColour) {
      const p = this.toPic(e);
      const c = this.figure().getContext("2d", { willReadFrequently: true })!;
      const x = Math.round(p.x), y = Math.round(p.y);
      let hex: string | null = null;
      if (x >= 0 && y >= 0 && x < this.figure().width && y < this.figure().height) {
        const [r, g, b, a] = c.getImageData(x, y, 1, 1).data;
        if (a > 40) hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      }
      const done = this.pickColour;
      this.pickColour = null;
      this.canvas.style.cursor = "";
      done(hex);
      return;
    }
    const handle = e.button === 0 ? this.hit(e) ?? this.bodyDrag(e) : null;
    if (handle) {
      this.onBegin();
      const p = this.toPic(e);
      this.dragging = { handle, start: { x: p.x, y: p.y, snapshot: handle.grab?.() } };
      return;
    }
    // Anything else pans the view.
    this.panning = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
    this.canvas.style.cursor = "grabbing";
  }

  private move(e: PointerEvent) {
    if (this.dragging) {
      const p = this.toPic(e);
      this.dragging.handle.drag(p.x, p.y, this.dragging.start);
      this.invalidate();
      this.onChange();
      return;
    }
    if (this.panning) {
      this.panX = this.panning.px + e.clientX - this.panning.x;
      this.panY = this.panning.py + e.clientY - this.panning.y;
      this.draw();
      return;
    }
    if (this.pickColour) {
      this.canvas.style.cursor = "crosshair";
      return;
    }
    const hd = this.hit(e);
    const body = hd ? null : this.bodyDrag(e);
    if (hd !== this.hover) {
      this.hover = hd;
      this.draw();
    }
    this.canvas.style.cursor = hd?.cursor ?? (body ? "grab" : "default");
  }

  private up(e: PointerEvent) {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.dragging = null;
    this.panning = null;
    this.canvas.style.cursor = "";
    this.draw();
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const before = this.toPic(e);
    this.zoom = Math.min(16, Math.max(0.05, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    // Zoom about the pointer.
    this.panX = mx - before.x * this.zoom;
    this.panY = my - before.y * this.zoom;
    this.draw();
    this.onZoom?.();
  }

  onZoom: (() => void) | null = null;
}
