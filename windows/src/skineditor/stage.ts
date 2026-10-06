// The editor's canvas: the hair on a checkerboard, with handles to drag. What
// can be dragged depends on what is selected — a picture (move it, resize it,
// set where it swings from) or the fit (a Mochi outline to line the hair up
// with: where its eyes are, how wide and tall its head).

import { pool, bake, type Doc, type Placed } from "./doc";
import type { Pt } from "../mochi/puppet";

export type Focus =
  | { kind: "part"; index: number }
  | { kind: "fit" };

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

// Mochi's proportions, as BotEngine draws them (R = one Mochi radius): the body
// is a squircle 1.14 R across and 0.88 R down from its centre, the eyes sit
// 0.105 R below that centre, 0.41 R to each side, 0.25 R wide and 0.27 R tall.
const BODY_RX = 1.14;
const BODY_RY = 0.88;
const BODY_EXP = 2 / 2.7;
const EYE_DROP = 0.105;
const EYE_SIDE = 0.41;
const EYE_W = 0.25;
const EYE_H = 0.27;

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

  /** The hair as it will look (behind Mochi first), cached until something moves. */
  figure(): HTMLCanvasElement {
    const { doc } = this.get();
    const key = JSON.stringify([doc.w, doc.h, doc.parts]);
    if (this.composite && key === this.compositeKey) return this.composite;
    this.compositeKey = key;
    const order = ["back", "front", "top"].flatMap((role) => doc.parts.filter((p) => p.role === role));
    const c = bake(doc, order, this.composite ?? undefined);
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
    x.imageSmoothingEnabled = true;
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
    } else {
      this.drawMochi(x, doc);
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

  /** Mochi's body and eyes as the hair will meet them, in picture coordinates. */
  private drawMochi(x: CanvasRenderingContext2D, doc: Doc) {
    const { width: kx, height: ky, centerX, eyeLine } = doc.fit;
    const cy = eyeLine - EYE_DROP * ky;
    const body = new Path2D();
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const px = centerX + BODY_RX * kx * (ca >= 0 ? ca ** BODY_EXP : -((-ca) ** BODY_EXP));
      const py = cy + BODY_RY * ky * (sa >= 0 ? sa ** BODY_EXP : -((-sa) ** BODY_EXP));
      if (i === 0) body.moveTo(px, py);
      else body.lineTo(px, py);
    }
    body.closePath();
    x.fillStyle = "rgba(237, 237, 239, 0.16)";
    x.fill(body);
    x.strokeStyle = "rgba(99, 179, 255, 0.9)";
    x.stroke(body);
    x.fillStyle = "rgba(26, 20, 18, 0.7)";
    for (const side of [-1, 1]) {
      x.beginPath();
      x.ellipse(centerX + side * EYE_SIDE * kx, eyeLine, (EYE_W * kx) / 2, (EYE_H * ky) / 2, 0, 0, Math.PI * 2);
      x.fill();
    }
    x.strokeStyle = "rgba(245, 165, 36, 0.9)";
    x.setLineDash([6 / this.zoom, 4 / this.zoom]);
    x.beginPath();
    x.moveTo(centerX - BODY_RX * kx * 1.1, eyeLine);
    x.lineTo(centerX + BODY_RX * kx * 1.1, eyeLine);
    x.stroke();
    x.setLineDash([]);
  }

  // ── Handles ─────────────────────────────────────────────────────────────────

  private handles(): Handle[] {
    const { doc, focus } = this.get();
    const out: Handle[] = [];
    if (!doc.parts.length) return out;
    if (focus.kind === "part") {
      const part = doc.parts[focus.index];
      if (!part) return out;
      const img = pool.get(part.img);
      if (img) {
        const w = img.width * part.scale, h = img.height * part.scale;
        out.push({
          x: part.x + w, y: part.y + h, shape: "square", colour: "#63b3ff", label: "Resize", cursor: "nwse-resize",
          grab: () => ({ x: part.x, y: part.y, scale: part.scale }),
          drag: (nx, ny, s) => {
            const g = s.snapshot as { x: number; y: number; scale: number };
            const scale = Math.max((nx - g.x) / img.width, (ny - g.y) / img.height, 0.02);
            part.scale = Math.min(scale, 8);
          },
        });
      }
      if (part.motion !== "still") {
        out.push(this.point(part.pivot, "#f5a524", part.motion === "bend" ? "Root (stays put)" : "Swings from here"));
        if (part.motion === "bend") {
          out.push({
            x: part.pivot[0], y: part.tipY, shape: "dot", colour: "#f5a524", label: "Tip (moves most)", cursor: "ns-resize",
            drag: (_x, y) => (part.tipY = Math.max(y, part.pivot[1] + 4)),
          });
        }
      }
    } else {
      const f = doc.fit;
      const cy = f.eyeLine - EYE_DROP * f.height;
      out.push({
        x: f.centerX, y: f.eyeLine, shape: "ring", colour: "#63b3ff", label: "Move Mochi (eye line)", cursor: "move",
        drag: (x, y) => {
          f.centerX = x;
          f.eyeLine = y;
        },
      });
      out.push({
        x: f.centerX + BODY_RX * f.width, y: cy, shape: "dot", colour: "#63b3ff", label: "Mochi's width", cursor: "ew-resize",
        drag: (x) => (f.width = Math.max(20, (x - f.centerX) / BODY_RX)),
      });
      out.push({
        x: f.centerX, y: cy + BODY_RY * f.height, shape: "square", colour: "#63b3ff", label: "Mochi's height", cursor: "ns-resize",
        drag: (_x, y) => (f.height = Math.max(20, (y - f.eyeLine) / (BODY_RY - EYE_DROP))),
      });
    }
    return out;
  }

  private point(p: Pt, colour: string, label: string): Handle {
    const m = p as unknown as number[];
    return { x: m[0], y: m[1], shape: "dot", colour, label, cursor: "move", drag: (x, y) => { m[0] = x; m[1] = y; } };
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
    const part = focus.kind === "part" ? doc.parts[focus.index] : null;
    const placed: Placed | null = part;
    const img = placed && pool.get(placed.img);
    if (!part || !placed || !img) return null;
    const p = this.toPic(e);
    const inside = p.x >= placed.x && p.y >= placed.y && p.x <= placed.x + img.width * placed.scale && p.y <= placed.y + img.height * placed.scale;
    if (!inside) return null;
    return {
      x: p.x, y: p.y, shape: "dot", colour: "", cursor: "grabbing",
      grab: () => ({ x: placed.x, y: placed.y, pivot: [...part.pivot], tipY: part.tipY }),
      drag: (x, y, s) => {
        const g = s.snapshot as { x: number; y: number; pivot: number[]; tipY: number };
        const dx = x - s.x, dy = y - s.y;
        placed.x = Math.round(g.x + dx);
        placed.y = Math.round(g.y + dy);
        // The motion points travel with the picture.
        part.pivot = [g.pivot[0] + dx, g.pivot[1] + dy];
        part.tipY = g.tipY + dy;
      },
    };
  }

  // ── Pointer ─────────────────────────────────────────────────────────────────

  private down(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
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
