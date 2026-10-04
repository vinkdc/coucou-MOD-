// A sample skin bundle: a small orange pixel critter in the spirit of the Claude
// Code mascot, drawn cell by cell (no artwork). It has a face for each of
// Mochi's moods, so happy, sleeping, dizzy, in love… all show. For trying
// Settings → Character → Import skin….
// Usage: node make-claude-mascot.mjs [folder]

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "claude-mascot");
const CELL = 8, N = 32, W = CELL * N, H = CELL * N;

// ── PNG encoder ──────────────────────────────────────────────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, sum]);
};
/** `cell(col, row)` returns [r,g,b,a] or null; every cell is CELL×CELL hard pixels. */
function png(cell) {
  const row = W * 4 + 1, raw = Buffer.alloc(row * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = cell(Math.floor(x / CELL), Math.floor(y / CELL));
    if (c) raw.set(c, y * row + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ── Palette and shapes (cells) ───────────────────────────────────────────────
const C = {
  o: [217, 119, 87, 255], // body
  d: [190, 98, 70, 255], // legs, a shade darker
  k: [34, 26, 24, 255], // ink
  w: [255, 248, 240, 255], // mouth
  p: [255, 92, 150, 255], // heart
  y: [255, 205, 60, 255], // star
  b: [90, 170, 230, 255], // sweat
};
const inBox = (c, r, c0, r0, c1, r1) => c >= c0 && c <= c1 && r >= r0 && r <= r1;
const BODY = [8, 8, 23, 19]; // cols 8–23, rows 8–19
const COVER = [9, 10, 22, 17]; // the face area, 14 × 8 cells

// The face area, one picture per mood. '.' leaves the body colour.
const FACES = {
  pill: [
    "..............",
    "..kk......kk..",
    "..kk......kk..",
    "..............",
    "..............",
    "......ww......",
    "..............",
    "..............",
  ],
  happy: [
    "..............",
    "...kk....kk...",
    "..k..k..k..k..",
    "..............",
    ".....w..w.....",
    "......ww......",
    "..............",
    "..............",
  ],
  closed: [
    "..............",
    "..............",
    "..kkk....kkk..",
    "..............",
    "..............",
    "......ww......",
    "..............",
    "..............",
  ],
  wink: [
    "..............",
    "..........kk..",
    "..kkk.....kk..",
    "..............",
    ".....w..w.....",
    "......ww......",
    "..............",
    "..............",
  ],
  wide: [
    "..kk......kk..",
    "..kk......kk..",
    "..kk......kk..",
    "..............",
    "..............",
    "......ww......",
    "......ww......",
    "..............",
  ],
  flat: [
    "..............",
    "..............",
    "..kkk....kkk..",
    "..............",
    "......ww......",
    ".....w..w.....",
    "..............",
    "..............",
  ],
  tired: [
    "..............",
    "..kkk....kkk.b",
    "..k.k....k.kb.",
    "..............",
    "..............",
    "....wwwwww....",
    "..............",
    "..............",
  ],
  spiral: [
    "..k.k....k.k..",
    "...k......k...",
    "..k.k....k.k..",
    "..............",
    "..............",
    "......ww......",
    "..............",
    "..............",
  ],
  heart: [
    ".p.p......p.p.",
    ".ppp......ppp.",
    "..p........p..",
    "..............",
    ".....w..w.....",
    "......ww......",
    "..............",
    "..............",
  ],
  star: [
    "..y........y..",
    ".yyy......yyy.",
    "..y........y..",
    "..............",
    ".....w..w.....",
    "......ww......",
    "..............",
    "..............",
  ],
  line: [
    "..............",
    "..............",
    "..kk......kk..",
    "..............",
    "..............",
    ".....wwww.....",
    "..............",
    "..............",
  ],
  dot: [
    "..............",
    "..k........k..",
    "..............",
    "..............",
    "..............",
    "......w.......",
    "..............",
    "..............",
  ],
};
const face = (name) => (c, r) => {
  const ch = FACES[name][r - COVER[1]]?.[c - COVER[0]];
  return ch && ch !== "." ? C[ch] : null;
};

const body = (c, r) => (inBox(c, r, ...BODY) ? C.o : null);
const legs = (c, r) =>
  [9, 13, 17, 21].some((c0) => inBox(c, r, c0, 20, c0 + 1, 22)) ? C.d : null;
const ARM_L = [4, 13, 7, 15], ARM_R = [24, 13, 27, 15];

const layers = {
  "head.png": (c, r) => legs(c, r) ?? face("pill")(c, r) ?? body(c, r),
  "arm-left.png": (c, r) => (inBox(c, r, ...ARM_L) ? C.o : null),
  "arm-right.png": (c, r) => (inBox(c, r, ...ARM_R) ? C.o : null),
};
const expressions = {};
for (const name of Object.keys(FACES)) {
  if (name === "pill") continue; // the open face is drawn into head.png
  layers[`face-${name}.png`] = face(name);
  expressions[name] = `face-${name}.png`;
}

mkdirSync(out, { recursive: true });
for (const [name, cell] of Object.entries(layers)) writeFileSync(join(out, name), png(cell));

const px = (cells) => Math.round(cells * CELL);
const manifest = {
  format: 1,
  id: "claude-mascot",
  name: "Pixel critter",
  author: "Sample",
  note: "An orange pixel terminal critter with a face for every mood. Made for trying the skin importer.",
  persona:
    "You are a small, cheerful pixel critter who lives in the user's notch and loves watching them code. You are warm, curious and brief: one or two short sentences, a little dry humour, never preachy. You cheer when tests pass and stay calm when they fail.",
  size: { w: W, h: H },
  head: { cx: px(16), cy: px(14), r: 90 },
  chin: px(23),
  tiltPivot: [px(16), px(23)],
  layers: [
    { id: "head", src: "head.png", role: "head" },
    // The arms swing a little with the body, hanging from the shoulders.
    { id: "arm-left", src: "arm-left.png", role: "front", behavior: { type: "pivot", pivot: [px(8), px(13.5)], spring: "arms", rotate: 1.2 } },
    { id: "arm-right", src: "arm-right.png", role: "front", behavior: { type: "pivot", pivot: [px(24), px(13.5)], spring: "arms", rotate: -1.2 } },
  ],
  expressions,
  cover: [px(COVER[0]), px(COVER[1]), px(COVER[2] + 1), px(COVER[3] + 1)],
  // Used only for moods without a picture above.
  eyes: [11, 19].map((c0, i) => ({ cx: px(c0 + 1), cy: px(12), x0: px(c0 - 0.5), x1: px(c0 + 2.5), top: px(10.5), bottom: px(13.5), sd: i ? 1 : -1 })),
  lid: "rgb(217, 119, 87)",
  lash: "rgb(34, 26, 24)",
  springs: { arms: { k: 55, c: 4.5, max: 0.3, idle: [0.04, 1.6], yaw: -1.2, tilt: -2.4, oy: 2.2, sy: 2.0 } },
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${out} (${Object.keys(layers).length} pictures)`);
