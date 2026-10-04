// "Ribbon" — an optional look for Mochi: auburn bangs, a long side ponytail
// tied with a big white bow, green eyes and a soft blush, on Mochi's own body.
//
// Drawn in code like the rest of Mochi (no images). Everything here is a layer
// on top of BotEngine and is driven by the engine's own motion — head turn
// (yaw), tilt, hops (oy) and squash (sx/sy) — so every existing animation,
// from a hop to a slap to sleep, carries into the hair and the bow:
//   • the ponytail is a damped pendulum pushed by turns, tilts and hops;
//   • the bow squashes and springs back on hops and squishes;
//   • the bangs lag a beat behind quick head turns.

import type { EyeShape } from "./engine";

export type SkinName = "mochi" | "ribbon";

/** Everything a full-figure skin needs from the engine for one frame. */
export interface FullPose {
  /** Head centre and unit size, in canvas pixels. */
  cx: number;
  cy: number;
  R: number;
  sx: number;
  sy: number;
  tilt: number;
  yaw: number;
  pitch: number;
  /** Eyelid, 0 = shut … 1 = open (blinks). */
  open: number;
  /** Mochi's eye for this state/emote; open eyes are "pill" or "wide". */
  eye: EyeShape;
  blush: number;
}

/** Draws one of Mochi's expression eyes (happy arc, heart, spiral…). */
export type DrawEye = (
  x: CanvasRenderingContext2D, shape: EyeShape, w: number, h: number, sd: number, ink: string,
) => void;

/**
 * A skin that replaces Mochi's whole figure rather than decorating it. It still
 * gets the engine's motion and expressions every frame; badges and particles
 * are drawn by the engine on top.
 */
export interface FullSkin {
  readonly full: true;
  /** Resolves once the skin can draw (e.g. its artwork has loaded). */
  readonly ready?: Promise<void>;
  update(p: SkinPose, dt: number): void;
  draw(x: CanvasRenderingContext2D, pose: FullPose, drawEye: DrawEye): void;
}

const HAIR_TOP = "#c9715d";
const HAIR_BOTTOM = "#a9533f";
const HAIR_SHADE = "rgba(84, 30, 22, 0.28)";
const FACE_TOP = "#fbe9df";
const FACE_BOTTOM = "#efcdbd";
const EYE_TOP = "#1f4f2c";
const EYE_BOTTOM = "#63b04f";
const BOW_LIGHT = "#ffffff";
const BOW_SHADE = "#dcd8de";

/** A damped spring on one value: `v'' = k·(rest − v) − c·v' + push`. */
class Spring {
  v = 0;
  vel = 0;
  constructor(private k: number, private c: number) {}
  step(rest: number, push: number, dt: number) {
    const acc = this.k * (rest - this.v) - this.c * this.vel + push;
    this.vel += acc * dt;
    this.v += this.vel * dt;
  }
}

/** The engine values the skin reads. */
export interface SkinPose {
  yaw: number;
  pitch: number;
  tilt: number;
  oy: number;
  sy: number;
  open: number;
}

export class RibbonSkin {
  readonly eyeTop = EYE_TOP;
  readonly eyeBottom = EYE_BOTTOM;
  /** Always a little rosy; the engine's own blush (love, happy) adds to it. */
  readonly blushFloor = 0.32;

  private pony = new Spring(38, 4.2); // radians — slow, loose swing
  private bow = new Spring(260, 11); // squash amount — quick, springy
  private bangs = new Spring(120, 13); // lateral lag, fraction of R
  private last: SkinPose | null = null;
  private t = Math.random() * 10;

  update(p: SkinPose, dt: number) {
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 30); // a stalled frame must not fling the hair
    this.t += dt;
    const prev = this.last ?? p;
    const dYaw = (p.yaw - prev.yaw) / dt;
    const dTilt = (p.tilt - prev.tilt) / dt;
    const dOy = (p.oy - prev.oy) / dt;
    const dSy = (p.sy - prev.sy) / dt;
    this.last = { ...p };

    // Ponytail: hangs a touch outwards, sways gently on its own, and is thrown
    // the other way by turns and tilts; a hop lifts it and a squash flicks it.
    const idle = Math.sin(this.t * 1.3) * 0.05;
    this.pony.step(0.08 + idle, -dYaw * 3.6 - dTilt * 4.5 + dOy * 2.4 + dSy * 2.2, dt);
    this.pony.v = Math.max(-0.7, Math.min(0.7, this.pony.v));

    // Bow: squashes when the body lands or squishes, then springs back.
    this.bow.step(0, -dOy * 18 + dSy * 14, dt);
    this.bow.v = Math.max(-0.45, Math.min(0.45, this.bow.v));

    // Bangs: trail behind a turn by a few pixels.
    this.bangs.step(0, -dYaw * 2.6, dt);
    this.bangs.v = Math.max(-0.25, Math.min(0.25, this.bangs.v));
  }

  /** Face colour instead of Mochi's grey. */
  faceFill(x: CanvasRenderingContext2D, ry: number): CanvasGradient {
    const g = x.createLinearGradient(0, -ry, 0, ry);
    g.addColorStop(0, FACE_TOP);
    g.addColorStop(1, FACE_BOTTOM);
    return g;
  }

  private hairFill(x: CanvasRenderingContext2D, top: number, bottom: number): CanvasGradient {
    const g = x.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, HAIR_TOP);
    g.addColorStop(1, HAIR_BOTTOM);
    return g;
  }

  /** The ponytail, behind the head. Body-local coordinates, already scaled. */
  drawBehind(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, yaw: number) {
    // The tie sits high on the right of the head and turns with it.
    const rootX = rx * 0.82 + Math.sin(yaw) * rx * 0.3;
    const rootY = -ry * 0.6;
    x.save();
    x.translate(rootX, rootY);
    x.rotate(this.pony.v);
    const p = new Path2D();
    // A thick lock that swings out, falls, and curls back at the tip.
    p.moveTo(-R * 0.16, -R * 0.02);
    p.bezierCurveTo(R * 0.62, -R * 0.12, R * 0.82, R * 0.55, R * 0.58, R * 1.08);
    p.bezierCurveTo(R * 0.5, R * 1.26, R * 0.26, R * 1.3, R * 0.2, R * 1.12);
    p.bezierCurveTo(R * 0.36, R * 1.14, R * 0.46, R * 0.92, R * 0.38, R * 0.66);
    p.bezierCurveTo(R * 0.28, R * 0.34, R * 0.08, R * 0.22, -R * 0.04, R * 0.18);
    p.closePath();
    x.fillStyle = this.hairFill(x, -R * 0.1, R * 1.3);
    x.fill(p);
    // One soft inner shade gives the lock volume without an outline.
    x.save();
    x.clip(p);
    x.fillStyle = HAIR_SHADE;
    x.beginPath();
    x.ellipse(R * 0.18, R * 0.7, R * 0.2, R * 0.55, -0.3, 0, Math.PI * 2);
    x.fill();
    x.restore();
    x.restore();
  }

  /**
   * Bangs and side locks, on the face (clipped to the head), drawn before the
   * eyes so a long fringe never covers them.
   */
  drawHair(x: CanvasRenderingContext2D, body: Path2D, R: number, rx: number, ry: number, yaw: number) {
    // The fringe follows the head turn, plus a little lag on fast turns.
    const shift = Math.sin(yaw) * rx * 0.5 + this.bangs.v * R;
    const p = new Path2D();
    p.moveTo(-rx * 1.4, ry * 0.5);
    p.lineTo(-rx * 1.4, -ry * 1.4);
    p.lineTo(rx * 1.4, -ry * 1.4);
    p.lineTo(rx * 1.4, ry * 0.5);
    // Right side lock, framing the face.
    p.quadraticCurveTo(rx * 0.98 + shift * 0.2, ry * 0.05, rx * 0.8 + shift * 0.4, -ry * 0.3);
    // Scalloped fringe from right to left: tips hang down, notches go up.
    const tips = [-0.1, -0.02, -0.07, -0.03, -0.12];
    const n = tips.length;
    const left = -rx * 0.8 + shift * 0.4;
    const right = rx * 0.8 + shift * 0.4;
    for (let i = 0; i < n; i++) {
      const xa = right + ((left - right) * i) / n;
      const xb = right + ((left - right) * (i + 1)) / n;
      const mid = (xa + xb) / 2;
      // Down to a soft point, back up to the next notch.
      p.quadraticCurveTo(xa + (mid - xa) * 0.3, ry * tips[i], mid, ry * tips[i]);
      p.quadraticCurveTo(xb - (xb - mid) * 0.3, ry * tips[i], xb, -ry * 0.36);
    }
    // Left side lock.
    p.quadraticCurveTo(-rx * 0.98 + shift * 0.2, ry * 0.05, -rx * 1.4, ry * 0.5);
    p.closePath();

    x.save();
    x.clip(body);
    x.fillStyle = this.hairFill(x, -ry, ry * 0.2);
    x.fill(p);
    // A sheen across the crown, like the figure's satin hair.
    const sheen = x.createRadialGradient(-rx * 0.15 + shift * 0.3, -ry * 0.62, 0, -rx * 0.15, -ry * 0.62, R * 0.55);
    sheen.addColorStop(0, "rgba(255, 220, 205, 0.32)");
    sheen.addColorStop(1, "rgba(255, 220, 205, 0)");
    x.fillStyle = sheen;
    x.fill(p);
    x.restore();
  }

  /** The bow, on top of everything at the ponytail's tie. */
  drawBow(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, yaw: number) {
    const bx = rx * 0.74 + Math.sin(yaw) * rx * 0.3;
    const by = -ry * 0.7;
    const squash = this.bow.v;
    x.save();
    x.translate(bx, by + squash * R * 0.05);
    x.rotate(0.28 + this.pony.v * 0.25);
    x.scale(1.3 * (1 + squash * 0.22), 1.3 * (1 - squash * 0.16));

    const loop = (side: number) => {
      const p = new Path2D();
      p.moveTo(0, 0);
      p.bezierCurveTo(side * R * 0.14, -R * 0.26, side * R * 0.42, -R * 0.22, side * R * 0.4, -R * 0.02);
      p.bezierCurveTo(side * R * 0.38, R * 0.14, side * R * 0.14, R * 0.12, 0, 0);
      return p;
    };
    const tail = (side: number) => {
      const p = new Path2D();
      p.moveTo(0, 0);
      p.lineTo(side * R * 0.1, R * 0.26);
      p.lineTo(side * R * 0.2, R * 0.22);
      p.closePath();
      return p;
    };

    const fill = x.createLinearGradient(0, -R * 0.24, 0, R * 0.2);
    fill.addColorStop(0, BOW_LIGHT);
    fill.addColorStop(1, BOW_SHADE);
    x.fillStyle = fill;
    for (const side of [-1, 1]) {
      x.fill(tail(side));
      x.fill(loop(side));
    }
    // The knot, slightly shaded so the loops read as folded ribbon.
    x.fillStyle = BOW_SHADE;
    x.beginPath();
    x.ellipse(0, 0, R * 0.07, R * 0.08, 0, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }
}
