// The generic machinery of a cut-out puppet: springs, mip-mapped layers and the
// grid warp that bends a ponytail. Used by HairSkin (hair.ts), which draws any
// imported skin bundle.

export type Pt = readonly [number, number];

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** A damped spring on one value: `v'' = k·(rest − v) − c·v' + push`. */
export class Spring {
  v = 0;
  vel = 0;
  constructor(public k: number, public c: number) {}
  step(rest: number, push: number, dt: number) {
    this.vel += (this.k * (rest - this.v) - this.c * this.vel + push) * dt;
    this.v += this.vel * dt;
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One picture layer, kept at a few sizes. Drawing a 1300 px picture straight
 * down to ~100 px would shimmer; each frame draws from the smallest copy that
 * is still at least as big as needed. `crop` is the part of the picture used.
 */
export class Layer {
  /** levels[n] is the crop at 1/2^(n+1) of the picture's size. */
  readonly levels: HTMLCanvasElement[] = [];

  constructor(img: CanvasImageSource, readonly crop: Rect) {
    const first = document.createElement("canvas");
    first.width = crop.w;
    first.height = crop.h;
    first.getContext("2d")!.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    let src = first;
    for (let n = 0; n < 5; n++) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(src.width / 2));
      c.height = Math.max(1, Math.round(src.height / 2));
      const x = c.getContext("2d")!;
      x.imageSmoothingQuality = "high";
      x.drawImage(src, 0, 0, c.width, c.height);
      this.levels.push(c);
      src = c;
    }
  }

  /** The copy to draw at `scale` screen px per picture px. */
  pick(scale: number): HTMLCanvasElement {
    for (let n = this.levels.length - 1; n >= 0; n--) {
      if (1 / 2 ** (n + 1) >= scale) return this.levels[n];
    }
    return this.levels[0];
  }

  /** Draws the whole crop, in picture coordinates. */
  draw(x: CanvasRenderingContext2D, scale: number) {
    x.drawImage(this.pick(scale), this.crop.x, this.crop.y, this.crop.w, this.crop.h);
  }
}

export interface BendSpec {
  root: Pt;
  tipY: number;
  /** The area of the picture the grid covers: [x0, y0, x1, y1]. */
  bounds: readonly [number, number, number, number];
  cols: number;
  rows: number;
}

/**
 * Draws a layer bent about its root instead of swung stiffly: a grid over it is
 * deformed so the root stays put and the tip whips, and the picture is mapped
 * onto the bent grid, two triangles per cell.
 */
export function drawBent(x: CanvasRenderingContext2D, layer: Layer, scale: number, angle: number, spec: BendSpec) {
  const tex = layer.pick(scale);
  const ts = tex.width / layer.crop.w; // texture px per picture px
  const [x0, y0, x1, y1] = spec.bounds;
  const [rx, ry] = spec.root;
  const bend = (px: number, py: number): Pt => {
    const f = clamp((py - ry) / (spec.tipY - ry || 1), 0, 1) ** 1.5;
    const a = angle * f;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const dx = px - rx;
    const dy = py - ry;
    return [rx + dx * c - dy * s, ry + dx * s + dy * c];
  };
  const grid: Pt[][] = [];
  for (let j = 0; j <= spec.rows; j++) {
    const row: Pt[] = [];
    for (let i = 0; i <= spec.cols; i++) row.push([x0 + ((x1 - x0) * i) / spec.cols, y0 + ((y1 - y0) * j) / spec.rows]);
    grid.push(row);
  }
  const tri = (a: Pt, b: Pt, c: Pt) => {
    const A = bend(...a);
    const B = bend(...b);
    const C = bend(...c);
    const u = (q: Pt): Pt => [(q[0] - layer.crop.x) * ts, (q[1] - layer.crop.y) * ts];
    const [ua, va] = u(a);
    const [ub, vb] = u(b);
    const [uc, vc] = u(c);
    // Affine map texture → bent picture space.
    const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
    if (Math.abs(det) < 1e-9) return;
    const m11 = ((B[0] - A[0]) * (vc - va) - (C[0] - A[0]) * (vb - va)) / det;
    const m12 = ((B[1] - A[1]) * (vc - va) - (C[1] - A[1]) * (vb - va)) / det;
    const m21 = ((C[0] - A[0]) * (ub - ua) - (B[0] - A[0]) * (uc - ua)) / det;
    const m22 = ((C[1] - A[1]) * (ub - ua) - (B[1] - A[1]) * (uc - ua)) / det;
    const dx = A[0] - m11 * ua - m21 * va;
    const dy = A[1] - m12 * ua - m22 * va;
    x.save();
    // Grown a hair outwards so neighbouring triangles leave no seams.
    const cx = (A[0] + B[0] + C[0]) / 3;
    const cy = (A[1] + B[1] + C[1]) / 3;
    // By a pixel and a half of the canvas at least: at small sizes 2.5 picture
    // px is under a pixel, the antialiased clip edges of neighbours no longer
    // overlap, and a light line shows through the seam.
    const by = Math.max(2.5, 1.5 / scale);
    const grow = (q: Pt): Pt => {
      const d = Math.hypot(q[0] - cx, q[1] - cy) || 1;
      return [q[0] + ((q[0] - cx) / d) * by, q[1] + ((q[1] - cy) / d) * by];
    };
    const [ga, gb, gc] = [grow(A), grow(B), grow(C)];
    x.beginPath();
    x.moveTo(ga[0], ga[1]);
    x.lineTo(gb[0], gb[1]);
    x.lineTo(gc[0], gc[1]);
    x.closePath();
    x.clip();
    x.transform(m11, m12, m21, m22, dx, dy);
    x.drawImage(tex, 0, 0);
    x.restore();
  };
  for (let j = 0; j < spec.rows; j++) {
    for (let i = 0; i < spec.cols; i++) {
      tri(grid[j][i], grid[j][i + 1], grid[j + 1][i]);
      tri(grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]);
    }
  }
}
