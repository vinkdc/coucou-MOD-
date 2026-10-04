// The skin editor's document: the pictures and where they sit, the face points,
// how each part moves and the expression pictures. Plain data (pictures are
// kept by key in a pool), so undo is a copy of it. From it comes a skin bundle
// exactly like an imported one (docs/SKINS.md): a manifest and full-size PNGs.

import type { Pt } from "../mochi/puppet";

// ── Model ─────────────────────────────────────────────────────────────────────

export type PartRole = "back" | "head" | "front" | "iris";
export type Motion = "still" | "swing" | "bend";
export type Feel = "floppy" | "bouncy" | "subtle";

/** A picture placed on the canvas: top-left corner and scale. */
export interface Placed {
  img: string;
  x: number;
  y: number;
  scale: number;
}

export interface Part extends Placed {
  id: string;
  name: string;
  role: PartRole;
  motion: Motion;
  feel: Feel;
  /** Swings the other way (for the right-hand one of a pair). */
  mirrored: boolean;
  /** Pivot for a swing, root for a bend. */
  pivot: Pt;
  /** Where a bend ends (its tip); the further down, the longer the whip. */
  tipY: number;
  /** The picture as it came in, before its background was removed. */
  original?: string;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Mochi's eye names: every mood and emote shows one of these. */
export const MOODS = [
  ["closed", "Blink / asleep"],
  ["happy", "Happy / done"],
  ["wide", "Surprised / needs you"],
  ["flat", "Error"],
  ["tired", "Tired / rate-limited"],
  ["spiral", "Dizzy"],
  ["heart", "In love"],
  ["star", "Proud"],
  ["wink", "Wink"],
  ["line", "Annoyed"],
  ["dot", "Startled"],
] as const;
export type Mood = (typeof MOODS)[number][0];

export interface Doc {
  name: string;
  author: string;
  note: string;
  persona: string;
  /** Set when editing an installed skin: saving replaces it. */
  id: string | null;
  w: number;
  h: number;
  /** Sharp pixels when a picture is scaled (pixel art). */
  pixel: boolean;
  parts: Part[];
  head: { cx: number; cy: number; r: number };
  chin: number;
  eyes: [Box, Box];
  cheeks: [Pt, Pt];
  /** The face area an expression picture replaces. */
  cover: Box;
  lid: string;
  /** The skin colour follows the eyes until the user picks one. */
  lidAuto: boolean;
  lash: string;
  blush: string;
  expressions: Partial<Record<Mood, Placed>>;
}

/** The pictures, by key. Never part of undo: a key always means the same picture. */
export const pool = new Map<string, ImageBitmap>();
let nextKey = 0;
export function addToPool(img: ImageBitmap): string {
  const key = `img${++nextKey}`;
  pool.set(key, img);
  return key;
}

export const MAX_SIDE = 2048;

export function emptyDoc(): Doc {
  const w = 512, h = 512;
  return {
    name: "",
    author: "",
    note: "",
    persona: "",
    id: null,
    w,
    h,
    pixel: false,
    parts: [],
    head: { cx: w / 2, cy: h / 2, r: w * 0.35 },
    chin: h * 0.8,
    eyes: [
      { x0: w * 0.36, y0: h * 0.42, x1: w * 0.44, y1: h * 0.52 },
      { x0: w * 0.56, y0: h * 0.42, x1: w * 0.64, y1: h * 0.52 },
    ],
    cheeks: [[w * 0.33, h * 0.6], [w * 0.67, h * 0.6]],
    cover: { x0: w * 0.3, y0: h * 0.38, x1: w * 0.7, y1: h * 0.66 },
    lid: "#f2d6c4",
    lidAuto: true,
    lash: "#231a1c",
    blush: "#ff8c9b",
    expressions: {},
  };
}

// ── Pictures ──────────────────────────────────────────────────────────────────

/** Draws placed pictures onto a canvas the size of the document. */
export function bake(doc: Doc, items: Placed[], into?: HTMLCanvasElement): HTMLCanvasElement {
  const c = into ?? document.createElement("canvas");
  c.width = doc.w;
  c.height = doc.h;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.clearRect(0, 0, doc.w, doc.h);
  x.imageSmoothingEnabled = !doc.pixel;
  x.imageSmoothingQuality = "high";
  for (const p of items) {
    const img = pool.get(p.img);
    if (img) x.drawImage(img, p.x, p.y, img.width * p.scale, img.height * p.scale);
  }
  return c;
}

/** Where a canvas has paint: the box around every pixel that isn't (nearly) transparent. */
export function opaqueBox(c: HTMLCanvasElement): Box | null {
  const { width: w, height: h } = c;
  const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** The colour at a point of the composed figure, as #rrggbb (null if empty there). */
export function colourAt(c: HTMLCanvasElement, px: number, py: number): string | null {
  const x = Math.round(px), y = Math.round(py);
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
  const [r, g, b, a] = c.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, 1, 1).data;
  if (a < 40) return null;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** True when all four corners are the same solid colour: a backdrop, not the character. */
export function hasPlainBackground(img: ImageBitmap): boolean {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(img, 0, 0);
  const px = (a: number, b: number) => x.getImageData(a, b, 1, 1).data;
  const corners = [px(0, 0), px(img.width - 1, 0), px(0, img.height - 1), px(img.width - 1, img.height - 1)];
  const [r, g, b] = corners[0];
  return corners.every((p) => p[3] > 250 && Math.abs(p[0] - r) + Math.abs(p[1] - g) + Math.abs(p[2] - b) < 30);
}

/**
 * Makes a flat background transparent: everything joined to the picture's edge
 * that has the edge's colour (within a tolerance) is cleared. Pictures with a
 * white or plain backdrop become cut-outs without an image editor.
 */
export async function removeBackground(img: ImageBitmap, tolerance = 48): Promise<ImageBitmap> {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(img, 0, 0);
  const data = x.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  const w = c.width, h = c.height;
  const at = (i: number) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
  const [br, bg, bb] = at(0);
  const near = (i: number) =>
    d[i * 4 + 3] > 0 &&
    Math.abs(d[i * 4] - br) + Math.abs(d[i * 4 + 1] - bg) + Math.abs(d[i * 4 + 2] - bb) <= tolerance;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < w; i++) stack.push(i, (h - 1) * w + i);
  for (let j = 0; j < h; j++) stack.push(j * w, j * w + w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i] || !near(i)) continue;
    seen[i] = 1;
    d[i * 4 + 3] = 0;
    const px = i % w, py = (i / w) | 0;
    if (px > 0) stack.push(i - 1);
    if (px < w - 1) stack.push(i + 1);
    if (py > 0) stack.push(i - w);
    if (py < h - 1) stack.push(i + w);
  }
  x.putImageData(data, 0, 0);
  return createImageBitmap(c);
}

// ── First picture: a good guess at everything ─────────────────────────────────

/**
 * Called when the first picture goes in. Sizes the canvas to it and guesses the
 * head, eyes, cheeks, face area and skin colour from where it has paint, so a
 * single picture already makes a working skin; the user then only nudges.
 */
export function guessFromFirst(doc: Doc, part: Part) {
  const img = pool.get(part.img)!;
  const fit = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  doc.w = Math.round(img.width * fit);
  doc.h = Math.round(img.height * fit);
  part.x = 0;
  part.y = 0;
  part.scale = fit;
  const c = bake(doc, [part]);
  const b = opaqueBox(c) ?? { x0: 0, y0: 0, x1: doc.w, y1: doc.h };
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const r = Math.min(bw, bh) * 0.45;
  const cx = (b.x0 + b.x1) / 2;
  const cy = b.y0 + Math.min(bh * 0.45, r * 1.05);
  doc.head = { cx, cy, r };
  doc.chin = Math.min(b.y1, cy + r * 1.1);
  const ew = r * 0.16, eh = r * 0.2, ey = cy - r * 0.02;
  doc.eyes = [
    { x0: cx - r * 0.38 - ew, y0: ey - eh, x1: cx - r * 0.38 + ew, y1: ey + eh },
    { x0: cx + r * 0.38 - ew, y0: ey - eh, x1: cx + r * 0.38 + ew, y1: ey + eh },
  ];
  doc.cheeks = [[cx - r * 0.5, cy + r * 0.3], [cx + r * 0.5, cy + r * 0.3]];
  // Eyes and mouth: what a drawn expression usually replaces.
  doc.cover = { x0: cx - r * 0.7, y0: ey - eh * 1.6, x1: cx + r * 0.7, y1: cy + r * 0.38 };
  doc.lid = skinNearEyes(doc, c) ?? doc.lid;
  doc.pixel = looksLikePixelArt(c);
}

/**
 * The skin colour around the eyes — what an eyelid is painted with. Sampled
 * just under and beside each eye (hair often sits between and above them),
 * and the colour most of those points agree on wins.
 */
export function skinNearEyes(doc: Doc, c: HTMLCanvasElement): string | null {
  const points: [number, number][] = [];
  for (const e of doc.eyes) {
    const w = e.x1 - e.x0, h = e.y1 - e.y0, mx = (e.x0 + e.x1) / 2;
    points.push(
      [mx, e.y1 + h * 0.35], [mx - w * 0.3, e.y1 + h * 0.3], [mx + w * 0.3, e.y1 + h * 0.3],
      [mx, e.y1 + h * 0.6], [e.x0 - w * 0.25, (e.y0 + e.y1) / 2 + h * 0.3], [e.x1 + w * 0.25, (e.y0 + e.y1) / 2 + h * 0.3],
    );
  }
  const between = (doc.eyes[0].x1 + doc.eyes[1].x0) / 2;
  points.push([between, Math.max(doc.eyes[0].y1, doc.eyes[1].y1)]);
  const hex = points.map(([x, y]) => colourAt(c, x, y)).filter((v): v is string => !!v);
  if (!hex.length) return null;
  const rgb = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const close = (a: string, b: string) => rgb(a).reduce((sum, v, i) => sum + Math.abs(v - rgb(b)[i]), 0) < 45;
  // Ties go to the lighter colour: skin is usually lighter than lashes and shadows.
  const light = (s: string) => rgb(s).reduce((a, b) => a + b, 0);
  let best = hex[0], votes = 0;
  for (const h of hex) {
    const n = hex.filter((o) => close(h, o)).length;
    if (n > votes || (n === votes && light(h) > light(best))) {
      best = h;
      votes = n;
    }
  }
  return best;
}

/** Few colours and hard edges: drawn as pixel art, so it should stay sharp. */
function looksLikePixelArt(c: HTMLCanvasElement): boolean {
  const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  const colours = new Set<number>();
  let soft = 0, solid = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    const a = d[i + 3];
    if (a === 0) continue;
    if (a < 250) soft++;
    else solid++;
    colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (colours.size > 48) return false;
  }
  return solid > 0 && soft / (solid + soft) < 0.02;
}

/** Sensible motion points for a new part, from where it has paint. */
export function placeMotion(doc: Doc, part: Part) {
  const b = opaqueBox(bake(doc, [part]));
  if (!b) return;
  part.pivot = [(b.x0 + b.x1) / 2, b.y0 + (b.y1 - b.y0) * 0.08];
  part.tipY = b.y1;
}

// ── To a bundle ───────────────────────────────────────────────────────────────

export function slug(s: string): string {
  const v = s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return v.replace(/-+$/, "");
}

export function skinId(doc: Doc): string {
  if (doc.id) return doc.id;
  let id = slug(doc.name) || "my-skin";
  if (id === "mochi" || id === "ribbon") id += "-skin";
  return id;
}

/** File name for a part: unique, and a plain name the importer accepts. */
function partFile(part: Part): string {
  return `${slug(part.id) || "part"}.png`;
}

const FEEL: Record<Feel, { spring: string; rotate: number; squash?: { x: number; y: number } }> = {
  floppy: { spring: "hair", rotate: 1 },
  subtle: { spring: "locks", rotate: 1 },
  bouncy: { spring: "hair", rotate: 0.2, squash: { x: 0.18, y: 0.14 } },
};

/** Problems that stop a save, in plain words (empty when it can be saved). */
export function problems(doc: Doc): string[] {
  const out: string[] = [];
  if (!doc.name.trim()) out.push("Give the skin a name.");
  if (!doc.parts.some((p) => p.role === "head")) out.push("At least one picture has to be the Head.");
  if (doc.parts.filter((p) => p.role !== "iris").length > 16) out.push("At most 16 pictures.");
  if (doc.persona.length > 2000) out.push("The chat personality is longer than 2000 characters.");
  return out;
}

export interface Built {
  manifest: Record<string, unknown>;
  /** File name → full-size canvas. */
  pictures: Map<string, HTMLCanvasElement>;
}

/** The bundle this document makes. */
export function build(doc: Doc): Built {
  const pictures = new Map<string, HTMLCanvasElement>();
  const r = doc.head.r;
  const layers: unknown[] = [];
  let iris: { src: string; follow: number } | null = null;

  for (const part of doc.parts) {
    const file = partFile(part);
    const canvas = bake(doc, [part]);
    pictures.set(file, canvas);
    if (part.role === "iris") {
      iris = { src: file, follow: Math.round(r * 0.08) };
      continue;
    }
    let behavior: Record<string, unknown> | undefined;
    const sign = part.mirrored ? -1 : 1;
    if (part.motion === "swing") {
      const f = FEEL[part.feel];
      behavior = {
        type: "pivot",
        pivot: part.pivot.map(Math.round),
        spring: f.spring,
        rotate: f.rotate * sign,
        ...(f.squash ? { squash: f.squash, squashSpring: "bow" } : {}),
      };
    } else if (part.motion === "bend") {
      const b = opaqueBox(canvas) ?? { x0: 0, y0: 0, x1: doc.w, y1: doc.h };
      const pad = Math.max(8, (b.x1 - b.x0) * 0.15);
      behavior = {
        type: "bend",
        root: part.pivot.map(Math.round),
        tipY: Math.round(Math.max(part.tipY, part.pivot[1] + 1)),
        bounds: [b.x0 - pad, Math.min(b.y0, part.pivot[1]) - pad, b.x1 + pad, b.y1 + pad].map(Math.round),
        grid: [4, 8],
        spring: FEEL[part.feel].spring === "locks" ? "locks" : "hair",
      };
      if (sign < 0) {
        // A mirrored bend swings the other way: a spring of its own, pushed the other way.
        behavior.spring = "hair-mirrored";
      }
    }
    layers.push({
      id: slug(part.id) || "part",
      src: file,
      role: part.role,
      parallax: part.role === "back" ? 0.35 : 0,
      ...(behavior ? { behavior } : {}),
    });
  }

  const expressions: Record<string, string> = {};
  for (const [mood, placed] of Object.entries(doc.expressions)) {
    if (!placed) continue;
    const file = `face-${mood}.png`;
    pictures.set(file, bake(doc, [placed]));
    expressions[mood] = file;
  }

  const round = (b: Box) => [b.x0, b.y0, b.x1, b.y1].map(Math.round);
  const manifest: Record<string, unknown> = {
    format: 1,
    id: skinId(doc),
    name: doc.name.trim().slice(0, 40),
    ...(doc.author.trim() ? { author: doc.author.trim() } : {}),
    ...(doc.note.trim() ? { note: doc.note.trim() } : {}),
    ...(doc.persona.trim() ? { persona: doc.persona.trim() } : {}),
    size: { w: doc.w, h: doc.h },
    head: { cx: Math.round(doc.head.cx), cy: Math.round(doc.head.cy), r: Math.round(doc.head.r) },
    chin: Math.round(doc.chin),
    tiltPivot: [Math.round(doc.head.cx), Math.round(doc.chin)],
    layers,
    eyes: doc.eyes.map((e, i) => ({
      cx: Math.round((e.x0 + e.x1) / 2),
      cy: Math.round((e.y0 + e.y1) / 2),
      x0: Math.round(e.x0),
      x1: Math.round(e.x1),
      top: Math.round(e.y0),
      bottom: Math.round(e.y1),
      sd: i === 0 ? -1 : 1,
    })),
    ...(iris ? { iris } : {}),
    lid: doc.lid,
    lash: doc.lash,
    cheeks: doc.cheeks.map((c) => c.map(Math.round)),
    blush: { rx: Math.round(r * 0.13), ry: Math.round(r * 0.09), color: doc.blush },
    springs: {
      "hair-mirrored": { k: 30, c: 3.6, max: 0.32, idle: [0.035, 1.1], yaw: 2.6, tilt: 3.6, oy: -2.0, sy: -2.0 },
    },
    ...(Object.keys(expressions).length
      ? { expressions, cover: round(doc.cover), coverShape: doc.pixel ? "rect" : "oval" }
      : {}),
  };
  return { manifest, pictures };
}

// ── From an installed skin ────────────────────────────────────────────────────

/** Turns an installed skin back into a document (its pictures are full-size already). */
export function fromManifest(id: string, m: any, images: Map<string, ImageBitmap>): Doc {
  const doc = emptyDoc();
  const num = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? v : f);
  doc.id = id;
  doc.name = String(m.name ?? "");
  doc.author = String(m.author ?? "");
  doc.note = String(m.note ?? "");
  doc.persona = String(m.persona ?? "");
  doc.w = num(m.size?.w, 512);
  doc.h = num(m.size?.h, 512);
  doc.head = { cx: num(m.head?.cx, doc.w / 2), cy: num(m.head?.cy, doc.h / 2), r: num(m.head?.r, doc.w / 3) };
  doc.chin = num(m.chin, doc.head.cy + doc.head.r);
  const place = (src: string): Placed | null => {
    const img = images.get(src);
    return img ? { img: addToPool(img), x: 0, y: 0, scale: 1 } : null;
  };
  let n = 0;
  for (const l of Array.isArray(m.layers) ? m.layers : []) {
    const placed = place(l.src);
    if (!placed) continue;
    const b = l.behavior ?? {};
    const motion: Motion = b.type === "pivot" ? "swing" : b.type === "bend" ? "bend" : "still";
    const feel: Feel = b.squash ? "bouncy" : b.spring === "locks" ? "subtle" : "floppy";
    doc.parts.push({
      ...placed,
      id: String(l.id || `part-${++n}`),
      name: String(l.id || l.src).replace(/\.png$/i, ""),
      role: l.role === "back" || l.role === "front" ? l.role : "head",
      motion,
      feel,
      mirrored: (typeof b.rotate === "number" && b.rotate < 0) || b.spring === "hair-mirrored",
      pivot: Array.isArray(b.pivot) ? [b.pivot[0], b.pivot[1]] : Array.isArray(b.root) ? [b.root[0], b.root[1]] : [doc.head.cx, doc.head.cy],
      tipY: num(b.tipY, doc.h),
    });
  }
  if (m.iris?.src) {
    const placed = place(m.iris.src);
    if (placed) {
      doc.parts.push({ ...placed, id: "iris", name: "irises", role: "iris", motion: "still", feel: "floppy", mirrored: false, pivot: [0, 0], tipY: 0 });
    }
  }
  const eyes = Array.isArray(m.eyes) ? m.eyes : [];
  if (eyes.length) {
    const box = (e: any): Box => ({ x0: num(e.x0, 0), y0: num(e.top, 0), x1: num(e.x1, 0), y1: num(e.bottom, 0) });
    doc.eyes = [box(eyes[0]), box(eyes[1] ?? eyes[0])];
  }
  if (Array.isArray(m.cheeks) && m.cheeks.length) {
    const c = m.cheeks;
    doc.cheeks = [[num(c[0]?.[0], 0), num(c[0]?.[1], 0)], [num(c[1]?.[0] ?? c[0]?.[0], 0), num(c[1]?.[1] ?? c[0]?.[1], 0)]];
  }
  if (Array.isArray(m.cover) && m.cover.length === 4) {
    doc.cover = { x0: num(m.cover[0], 0), y0: num(m.cover[1], 0), x1: num(m.cover[2], 0), y1: num(m.cover[3], 0) };
  }
  const hex = (v: unknown, f: string) => {
    if (typeof v !== "string") return f;
    const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
    if (rgb) return `#${rgb.slice(1, 4).map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
    return /^#[0-9a-f]{6}$/i.test(v) ? v : f;
  };
  doc.lid = hex(m.lid, doc.lid);
  doc.lidAuto = false;
  doc.lash = hex(m.lash, doc.lash);
  doc.blush = hex(m.blush?.color, doc.blush);
  for (const [mood, src] of Object.entries((m.expressions ?? {}) as Record<string, string>)) {
    const placed = place(src);
    if (placed && MOODS.some(([k]) => k === mood)) doc.expressions[mood as Mood] = placed;
  }
  return doc;
}
