// HairSkin — an imported bundle worn on Mochi's own body and eyes. Its layers
// are hair and a bow: the back hair goes behind the body, the fringe and locks
// over it but under the eyes, the bow (and glasses, which follow the eyes) on top. Mochi keeps its face, its eyes
// and all of their motion; the hair rides on the engine's head turn, tilt, hops
// and squash like RibbonSkin's, with springs the manifest tunes.

import { Layer, Spring, clamp, drawBent, type BendSpec } from "./puppet";
import type { LayerDef, Manifest } from "./manifest";
import type { DecorSkin, SkinPose } from "./skin";

/** Where Mochi's eyes sit below the body's centre, in Mochi radii (BotEngine.drawEyes). */
const EYE_LINE = 0.105;
/** Half the angle between Mochi's eyes, and their resting pitch (EYE_SP, EYE_P there). */
const EYE_SPREAD = 0.37;
const EYE_PITCH = -0.12;
/**
 * How far the hair slides with the head turn, as a fraction of the body's half
 * width, and up and down with a nod. Small on purpose: the body itself never
 * moves (only the eyes slide across it), so hair that travels with the eyes
 * leaves one side of the head bare and hangs off the other.
 */
const FOLLOW = 0.03;
const NOD = 0.05;

interface Piece {
  def: LayerDef;
  layer: Layer;
}

export class HairSkin implements DecorSkin {
  readonly blushFloor = 0;
  readonly skinColor: string;
  readonly ready: Promise<void>;

  private pieces: Piece[] = [];
  private springs = new Map<string, Spring>();
  /** The head turn, low-passed: its speed is what throws the hair. */
  private gaze = new Spring(36, 12);
  private pitch = 0;
  private last: SkinPose | null = null;
  private lastReal = 0;
  private t = Math.random() * 10;

  constructor(private m: Manifest, images: Map<string, ImageBitmap>) {
    this.skinColor = m.skinColor;
    for (const [name, d] of Object.entries(m.springs)) this.springs.set(name, new Spring(d.k, d.c));
    this.ready = Promise.resolve().then(() => {
      this.pieces = m.layers.map((def) => {
        const img = images.get(def.src);
        if (!img) throw new Error(`missing picture ${def.src}`);
        return { def, layer: new Layer(img, m.crop) };
      });
      for (const img of images.values()) img.close();
    });
  }

  update(p: SkinPose, dt: number) {
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 30);
    this.t += dt;
    // After a pause of the animation loop the stored pose is stale; starting
    // from it would read as a violent jolt.
    const real = performance.now();
    const paused = real - this.lastReal > 120;
    this.lastReal = real;
    const prev = paused ? p : this.last ?? p;
    if (paused) {
      this.gaze.v = Math.sin(p.yaw);
      this.gaze.vel = 0;
    }
    this.gaze.step(Math.sin(p.yaw), 0, dt);
    this.pitch = p.pitch;
    const dYaw = this.gaze.vel;
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

  drawBehind(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, yaw: number) {
    this.draw(x, R, rx, ry, yaw, (d) => d.role === "back");
  }

  drawHair(x: CanvasRenderingContext2D, _body: Path2D, R: number, rx: number, ry: number, yaw: number) {
    this.draw(x, R, rx, ry, yaw, (d) => d.role === "front" && d.behavior.type !== "pivot");
  }

  drawBow(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, yaw: number) {
    // On top of the eyes: glasses and the like, then a bow.
    this.draw(x, R, rx, ry, yaw, (d) => d.role === "top" || (d.role === "front" && d.behavior.type === "pivot"));
  }

  /** Draws the layers `pick` chooses, in body-local coordinates (the engine has already tilted and squashed them). */
  private draw(
    x: CanvasRenderingContext2D, R: number, rx: number, ry: number, yaw: number,
    pick: (def: LayerDef) => boolean,
  ) {
    const { fit } = this.m;
    // Canvas px per picture px. Mochi's head is squatter than most drawn ones, so
    // the hair may be squeezed a little to sit on it instead of standing over it.
    const kx = R / fit.width;
    const ky = R / fit.height;
    const turn = Math.sin(yaw) * rx * FOLLOW;
    const nod = this.pitch * ry * NOD;
    // Where the eyes have slid to, from their rest: the middle of the two moves with the
    // turn (cos of their half spread) and up and down with the pitch (BotEngine.drawEyes).
    const eyeDx = Math.sin(yaw) * Math.cos(EYE_SPREAD) * rx;
    const eyeDy = -(Math.sin(this.pitch + EYE_PITCH) - Math.sin(EYE_PITCH)) * ry;
    const spring = (name: string) => this.springs.get(name)?.v ?? 0;

    for (const { def, layer } of this.pieces) {
      if (!pick(def)) continue;
      x.save();
      // The hair behind the head trails the turn; the fringe and locks ride with it.
      if (def.role === "top") {
        const f = def.parallax;
        x.translate(f * eyeDx + (1 - f) * turn, f * eyeDy + (1 - f) * nod);
      } else {
        x.translate(def.role === "back" ? turn * (1 - def.parallax) : turn, nod);
      }
      // Into picture coordinates, the picture's eye line on Mochi's.
      x.translate(0, EYE_LINE * R);
      x.scale(kx, ky);
      x.translate(-fit.centerX, -fit.eyeLine);
      const t = x.getTransform();
      const scale = Math.max(Math.hypot(t.a, t.b), Math.hypot(t.c, t.d));
      const b = def.behavior;
      if (b.type === "bend") {
        drawBent(x, layer, scale, spring(b.spring), { root: b.root, tipY: b.tipY, bounds: b.bounds, cols: b.cols, rows: b.rows } as BendSpec);
      } else {
        if (b.type === "pivot") {
          x.translate(b.pivot[0], b.pivot[1]);
          x.rotate(spring(b.spring) * b.rotate);
          if (b.squash) {
            const q = spring(b.squashSpring);
            x.scale(1 + q * b.squash[0], 1 - q * b.squash[1]);
          }
          x.translate(-b.pivot[0], -b.pivot[1]);
        }
        layer.draw(x, scale);
      }
      x.restore();
    }
  }
}
