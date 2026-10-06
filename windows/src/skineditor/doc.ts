// The skin editor's document: the hair pictures, how each moves and where they
// sit on Mochi's head. Plain data (pictures are kept by key in a pool), so undo
// is a copy of it. From it comes a skin bundle exactly like an imported one
// (docs/SKINS.md): a manifest and full-size PNGs. Mochi keeps its own body and
// eyes; the bundle is only hair and a bow.

import { FORMAT, type Manifest } from "../mochi/manifest";
import type { Pt } from "../mochi/puppet";

// ── Model ─────────────────────────────────────────────────────────────────────

/** `back` sits behind Mochi's body, `front` over it but under the eyes, `top` over the eyes too. */
export type PartRole = "back" | "front" | "top";
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
  /** A `top` picture that slides with Mochi's eyes (glasses) rather than staying put. */
  follow: boolean;
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

/** Where the pictures sit on Mochi (see Fit in mochi/manifest.ts). */
export interface Fit {
  width: number;
  height: number;
  centerX: number;
  eyeLine: number;
}

export interface Doc {
  name: string;
  author: string;
  note: string;
  persona: string;
  /** Set when editing an installed skin: saving replaces it. */
  id: string | null;
  w: number;
  h: number;
  parts: Part[];
  fit: Fit;
  /** Body colour as #rrggbb; empty = Mochi's own grey. */
  skinColor: string;
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
    parts: [],
    fit: { width: w * 0.29, height: h * 0.39, centerX: w / 2, eyeLine: h * 0.63 },
    skinColor: "",
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

// ── First picture: a good guess at the fit ────────────────────────────────────

/**
 * Called when the first picture goes in. Sizes the canvas to it and guesses how
 * it sits on Mochi from where it has paint, so a single picture already makes a
 * working skin; the user then only nudges. The ratios are the bundled example's
 * (Tokai Teio): hair about 3.2 Mochi radii wide and 2.2 tall, the eye line a
 * little over half way down.
 */
export function guessFit(doc: Doc, part: Part) {
  const img = pool.get(part.img)!;
  const fit = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  doc.w = Math.round(img.width * fit);
  doc.h = Math.round(img.height * fit);
  part.x = 0;
  part.y = 0;
  part.scale = fit;
  const b = opaqueBox(bake(doc, [part])) ?? { x0: 0, y0: 0, x1: doc.w, y1: doc.h };
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  doc.fit = {
    width: Math.round(bw / 3.2),
    height: Math.round(bh / 2.2),
    centerX: Math.round((b.x0 + b.x1) / 2),
    eyeLine: Math.round(b.y0 + bh * 0.65),
  };
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
  if (!doc.parts.length) out.push("Add at least one picture.");
  if (doc.parts.length > 16) out.push("At most 16 pictures.");
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
  const layers: unknown[] = [];

  for (const part of doc.parts) {
    const file = partFile(part);
    const canvas = bake(doc, [part]);
    pictures.set(file, canvas);
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
      parallax: part.role === "back" ? 0.35 : part.role === "top" ? (part.follow ? 1 : 0) : 0,
      ...(behavior ? { behavior } : {}),
    });
  }

  const manifest: Record<string, unknown> = {
    format: FORMAT,
    id: skinId(doc),
    name: doc.name.trim().slice(0, 40),
    ...(doc.author.trim() ? { author: doc.author.trim() } : {}),
    ...(doc.note.trim() ? { note: doc.note.trim() } : {}),
    ...(doc.persona.trim() ? { persona: doc.persona.trim() } : {}),
    size: { w: doc.w, h: doc.h },
    layers,
    springs: {
      "hair-mirrored": { k: 30, c: 3.6, max: 0.32, idle: [0.035, 1.1], yaw: 2.6, tilt: 3.6, oy: -2.0, sy: -2.0 },
    },
    ...(doc.skinColor ? { skinColor: doc.skinColor } : {}),
    fit: {
      width: Math.round(doc.fit.width),
      height: Math.round(doc.fit.height),
      centerX: Math.round(doc.fit.centerX),
      eyeLine: Math.round(doc.fit.eyeLine),
    },
  };
  return { manifest, pictures };
}

// ── From an installed skin ────────────────────────────────────────────────────

/** Turns an installed skin back into a document (its pictures are full-size already). */
export function fromManifest(id: string, m: Manifest, author: string, note: string, images: Map<string, ImageBitmap>): Doc {
  const doc = emptyDoc();
  doc.id = id;
  doc.name = m.name;
  doc.author = author;
  doc.note = note;
  doc.persona = m.persona;
  doc.w = m.size.w;
  doc.h = m.size.h;
  doc.fit = { ...m.fit };
  doc.skinColor = m.skinColor;
  let n = 0;
  for (const l of m.layers) {
    const img = images.get(l.src);
    if (!img) continue;
    const b = l.behavior;
    const motion: Motion = b.type === "pivot" ? "swing" : b.type === "bend" ? "bend" : "still";
    const feel: Feel = b.type === "pivot" && b.squash ? "bouncy" : "spring" in b && b.spring === "locks" ? "subtle" : "floppy";
    doc.parts.push({
      img: addToPool(img),
      x: 0,
      y: 0,
      scale: 1,
      id: l.id || `part-${++n}`,
      name: (l.id || l.src).replace(/\.png$/i, ""),
      role: l.role,
      motion,
      feel,
      follow: l.role !== "top" || l.parallax >= 0.5,
      mirrored: (b.type === "pivot" && b.rotate < 0) || ("spring" in b && b.spring === "hair-mirrored"),
      pivot: b.type === "pivot" ? [b.pivot[0], b.pivot[1]] : b.type === "bend" ? [b.root[0], b.root[1]] : [doc.fit.centerX, doc.fit.eyeLine],
      tipY: b.type === "bend" ? b.tipY : doc.h,
    });
  }
  return doc;
}

// ── A starting point ──────────────────────────────────────────────────────────

/**
 * The bundled example as a document: flat-colour hair (a back piece, a fringe
 * with side locks, a ponytail that bends), a swinging bow and glasses that
 * follow Mochi's eyes. The same skin as docs/examples/skin-example, drawn here
 * so a new skin can start from something that already works.
 */
export async function exampleDoc(): Promise<Doc> {
  const doc = emptyDoc();
  doc.name = "Example";
  doc.w = 256;
  doc.h = 256;
  doc.fit = { width: 68, height: 89, centerX: 128, eyeLine: 154 };
  const HAIR = "#a85a46";
  const DARK = "#8a4638";
  const ellipse = (g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number) => {
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  };
  const picture = async (paint: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas");
    c.width = doc.w;
    c.height = doc.h;
    paint(c.getContext("2d")!);
    return createImageBitmap(c);
  };
  const part = (id: string, img: ImageBitmap, role: PartRole, motion: Motion, feel: Feel, pivot: Pt, tipY: number): Part => ({
    img: addToPool(img), x: 0, y: 0, scale: 1, id, name: id, role, motion, feel, mirrored: false, follow: true, pivot, tipY,
  });
  const none: Pt = [0, 0];
  doc.parts.push(
    part("tail", await picture((g) => { g.fillStyle = DARK; ellipse(g, 214, 150, 22, 70); g.fill(); }), "back", "bend", "floppy", [206, 100], 222),
    part("back", await picture((g) => { g.fillStyle = DARK; ellipse(g, 128, 125, 108, 98); g.fill(); }), "back", "still", "floppy", none, 0),
    part("fringe", await picture((g) => {
      g.save();
      ellipse(g, 128, 125, 104, 94);
      g.clip();
      g.fillStyle = HAIR;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(256, 0);
      for (let x = 256; x >= 0; x -= 2) g.lineTo(x, 112 + 9 * Math.sin(x / 9));
      g.closePath();
      g.fill();
      g.fillRect(0, 0, 46, 175);
      g.fillRect(210, 0, 46, 175);
      g.restore();
    }), "front", "still", "floppy", none, 0),
    part("bow", await picture((g) => {
      g.fillStyle = "#ffffff";
      for (const [cx, rx, ry] of [[172, 16, 11], [202, 16, 11], [187, 6, 7]]) {
        ellipse(g, cx, 40, rx, ry);
        g.fill();
      }
    }), "front", "swing", "bouncy", [187, 40], 0),
    part("glasses", await picture((g) => {
      g.strokeStyle = "#2a2a30";
      g.lineWidth = 3;
      for (const cx of [100, 156]) {
        ellipse(g, cx, 154, 16, 20);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(116, 150);
      g.lineTo(140, 150);
      g.stroke();
    }), "top", "still", "floppy", none, 0),
  );
  return doc;
}
