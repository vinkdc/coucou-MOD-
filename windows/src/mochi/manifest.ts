// The manifest of a skin bundle (see docs/SKINS.md): which pictures are hair,
// how each moves, and where they sit on Mochi's head. HairSkin (hair.ts) draws
// them. The manifest comes from a file the user imported, so everything in it is
// checked and clamped here; a malformed one is refused, never half-drawn.

import { clamp, type Pt } from "./puppet";

/** The manifest format this build reads; older bundles drew a whole figure and are refused. */
export const FORMAT = 2;

/**
 * `back` hair sits behind Mochi's body; `front` hair lies over it, under the eyes;
 * `top` is drawn over everything, eyes included (glasses, a mask).
 */
export type Role = "back" | "front" | "top";

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
  /** Back layers: how far they slide against the head turn. Top layers: how closely they follow the eyes (1 = glasses). */
  parallax: number;
  behavior: Behavior;
}

export interface Fit {
  /** Picture px per Mochi radius across, and down (squeezes the hair onto Mochi's squat head). */
  width: number;
  height: number;
  /** Picture x of the face's middle and picture y of the eye line: they land on Mochi's. */
  centerX: number;
  eyeLine: number;
}

export interface Manifest {
  id: string;
  name: string;
  persona: string;
  size: { w: number; h: number };
  crop: { x: number; y: number; w: number; h: number };
  layers: LayerDef[];
  springs: Record<string, SpringDef>;
  fit: Fit;
  /** Body colour as #rrggbb; empty = Mochi's own grey. */
  skinColor: string;
}

/** The values the bundled rigs were tuned with. */
const DEFAULT_SPRINGS: Record<string, SpringDef> = {
  hair: { k: 30, c: 3.6, max: 0.32, idle: [0.035, 1.1], yaw: -2.6, tilt: -3.6, oy: 2.0, sy: 2.0 },
  bow: { k: 260, c: 11, max: 0.4, idle: [0, 1], yaw: 0, tilt: 0, oy: -18, sy: 14 },
  locks: { k: 70, c: 6, max: 0.08, idle: [0.015, 1.4], yaw: -1.6, tilt: -2.4, oy: 1.0, sy: 0 },
};

const num = (v: unknown, fallback: number, lo = -1e5, hi = 1e5): number =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

const pt = (v: unknown, fallback: Pt = [0, 0]): Pt =>
  Array.isArray(v) && v.length >= 2 ? [num(v[0], fallback[0]), num(v[1], fallback[1])] : fallback;

const str = (v: unknown, max = 80): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Reads a manifest, or says what is wrong with it. */
export function parseManifest(raw: unknown): Manifest | string {
  const m = raw as Record<string, any> | null;
  if (!m || typeof m !== "object") return "the manifest is not an object";
  if (m.format === 1) return "this skin was made for the old full-figure format; make it again in the skin editor";
  if (m.format !== FORMAT) return "unsupported manifest format";
  const size = { w: num(m.size?.w, 0, 1, 4096), h: num(m.size?.h, 0, 1, 4096) };
  if (!size.w || !size.h) return "size.w and size.h are required";
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
    const role: Role = l.role === "back" ? "back" : l.role === "top" ? "top" : "front";
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
    layers.push({ id: str(l.id, 24), src: l.src, role, parallax: num(l.parallax, role === "back" ? 0.35 : role === "top" ? 1 : 0, -2, 2), behavior });
  }

  return {
    id: str(m.id, 32),
    name: str(m.name, 40),
    persona: str(m.persona, 2000).trim(),
    size,
    crop,
    layers,
    springs,
    skinColor: typeof m.skinColor === "string" && /^#[0-9a-f]{6}$/i.test(m.skinColor.trim()) ? m.skinColor.trim().toLowerCase() : "",
    // Without a fit, the proportions of the bundled example (a 512 px picture).
    fit: {
      width: num(m.fit?.width, size.w * 0.29, 20, 4000),
      height: num(m.fit?.height, num(m.fit?.width, size.w * 0.29, 20, 4000) * 4 / 3, 20, 4000),
      centerX: num(m.fit?.centerX, size.w / 2),
      eyeLine: num(m.fit?.eyeLine, size.h * 0.63),
    },
  };
}
