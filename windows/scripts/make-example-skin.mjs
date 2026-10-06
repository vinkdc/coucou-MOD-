// Writes the example skin bundle used by docs/SKINS.md: flat-colour hair (a back
// piece, a fringe with side locks, a ponytail that bends), a swinging bow and
// glasses over the eyes.
// Mochi keeps its own body and eyes; the bundle is only what goes on top. No
// dependencies — the PNGs are encoded here.
// Usage: node scripts/make-example-skin.mjs [out-folder]

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "../docs/examples/skin-example");
const W = 256;
const H = 256;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, sum]);
};
function png(paint) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = paint(x, y) ?? [0, 0, 0, 0];
      raw.set([r, g, b, a], y * (W * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const HAIR = [168, 90, 70, 255];
const HAIR_DARK = [138, 70, 56, 255];
const BOW = [255, 255, 255, 255];
const FRAME = [42, 42, 48, 255];

// The hair as a drawn head would wear it: round, wider than Mochi, with a
// fringe that ends about where the eyes go.
const HEAD = { cx: 128, cy: 125, rx: 104, ry: 94 };

const layers = {
  "back.png": (x, y) => (inEllipse(x, y, 128, 125, 108, 98) ? HAIR_DARK : null),
  "tail.png": (x, y) => (inEllipse(x, y, 214, 150, 22, 70) ? HAIR_DARK : null),
  "fringe.png": (x, y) => {
    if (!inEllipse(x, y, HEAD.cx, HEAD.cy, HEAD.rx, HEAD.ry)) return null;
    const fringe = y < 112 + 9 * Math.sin(x / 9);
    const locks = (x < 46 || x > 210) && y < 175;
    return fringe || locks ? HAIR : null;
  },
  "glasses.png": (x, y) => {
    const ring = [100, 156].some((cx) => inEllipse(x, y, cx, 154, 16, 20) && !inEllipse(x, y, cx, 154, 13, 17));
    const bridge = x >= 116 && x <= 140 && y >= 148 && y <= 151;
    return ring || bridge ? FRAME : null;
  },
  "bow.png": (x, y) =>
    inEllipse(x, y, 172, 40, 16, 11) || inEllipse(x, y, 202, 40, 16, 11) || inEllipse(x, y, 187, 40, 6, 7) ? BOW : null,
};

mkdirSync(out, { recursive: true });
for (const [name, paint] of Object.entries(layers)) writeFileSync(join(out, name), png(paint));

const manifest = {
  format: 2,
  id: "example",
  name: "Example",
  author: "Kotoba",
  note: "Flat-colour hair on Mochi: the smallest skin that moves like a real one.",
  persona: "You are a cheerful little round character who answers briefly and warmly.",
  size: { w: W, h: H },
  layers: [
    { id: "tail", src: "tail.png", role: "back", behavior: { type: "bend", root: [206, 100], tipY: 222, bounds: [180, 70, 250, 230], grid: [3, 6], spring: "hair" } },
    { id: "back", src: "back.png", role: "back", parallax: 0.35 },
    { id: "fringe", src: "fringe.png", role: "front" },
    { id: "glasses", src: "glasses.png", role: "top", parallax: 1 },
    { id: "bow", src: "bow.png", role: "front", behavior: { type: "pivot", pivot: [187, 40], spring: "hair", rotate: 0.3, squash: { x: 0.18, y: 0.14 }, squashSpring: "bow" } },
  ],
  // Picture px per Mochi radius (across, down), the face's middle x and the eye line y.
  fit: { width: 68, height: 89, centerX: 128, eyeLine: 154 },
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote the example skin to ${out}`);
