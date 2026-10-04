// RigSkin — draws any imported skin bundle (see docs/SKINS.md). The bundle is
// data only: a manifest that says where the head, hair, eyes and pivots are in
// its pictures. This file turns that into the same cut-out puppet the engine
// drives for every full-figure skin: hops, squash, tilt, a parallax head turn,
// springs on the hair, bow and locks, irises that follow the cursor, painted
// eyelids for blinks. Expressions borrow Mochi's eye shapes.
//
// The manifest comes from a file the user imported, so everything in it is
// checked and clamped here; a malformed one is refused, never half-drawn.

import { Layer, Spring, clamp, drawBent, type BendSpec, type Pt } from "./puppet";
import type { DrawEye, FullPose, FullSkin, SkinPose } from "./skin";

// ── Manifest ──────────────────────────────────────────────────────────────────

export type Role = "back" | "head" | "front";

export interface SpringDef {
  k: number;
  c: number;
  /** The most the spring may swing (radians, or squash amount). */
  max: number;
  /** Gentle idle sway: [amplitude, frequency]. */
  idle: readonly [number, number];
  /** How much each engine motion pushes it. */
  yaw: number;
  tilt: number;
  oy: number;
  sy: number;
}

export type Behavior =
  | { type: "none" }
  | { type: "bend"; root: Pt; tipY: number; bounds: readonly [number, number, number, number]; cols: number; rows: number; spring: string }
  | { type: "pivot"; pivot: Pt; spring: string; rotate: number; squash: Pt | null; squashSpring: string };

export interface LayerDef {
  id: string;
  src: string;
  role: Role;
  /** How far it slides against the head turn (back layers). */
  parallax: number;
  behavior: Behavior;
}

export interface EyeDef {
  cx: number;
  cy: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  sd: number;
}

export interface Manifest {
  id: string;
  name: string;
  persona: string;
  size: { w: number; h: number };
  head: { cx: number; cy: number; r: number };
  crop: { x: number; y: number; w: number; h: number };
  chin: number;
  tiltPivot: Pt;
  layers: LayerDef[];
  eyes: EyeDef[];
  iris: { src: string; follow: number } | null;
  /** Pictures that replace the face for an expression (Mochi's eye names: happy, closed, heart…). */
  expressions: Record<string, string>;
  /** The face area [x0, y0, x1, y1] painted over with `lid` before an expression picture goes on. */
  cover: readonly [number, number, number, number] | null;
  /** "rect" for pixel art; "oval" (soft-edged) suits painted faces. */
  coverShape: "rect" | "oval";
  lid: string;
  lash: string;
  cheeks: Pt[];
  blush: { rx: number; ry: number; color: string };
  springs: Record<string, SpringDef>;
}

/** The values the bundled Monika rig was tuned with. */
const DEFAULT_SPRINGS: Record<string, SpringDef> = {
  hair: { k: 30, c: 3.6, max: 0.32, idle: [0.035, 1.1], yaw: -2.6, tilt: -3.6, oy: 2.0, sy: 2.0 },
  bow: { k: 260, c: 11, max: 0.4, idle: [0, 1], yaw: 0, tilt: 0, oy: -18, sy: 14 },
  locks: { k: 70, c: 6, max: 0.08, idle: [0.015, 1.4], yaw: -1.6, tilt: -2.4, oy: 1.0, sy: 0 },
};

/** Mochi's eye names, as the engine uses them (EyeShape). */
const EXPRESSIONS = new Set(["pill", "wide", "dot", "line", "flat", "happy", "closed", "spiral", "heart", "star", "tired", "wink", "cup"]);

const num = (v: unknown, fallback: number, lo = -1e5, hi = 1e5): number =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

const pt = (v: unknown, fallback: Pt = [0, 0]): Pt =>
  Array.isArray(v) && v.length >= 2 ? [num(v[0], fallback[0]), num(v[1], fallback[1])] : fallback;

/** Only plain colours: the value goes straight into a canvas fill. */
const colour = (v: unknown, fallback: string): string =>
  typeof v === "string" && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(v.trim()) ? v.trim() : fallback;

const str = (v: unknown, max = 80): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Reads a manifest, or says what is wrong with it. */
export function parseManifest(raw: unknown): Manifest | string {
  const m = raw as Record<string, any> | null;
  if (!m || typeof m !== "object") return "the manifest is not an object";
  if (m.format !== 1) return "unsupported manifest format";
  const size = { w: num(m.size?.w, 0, 1, 4096), h: num(m.size?.h, 0, 1, 4096) };
  if (!size.w || !size.h) return "size.w and size.h are required";
  const head = { cx: num(m.head?.cx, NaN), cy: num(m.head?.cy, NaN), r: num(m.head?.r, NaN, 1, 1e4) };
  if (Object.values(head).some(Number.isNaN)) return "head needs cx, cy and r";
  const crop = {
    x: num(m.crop?.x, 0, 0, size.w - 1),
    y: num(m.crop?.y, 0, 0, size.h - 1),
    w: 0,
    h: 0,
  };
  crop.w = num(m.crop?.w, size.w - crop.x, 1, size.w - crop.x);
  crop.h = num(m.crop?.h, size.h - crop.y, 1, size.h - crop.y);

  const springs: Record<string, SpringDef> = { ...DEFAULT_SPRINGS };
  for (const [name, s] of Object.entries((m.springs ?? {}) as Record<string, any>).slice(0, 8)) {
    const base = DEFAULT_SPRINGS[name] ?? DEFAULT_SPRINGS.hair;
    springs[name] = {
      k: num(s?.k, base.k, 1, 1000),
      c: num(s?.c, base.c, 0, 100),
      max: num(s?.max, base.max, 0, 1),
      idle: Array.isArray(s?.idle) ? [num(s.idle[0], 0, 0, 0.2), num(s.idle[1], 1, 0.1, 10)] : base.idle,
      yaw: num(s?.yaw, base.yaw, -50, 50),
      tilt: num(s?.tilt, base.tilt, -50, 50),
      oy: num(s?.oy, base.oy, -50, 50),
      sy: num(s?.sy, base.sy, -50, 50),
    };
  }
  const springName = (v: unknown) => (typeof v === "string" && springs[v] ? v : "hair");

  if (!Array.isArray(m.layers) || m.layers.length === 0 || m.layers.length > 16) return "layers must hold 1 to 16 pictures";
  const layers: LayerDef[] = [];
  for (const l of m.layers as Record<string, any>[]) {
    if (typeof l?.src !== "string") return "every layer needs a src";
    const role: Role = l.role === "back" || l.role === "front" ? l.role : "head";
    const b = l.behavior;
    let behavior: Behavior = { type: "none" };
    if (b?.type === "bend") {
      const root = pt(b.root);
      const bb = Array.isArray(b.bounds) && b.bounds.length === 4 ? b.bounds : [0, 0, size.w, size.h];
      behavior = {
        type: "bend",
        root,
        tipY: num(b.tipY, size.h),
        bounds: [num(bb[0], 0), num(bb[1], 0), num(bb[2], size.w), num(bb[3], size.h)],
        cols: Math.round(num(b.grid?.[0], 4, 1, 12)),
        rows: Math.round(num(b.grid?.[1], 8, 1, 16)),
        spring: springName(b.spring),
      };
    } else if (b?.type === "pivot") {
      behavior = {
        type: "pivot",
        pivot: pt(b.pivot),
        spring: springName(b.spring),
        rotate: num(b.rotate, 1, -2, 2),
        squash: b.squash ? [num(b.squash.x ?? b.squash[0], 0, -1, 1), num(b.squash.y ?? b.squash[1], 0, -1, 1)] : null,
        squashSpring: springName(b.squashSpring ?? b.spring),
      };
    }
    layers.push({ id: str(l.id, 24), src: l.src, role, parallax: num(l.parallax, role === "back" ? 0.35 : 0, -2, 2), behavior });
  }
  if (!layers.some((l) => l.role === "head")) return "at least one layer must have role \"head\"";

  const eyes: EyeDef[] = (Array.isArray(m.eyes) ? m.eyes : []).slice(0, 2).map((e: any) => ({
    cx: num(e?.cx, 0), cy: num(e?.cy, 0), x0: num(e?.x0, 0), x1: num(e?.x1, 0),
    top: num(e?.top, 0), bottom: num(e?.bottom, 0), sd: e?.sd === 1 ? 1 : -1,
  }));

  return {
    id: str(m.id, 32),
    name: str(m.name, 40),
    persona: str(m.persona, 2000).trim(),
    size,
    head,
    crop,
    chin: num(m.chin, head.cy + head.r * 0.7),
    tiltPivot: pt(m.tiltPivot, [head.cx, head.cy + head.r * 0.7]),
    layers,
    eyes,
    expressions: Object.fromEntries(
      Object.entries((m.expressions ?? {}) as Record<string, unknown>)
        .filter(([k, v]) => EXPRESSIONS.has(k) && typeof v === "string")
        .slice(0, 16),
    ) as Record<string, string>,
    coverShape: m.coverShape === "oval" ? "oval" : "rect",
    cover: Array.isArray(m.cover) && m.cover.length === 4
      ? [num(m.cover[0], 0), num(m.cover[1], 0), num(m.cover[2], 0), num(m.cover[3], 0)]
      : null,
    iris: typeof m.iris?.src === "string" ? { src: m.iris.src, follow: num(m.iris.follow, 30, 0, 80) } : null,
    lid: colour(m.lid, "rgb(255, 246, 224)"),
    lash: colour(m.lash, "rgb(35, 22, 26)"),
    cheeks: (Array.isArray(m.cheeks) ? m.cheeks : []).slice(0, 4).map((c: unknown) => pt(c)),
    blush: {
      rx: num(m.blush?.rx, 50, 1, 400),
      ry: num(m.blush?.ry, 34, 1, 400),
      color: colour(m.blush?.color, "rgba(255, 140, 155, 1)"),
    },
    springs,
  };
}

/** Paints over the drawn face before an expression picture goes on. */
export function paintCover(
  x: CanvasRenderingContext2D,
  [x0, y0, x1, y1]: readonly [number, number, number, number],
  shape: "rect" | "oval",
  colour: string,
) {
  if (shape === "rect") {
    x.fillStyle = colour;
    x.fillRect(x0, y0, x1 - x0, y1 - y0);
    return;
  }
  // An oval whose edge fades out, so it blends into the face instead of reading as a patch.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  x.save();
  x.translate(cx, cy);
  x.scale(1, ry / rx);
  // Full strength inside, fading to nothing over the outer quarter.
  const fill = x.createRadialGradient(0, 0, rx * 0.72, 0, 0, rx);
  fill.addColorStop(0, colour);
  fill.addColorStop(1, transparentOf(colour));
  x.fillStyle = fill;
  x.beginPath();
  x.arc(0, 0, rx, 0, Math.PI * 2);
  x.fill();
  x.restore();
}

/** The same colour with no opacity (a gradient to plain "transparent" greys out). */
function transparentOf(colour: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, 0)`;
  }
  const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(colour);
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, 0)` : "rgba(0,0,0,0)";
}

// ── The skin ──────────────────────────────────────────────────────────────────

interface Drawn {
  def: LayerDef;
  layer: Layer;
}

export class RigSkin implements FullSkin {
  readonly full = true as const;
  readonly ready: Promise<void>;

  private drawn: Drawn[] = [];
  private irisLayer: Layer | null = null;
  private faces = new Map<string, Layer>();
  private springs = new Map<string, Spring>();
  /** The gaze, low-passed: a hovering cursor sends tiny jittery steps. */
  private gazeX = new Spring(36, 12);
  private gazeY = new Spring(36, 12);
  /** The eyes follow faster than the head: they lead, the head catches up. */
  private eyeX = new Spring(160, 25);
  private eyeY = new Spring(160, 25);
  private scale = 1;
  private last: SkinPose | null = null;
  private lastReal = 0;
  private t = Math.random() * 10;

  constructor(private m: Manifest, images: Map<string, ImageBitmap>) {
    for (const [name, d] of Object.entries(m.springs)) this.springs.set(name, new Spring(d.k, d.c));
    this.ready = Promise.resolve().then(() => {
      const make = (src: string) => {
        const img = images.get(src);
        if (!img) throw new Error(`missing picture ${src}`);
        return new Layer(img, m.crop);
      };
      this.drawn = m.layers.map((def) => ({ def, layer: make(def.src) }));
      if (m.iris) this.irisLayer = make(m.iris.src);
      for (const [shape, src] of Object.entries(m.expressions)) this.faces.set(shape, make(src));
      for (const img of images.values()) img.close();
    });
  }

  update(p: SkinPose, dt: number) {
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 30);
    this.t += dt;
    // The island stops its animation loop when nothing moves and restarts it on
    // a view change. After such a pause the stored pose is stale, and the
    // difference to it would read as a violent jolt: start again from here.
    const real = performance.now();
    const paused = real - this.lastReal > 120;
    this.lastReal = real;
    const prev = paused ? p : this.last ?? p;
    if (paused) {
      this.gazeX.v = this.eyeX.v = Math.sin(p.yaw);
      this.gazeY.v = this.eyeY.v = p.pitch;
      this.gazeX.vel = this.gazeY.vel = this.eyeX.vel = this.eyeY.vel = 0;
    }
    // Changes too small to mean anything (pixel noise from the cursor poll) are ignored.
    const dead = (target: number, cur: number) => (Math.abs(target - cur) < 0.02 ? cur : target);
    this.gazeX.step(dead(Math.sin(p.yaw), this.gazeX.v), 0, dt);
    this.gazeY.step(dead(p.pitch, this.gazeY.v), 0, dt);
    this.eyeX.step(dead(Math.sin(p.yaw), this.eyeX.v), 0, dt);
    this.eyeY.step(dead(p.pitch, this.eyeY.v), 0, dt);
    const dYaw = this.gazeX.vel;
    // Speeds are capped so one odd frame can never fling the hair.
    const dTilt = clamp((p.tilt - prev.tilt) / dt, -2, 2);
    const dOy = clamp((p.oy - prev.oy) / dt, -3, 3);
    const dSy = clamp((p.sy - prev.sy) / dt, -3, 3);
    this.last = { ...p };

    for (const [name, spring] of this.springs) {
      const d = this.m.springs[name];
      const rest = Math.sin(this.t * d.idle[1]) * d.idle[0];
      spring.step(rest, dYaw * d.yaw + dTilt * d.tilt + dOy * d.oy + dSy * d.sy, dt);
      spring.v = clamp(spring.v, -d.max, d.max);
    }
  }

  draw(x: CanvasRenderingContext2D, p: FullPose, drawEye: DrawEye) {
    if (!this.drawn.length) return;
    const m = this.m;
    const k = (p.R * 1.05) / m.head.r; // canvas px per picture px
    const scale = k * (x.getTransform().a || 1);
    this.scale = scale;
    // Head turn as parallax: the head slides, the hair behind it slides back.
    const turn = this.gazeX.v * 20;
    const nod = this.gazeY.v * 14;
    const spring = (name: string) => this.springs.get(name)?.v ?? 0;

    x.save();
    // Into picture coordinates; the head sits a little above the body's centre
    // (the engine keeps room above for particles, hair needs room below).
    x.translate(p.cx, p.cy - p.R * 0.3);
    x.scale(k, k);
    x.translate(-m.head.cx, -m.head.cy);
    // Tilt around the neck; squash from the chin, like Mochi squashes from its base.
    x.translate(m.tiltPivot[0], m.tiltPivot[1]);
    if (p.tilt) x.rotate(p.tilt);
    x.translate(-m.tiltPivot[0], -m.tiltPivot[1]);
    x.translate(m.head.cx, m.chin);
    x.scale(p.sx, p.sy);
    x.translate(-m.head.cx, -m.chin);

    const lastHead = this.drawn.map((d) => d.def.role).lastIndexOf("head");
    this.drawn.forEach(({ def, layer }, i) => {
      x.save();
      if (def.role === "back") x.translate(-turn * def.parallax, 0);
      else x.translate(turn, nod);
      const b = def.behavior;
      if (b.type === "bend") {
        drawBent(x, layer, scale, spring(b.spring), { root: b.root, tipY: b.tipY, bounds: b.bounds, cols: b.cols, rows: b.rows } as BendSpec);
      } else {
        if (b.type === "pivot") {
          const v = spring(b.spring);
          x.translate(b.pivot[0], b.pivot[1]);
          x.rotate(v * b.rotate);
          if (b.squash) {
            const q = spring(b.squashSpring);
            x.scale(1 + q * b.squash[0], 1 - q * b.squash[1]);
          }
          x.translate(-b.pivot[0], -b.pivot[1]);
        }
        layer.draw(x, scale);
      }
      if (i === lastHead) this.drawFace(x, p, drawEye, layer);
      x.restore();
    });
    x.restore();
  }

  /** Eyelids, expression eyes and blush over the picture's own face. */
  private drawFace(x: CanvasRenderingContext2D, p: FullPose, drawEye: DrawEye, face: Layer) {
    const m = this.m;
    const open = p.eye === "pill" || p.eye === "wide";

    // A skin with drawn expressions (pixel art, say) swaps the whole face area
    // for the picture of the current one. A blink or sleep shows "closed".
    if (m.cover && this.faces.size) {
      const key = p.open < 0.5 && this.faces.has("closed") ? "closed" : p.eye;
      const drawn = this.faces.get(key);
      if (drawn) {
        paintCover(x, m.cover, m.coverShape, m.lid);
        drawn.draw(x, this.scale);
        this.drawBlush(x, p);
        return;
      }
    }

    // The irises follow the cursor, sliding inside the eye.
    if (open && this.irisLayer && m.iris) {
      const dx = clamp(this.eyeX.v * m.iris.follow, -m.iris.follow / 2, m.iris.follow / 2);
      const dy = clamp(-this.eyeY.v * m.iris.follow * 0.85, -m.iris.follow / 4, m.iris.follow / 4);
      for (const e of m.eyes) {
        x.save();
        x.beginPath();
        x.ellipse(e.cx, (e.top + e.bottom) / 2, (e.x1 - e.x0) * 0.58, (e.bottom - e.top) * 0.52, 0, 0, Math.PI * 2);
        x.clip();
        x.translate(dx, dy);
        this.irisLayer.draw(x, this.scale);
        x.restore();
      }
    }

    for (const e of m.eyes) {
      const w = e.x1 - e.x0;
      const h = e.bottom - e.top;
      if (p.eye === "closed") {
        // Asleep: the eye squeezed fully shut, the same as the end of a blink.
        this.squeezeEye(x, e, 1, face);
        continue;
      }
      if (!open) {
        // Cover the drawn eye with skin and draw Mochi's expression in its place.
        x.fillStyle = m.lid;
        x.beginPath();
        x.ellipse(e.cx, (e.top + e.bottom) / 2, w * 0.6, h * 0.6, 0, 0, Math.PI * 2);
        x.fill();
        x.save();
        x.translate(e.cx, e.cy);
        x.fillStyle = m.lash;
        x.strokeStyle = m.lash;
        drawEye(x, p.eye, w * 0.85, h * 0.62, e.sd, m.lash);
        x.restore();
        continue;
      }
      const shut = 1 - clamp(p.open, 0, 1);
      if (shut < 0.04) continue;
      this.squeezeEye(x, e, shut, face);
    }

    this.drawBlush(x, p);
  }

  /**
   * A blink the way hand-drawn characters do it: the eye isn't wiped over, it is
   * squeezed towards the line where the lids meet (a little below the middle),
   * and the skin closes in from above and below. Fully shut, only a soft
   * downward curve of lashes is left.
   */
  private squeezeEye(x: CanvasRenderingContext2D, e: EyeDef, shut: number, face: Layer) {
    const m = this.m;
    const w = e.x1 - e.x0;
    const h = e.bottom - e.top;
    const meet = e.top + h * 0.62;
    const yTop = e.top + (meet - e.top) * shut;
    const yBot = e.bottom - (e.bottom - meet) * shut;
    // Slightly larger than the eye box, so lashes drawn at its edge come along.
    const padX = w * 0.08, padY = h * 0.08;
    const sx0 = e.x0 - padX, sy0 = e.top - padY, sw = w + padX * 2, sh = h + padY * 2;
    const dy0 = yTop - padY * (1 - shut);
    const dh = Math.max(0, yBot - yTop + padY * 2 * (1 - shut));

    x.save();
    x.beginPath();
    x.ellipse(e.cx, (e.top + e.bottom) / 2, w * 0.6, h * 0.6, 0, 0, Math.PI * 2);
    x.clip();
    x.fillStyle = m.lid;
    x.fillRect(sx0 - 2, sy0 - 2, sw + 4, sh + 4);
    if (dh > 0.5) {
      for (const layer of this.irisLayer ? [face, this.irisLayer] : [face]) {
        const tex = layer.pick(this.scale);
        const ts = tex.width / layer.crop.w;
        x.drawImage(
          tex,
          (sx0 - layer.crop.x) * ts, (sy0 - layer.crop.y) * ts, sw * ts, sh * ts,
          sx0, dy0, sw, dh,
        );
      }
    }
    x.restore();

    // The lashes ride the closing lid; fully shut they read as a gentle curve.
    if (shut > 0.35) {
      x.save();
      x.strokeStyle = m.lash;
      x.lineCap = "round";
      x.globalAlpha = clamp((shut - 0.35) / 0.4, 0, 1);
      x.lineWidth = Math.max(1.5, w * 0.06);
      x.beginPath();
      x.moveTo(e.x0 + w * 0.06, yTop - h * 0.02);
      x.quadraticCurveTo(e.cx, yTop + h * 0.16 * shut, e.x1 - w * 0.06, yTop - h * 0.02);
      x.stroke();
      x.restore();
    }
  }

  private drawBlush(x: CanvasRenderingContext2D, p: FullPose) {
    const m = this.m;
    if (p.blush > 0.05 && m.cheeks.length) {
      x.save();
      x.globalAlpha = 0.45 * Math.min(1, p.blush);
      x.fillStyle = m.blush.color;
      for (const [cx, cy] of m.cheeks) {
        x.beginPath();
        x.ellipse(cx, cy, m.blush.rx, m.blush.ry, 0, 0, Math.PI * 2);
        x.fill();
      }
      x.restore();
    }
  }
}
