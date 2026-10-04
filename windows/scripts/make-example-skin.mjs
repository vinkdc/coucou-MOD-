// Writes the example skin bundle used by docs/SKINS.md: a flat-colour round
// head, a swinging tail, a bow and eyes with irises. No dependencies — the PNGs
// are encoded here. Usage: node scripts/make-example-skin.mjs [out-folder]

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
const HEAD = { cx: 128, cy: 130, r: 88 };
const EYES = [{ cx: 98, cy: 135 }, { cx: 158, cy: 135 }];
const SKIN = [255, 226, 205, 255];
const HAIR = [168, 90, 70, 255];

const layers = {
  "tail.png": (x, y) => (inEllipse(x, y, 215, 150, 24, 80) ? HAIR : null),
  "head.png": (x, y) => {
    if (!inEllipse(x, y, HEAD.cx, HEAD.cy, HEAD.r, HEAD.r)) return null;
    if (EYES.some((e) => inEllipse(x, y, e.cx, e.cy, 19, 23))) return [255, 255, 255, 255];
    return y < 95 ? HAIR : SKIN;
  },
  "iris.png": (x, y) => (EYES.some((e) => inEllipse(x, y, e.cx, e.cy, 11, 14)) ? [70, 150, 80, 255] : null),
  "bow.png": (x, y) =>
    inEllipse(x, y, 178, 52, 16, 11) || inEllipse(x, y, 208, 52, 16, 11) || inEllipse(x, y, 193, 52, 6, 7)
      ? [255, 255, 255, 255]
      : null,
};

mkdirSync(out, { recursive: true });
for (const [name, paint] of Object.entries(layers)) writeFileSync(join(out, name), png(paint));

const manifest = {
  format: 1,
  id: "example",
  name: "Example",
  author: "Coucou",
  note: "A flat-colour demo skin: the smallest thing that moves like a real one.",
  persona: "You are a cheerful little round character who answers briefly and warmly.",
  size: { w: W, h: H },
  head: HEAD,
  chin: 205,
  tiltPivot: [128, 205],
  layers: [
    { id: "tail", src: "tail.png", role: "back", behavior: { type: "bend", root: [210, 90], tipY: 232, bounds: [180, 60, 250, 240], grid: [3, 6], spring: "hair" } },
    { id: "head", src: "head.png", role: "head" },
    { id: "bow", src: "bow.png", role: "front", behavior: { type: "pivot", pivot: [193, 52], spring: "hair", rotate: 0.3, squash: { x: 0.18, y: 0.14 }, squashSpring: "bow" } },
  ],
  eyes: EYES.map((e, i) => ({ ...e, x0: e.cx - 19, x1: e.cx + 19, top: e.cy - 23, bottom: e.cy + 23, sd: i ? 1 : -1 })),
  iris: { src: "iris.png", follow: 14 },
  lid: "rgb(255, 226, 205)",
  lash: "rgb(60, 36, 40)",
  cheeks: [[78, 170], [178, 170]],
  blush: { rx: 22, ry: 14, color: "rgb(255, 140, 155)" },
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote the example skin to ${out}`);
