/**
 * The physics, and nothing else (no DOM, no three.js).
 *
 * A thin plate (plane stress) with a traction-free hole, loaded far away by a uniform stress.
 * Lengths are in units of the hole's half-width a (a = 10 mm on the bench); stresses in MPa.
 * x points right, y points up (the grips pull along y).
 *
 * - Circular hole: the exact Kirsch solution in polar form, rotated to Cartesian, superposed for
 *   biaxial and shear far-field loads (each principal far-field stress is its own Kirsch problem).
 * - Elliptical hole / slot: the Inglis / Muskhelishvili complex-potential solution through the
 *   conformal map z = R (ζ + m / ζ), evaluated numerically. Edge stress at the tip of an ellipse
 *   with semi-axes a (across the pull) and b (along it) is S (1 + 2a/b).
 * - Principal stresses, traction on a cut (t = σ n), change of axes (σ' = Q σ Qᵀ), invariants.
 * - Photoelastic fringe order N = h (σ1 − σ2) / f_σ and the isochromatic colour of a dark-field
 *   circular polariscope, integrated over the visible spectrum (Michel-Lévy sequence).
 */

export interface Sym2 {
  xx: number;
  yy: number;
  xy: number;
}

export type HoleShape = "circle" | "ellipse" | "slot";
export type Loading = "pull" | "biaxial" | "shear";

/** Plate half-size in units of a (the plate is 72 mm × 96 mm, 3:4). */
export const PLATE = { halfW: 3.6, halfH: 4.8 };
/** Bench numbers: hole half-width, plate thickness, fringe constant of polycarbonate. */
export const HOLE_MM = 10;
export const THICK_MM = 3;
export const F_SIGMA = 7; // N/mm per fringe
/** Fringe orders per MPa of principal-stress difference. */
export const N_PER_MPA = THICK_MM / F_SIGMA;
export const LOAD_MAX = 6; // MPa at the grips
export const LOAD_DEFAULT = 3.5;

export interface Hole {
  shape: HoleShape;
  /** Semi-axis across the pull (x) and along it (y), in units of a. */
  ax: number;
  by: number;
}

export function makeHole(shape: HoleShape, slotRatio: number): Hole {
  if (shape === "circle") return { shape, ax: 1, by: 1 };
  if (shape === "ellipse") return { shape, ax: 1, by: 0.5 };
  return { shape, ax: 1, by: 1 / Math.max(1.5, slotRatio) };
}

/** Far-field (grip) stress tensor for a load S. */
export function remoteStress(loading: Loading, S: number): Sym2 {
  if (loading === "biaxial") return { xx: S, yy: S, xy: 0 };
  if (loading === "shear") return { xx: 0, yy: 0, xy: S };
  return { xx: 0, yy: S, xy: 0 };
}

// ───────────────────────── Kirsch (circular hole) ─────────────────────────

export interface Polar {
  rr: number;
  tt: number;
  rt: number;
}

/** Kirsch polar stresses for a uniaxial far-field S; θ measured from the load axis. */
export function kirschPolar(S: number, a: number, r: number, theta: number): Polar {
  const q = (a * a) / (r * r);
  const q2 = q * q;
  const c2 = Math.cos(2 * theta);
  const s2 = Math.sin(2 * theta);
  return {
    rr: (S / 2) * (1 - q) + (S / 2) * (1 - 4 * q + 3 * q2) * c2,
    tt: (S / 2) * (1 + q) - (S / 2) * (1 + 3 * q2) * c2,
    rt: -(S / 2) * (1 + 2 * q - 3 * q2) * s2,
  };
}

/** Cartesian stress at (x, y) from a uniaxial far-field S applied along the direction at angle beta (radians from +x). */
export function kirschUniaxial(S: number, a: number, x: number, y: number, beta: number): Sym2 {
  // local frame: u along the load, v perpendicular
  const cb = Math.cos(beta), sb = Math.sin(beta);
  const u = x * cb + y * sb;
  const v = -x * sb + y * cb;
  const r = Math.max(a, Math.hypot(u, v));
  const th = Math.atan2(v, u);
  const p = kirschPolar(S, a, r, th);
  const c = Math.cos(th), s = Math.sin(th);
  // polar → local Cartesian (u, v)
  const uu = p.rr * c * c + p.tt * s * s - 2 * p.rt * s * c;
  const vv = p.rr * s * s + p.tt * c * c + 2 * p.rt * s * c;
  const uv = (p.rr - p.tt) * s * c + p.rt * (c * c - s * s);
  // local → global: Q = [d, d⊥] with d = (cb, sb)
  return {
    xx: uu * cb * cb + vv * sb * sb - 2 * uv * sb * cb,
    yy: uu * sb * sb + vv * cb * cb + 2 * uv * sb * cb,
    xy: (uu - vv) * sb * cb + uv * (cb * cb - sb * sb),
  };
}

/** Circular hole under any far-field tensor: superpose a Kirsch problem for each principal far-field stress. */
export function kirschGeneral(remote: Sym2, a: number, x: number, y: number): Sym2 {
  const p = principal(remote);
  const b = (p.angleDeg * Math.PI) / 180;
  const A = kirschUniaxial(p.s1, a, x, y, b);
  const B = kirschUniaxial(p.s2, a, x, y, b + Math.PI / 2);
  return { xx: A.xx + B.xx, yy: A.yy + B.yy, xy: A.xy + B.xy };
}

// ───────────────────────── Inglis / Muskhelishvili (elliptical hole) ─────────────────────────

/** Scratch complex results (keeps the per-pixel field loop allocation-free). */
let cr = 0, ci = 0;
function cmul(ar: number, ai: number, br: number, bi: number): void {
  cr = ar * br - ai * bi;
  ci = ar * bi + ai * br;
}
function cdiv(ar: number, ai: number, br: number, bi: number): void {
  const d = br * br + bi * bi;
  cr = (ar * br + ai * bi) / d;
  ci = (ai * br - ar * bi) / d;
}

export interface EllipseSolver {
  R: number;
  m: number;
  /** Stress at (x, y); points inside the hole are evaluated on its rim. */
  at(x: number, y: number): Sym2;
  /** Stress on the rim at map parameter t (ζ = e^{it}). */
  rim(t: number): Sym2;
}

/**
 * Muskhelishvili potentials for a traction-free elliptical hole (semi-axes ax along x, by along y)
 * under a uniform far-field stress. z = ω(ζ) = R (ζ + m/ζ), |ζ| ≥ 1.
 *   φ(ζ) = A ζ + B / ζ,  A = Γ R,  B = −R (conj Γ' + m Γ)
 *   ψ(ζ) = −conj(φ)(1/ζ) − conj(ω)(1/ζ) φ'(ζ) / ω'(ζ)   (from the free-edge condition)
 *   σxx + σyy = 4 Re Φ,  σyy − σxx + 2i σxy = 2 (z̄ Φ'(z) + Ψ(z)),
 * with Γ = (σxx∞ + σyy∞)/4, Γ' = (σyy∞ − σxx∞)/2 + i σxy∞.
 */
export function ellipseSolver(remote: Sym2, ax: number, by: number): EllipseSolver {
  const R = (ax + by) / 2;
  const m = (ax - by) / (ax + by);
  const G = (remote.xx + remote.yy) / 4;
  const Gpr = (remote.yy - remote.xx) / 2, Gpi = remote.xy;
  const A = G * R; // real
  const Br = -R * (Gpr + m * G), Bi = R * Gpi; // B = −R (conj Γ' + m Γ)

  function evalZeta(zr: number, zi: number): Sym2 {
    // powers of ζ
    cmul(zr, zi, zr, zi);
    const z2r = cr, z2i = ci;
    cmul(z2r, z2i, zr, zi);
    const z3r = cr, z3i = ci;
    // φ'(ζ) = A − B/ζ²
    cdiv(Br, Bi, z2r, z2i);
    const p1r = A - cr, p1i = -ci;
    // φ''(ζ) = 2B/ζ³
    cdiv(2 * Br, 2 * Bi, z3r, z3i);
    const p2r = cr, p2i = ci;
    // ω'(ζ) = R(1 − m/ζ²), ω''(ζ) = 2Rm/ζ³
    cdiv(m, 0, z2r, z2i);
    const w1r = R * (1 - cr), w1i = -R * ci;
    cdiv(2 * R * m, 0, z3r, z3i);
    const w2r = cr, w2i = ci;
    // Φ = φ'/ω'
    cdiv(p1r, p1i, w1r, w1i);
    const Pr = cr;
    // dΦ/dz = (φ''ω' − φ'ω'') / ω'³
    cmul(p2r, p2i, w1r, w1i);
    const t1r = cr, t1i = ci;
    cmul(p1r, p1i, w2r, w2i);
    const numr = t1r - cr, numi = t1i - ci;
    cmul(w1r, w1i, w1r, w1i);
    cmul(cr, ci, w1r, w1i);
    cdiv(numr, numi, cr, ci);
    const dPr = cr, dPi = ci;
    // ψ'(ζ) = conj(A)/ζ² − conj(B) − g'(ζ),  g = N/D,  N = (1 + mζ²)(Aζ² − B),  D = ζ³ − mζ
    // N = A m ζ⁴ + (A − B m) ζ² − B,  N' = 4 A m ζ³ + 2 (A − B m) ζ,  D' = 3ζ² − m
    cmul(z2r, z2i, z2r, z2i);
    const z4r = cr, z4i = ci;
    const kr = A - Br * m, ki = -Bi * m;
    cmul(kr, ki, z2r, z2i);
    const Nr = A * m * z4r + cr - Br, Ni = A * m * z4i + ci - Bi;
    cmul(kr, ki, zr, zi);
    const N1r = 4 * A * m * z3r + 2 * cr, N1i = 4 * A * m * z3i + 2 * ci;
    const Dr = z3r - m * zr, Di = z3i - m * zi;
    const D1r = 3 * z2r - m, D1i = 3 * z2i;
    cmul(N1r, N1i, Dr, Di);
    const ar = cr, ai = ci;
    cmul(Nr, Ni, D1r, D1i);
    const gnr = ar - cr, gni = ai - ci;
    cmul(Dr, Di, Dr, Di);
    cdiv(gnr, gni, cr, ci);
    const g1r = cr, g1i = ci;
    cdiv(A, 0, z2r, z2i);
    const s1r = cr - Br - g1r, s1i = ci + Bi - g1i;
    // Ψ = ψ'/ω'
    cdiv(s1r, s1i, w1r, w1i);
    const Qr0 = cr, Qi0 = ci;
    // z̄ with z = ω(ζ)
    cdiv(m, 0, zr, zi);
    const xr = R * (zr + cr), xi = R * (zi + ci);
    cmul(xr, -xi, dPr, dPi);
    const Qr = 2 * (cr + Qr0), Qi = 2 * (ci + Qi0);
    const P = 4 * Pr;
    return { xx: (P - Qr) / 2, yy: (P + Qr) / 2, xy: Qi / 2 };
  }

  return {
    R,
    m,
    at(x: number, y: number): Sym2 {
      // invert z = R(ζ + m/ζ): R ζ² − z ζ + R m = 0, keep the root outside the unit circle
      const ar = x * x - y * y - 4 * R * R * m, ai = 2 * x * y;
      const mod = Math.hypot(ar, ai);
      const sr = Math.sqrt(Math.max(0, (mod + ar) / 2));
      let si = Math.sqrt(Math.max(0, (mod - ar) / 2));
      if (ai < 0) si = -si;
      let zr = (x + sr) / (2 * R), zi = (y + si) / (2 * R);
      const or = (x - sr) / (2 * R), oi = (y - si) / (2 * R);
      if (or * or + oi * oi > zr * zr + zi * zi) {
        zr = or;
        zi = oi;
      }
      const n = Math.hypot(zr, zi);
      if (n < 1) {
        if (n < 1e-12) {
          zr = 1;
          zi = 0;
        } else {
          zr /= n;
          zi /= n;
        }
      }
      return evalZeta(zr, zi);
    },
    rim(t: number): Sym2 {
      return evalZeta(Math.cos(t), Math.sin(t));
    },
  };
}

// ───────────────────────── the field of a given rig ─────────────────────────

export interface Field {
  hole: Hole;
  loading: Loading;
  /** Stress at (x, y) for a unit grip load (the field is linear in the load). */
  unit(x: number, y: number): Sym2;
  /** Stress at (x, y) for grip load S. */
  at(x: number, y: number, S: number): Sym2;
  /** Concentration factor: the largest |principal stress| on the hole's edge ÷ the grip load. */
  K: number;
  /** Where on the rim that happens. */
  hot: { x: number; y: number };
  /** Largest σ1 − σ2 on the rim per unit load (sets the highest fringe order). */
  rimDiff: number;
}

export function makeField(hole: Hole, loading: Loading): Field {
  const remote = remoteStress(loading, 1);
  let unit: (x: number, y: number) => Sym2;
  let rimAt: (t: number) => { s: Sym2; x: number; y: number };
  if (hole.shape === "circle") {
    unit = (x, y) => kirschGeneral(remote, hole.ax, x, y);
    rimAt = (t) => {
      const x = hole.ax * Math.cos(t), y = hole.ax * Math.sin(t);
      return { s: unit(x, y), x, y };
    };
  } else {
    const sol = ellipseSolver(remote, hole.ax, hole.by);
    unit = (x, y) => sol.at(x, y);
    rimAt = (t) => ({ s: sol.rim(t), x: hole.ax * Math.cos(t), y: hole.by * Math.sin(t) });
  }
  let K = 0, rimDiff = 0, hot = { x: hole.ax, y: 0 };
  for (let i = 0; i < 720; i++) {
    const r = rimAt((i / 720) * 2 * Math.PI);
    const p = principal(r.s);
    const v = Math.max(Math.abs(p.s1), Math.abs(p.s2));
    rimDiff = Math.max(rimDiff, p.s1 - p.s2);
    if (v > K + 1e-9) {
      K = v;
      hot = { x: r.x, y: r.y };
    }
  }
  return {
    hole,
    loading,
    unit,
    at: (x, y, S) => scale(unit(x, y), S),
    K,
    hot,
    rimDiff,
  };
}

export function insideHole(hole: Hole, x: number, y: number): boolean {
  return (x / hole.ax) ** 2 + (y / hole.by) ** 2 < 1;
}

/** Keep a point on the plate and out of the hole (pushed radially out to the rim). */
export function clampToPlate(hole: Hole, x: number, y: number, margin = { x: 0.4, y: 1.2 }): { x: number; y: number } {
  x = Math.max(-PLATE.halfW + margin.x, Math.min(PLATE.halfW - margin.x, x));
  y = Math.max(-PLATE.halfH + margin.y, Math.min(PLATE.halfH - margin.y, y));
  const q = (x / hole.ax) ** 2 + (y / hole.by) ** 2;
  if (q < 1) {
    if (q < 1e-12) return { x: hole.ax, y: 0 };
    const k = 1 / Math.sqrt(q);
    return { x: x * k, y: y * k };
  }
  return { x, y };
}

// ───────────────────────── tensor algebra ─────────────────────────

export function scale(s: Sym2, k: number): Sym2 {
  return { xx: s.xx * k, yy: s.yy * k, xy: s.xy * k };
}

export interface Principal {
  s1: number;
  s2: number;
  /** Direction of σ1, degrees from +x, in (−90, 90]. */
  angleDeg: number;
  maxShear: number;
}

export function principal(s: Sym2): Principal {
  const c = (s.xx + s.yy) / 2;
  const R = Math.hypot((s.xx - s.yy) / 2, s.xy);
  let ang = (0.5 * Math.atan2(2 * s.xy, s.xx - s.yy) * 180) / Math.PI;
  if (ang <= -90) ang += 180;
  return { s1: c + R, s2: c - R, angleDeg: ang, maxShear: R };
}

export interface Traction {
  /** The force per area on the cut, t = σ n (MPa). */
  tx: number;
  ty: number;
  /** n·t: pull if positive, push if negative. */
  normal: number;
  /** Component along the cut (signed along s = (cos φ, sin φ)). */
  shear: number;
  n: [number, number];
  s: [number, number];
}

/** Traction on a cut whose line makes angle phi (degrees) with +x; its normal is n = (−sin φ, cos φ). */
export function traction(sig: Sym2, phiDeg: number): Traction {
  const p = (phiDeg * Math.PI) / 180;
  const sx = Math.cos(p), sy = Math.sin(p);
  const nx = -sy, ny = sx;
  const tx = sig.xx * nx + sig.xy * ny;
  const ty = sig.xy * nx + sig.yy * ny;
  return { tx, ty, normal: tx * nx + ty * ny, shear: tx * sx + ty * sy, n: [nx, ny], s: [sx, sy] };
}

/** Components in axes turned by alpha (degrees): e1' = (cos α, sin α), e2' = (−sin α, cos α); σ' = Q σ Qᵀ. */
export function rotate(s: Sym2, alphaDeg: number): Sym2 {
  const a = (alphaDeg * Math.PI) / 180;
  const c = Math.cos(a), n = Math.sin(a);
  return {
    xx: s.xx * c * c + 2 * s.xy * c * n + s.yy * n * n,
    yy: s.xx * n * n - 2 * s.xy * c * n + s.yy * c * c,
    xy: (s.yy - s.xx) * c * n + s.xy * (c * c - n * n),
  };
}

/** The full 3×3 plane-stress tensor (σzz = σxz = σyz = 0 in a thin plate). */
export function full3(s: Sym2): number[][] {
  return [
    [s.xx, s.xy, 0],
    [s.xy, s.yy, 0],
    [0, 0, 0],
  ];
}

export interface Invariants {
  trace: number;
  det: number;
  s1: number;
  s2: number;
  vonMises: number;
}

export function invariants(s: Sym2): Invariants {
  const p = principal(s);
  return {
    trace: s.xx + s.yy,
    det: s.xx * s.yy - s.xy * s.xy,
    s1: p.s1,
    s2: p.s2,
    vonMises: Math.sqrt(p.s1 * p.s1 - p.s1 * p.s2 + p.s2 * p.s2),
  };
}

/** Closed-form 2D traction (the textbook stress-transformation formulas), used to cross-check t = σ n. */
export function tractionClosedForm(s: Sym2, phiDeg: number): { normal: number; shear: number } {
  // normal at angle θ = φ + 90° from x: σn = (σx+σy)/2 + (σx−σy)/2 cos2θ + τ sin2θ
  const th = ((phiDeg + 90) * Math.PI) / 180;
  const normal = (s.xx + s.yy) / 2 + ((s.xx - s.yy) / 2) * Math.cos(2 * th) + s.xy * Math.sin(2 * th);
  // shear along s = n turned −90°: τ = −(σx−σy)/2 sin2θ + τ cos2θ, sign flipped for that orientation
  const shear = -(-((s.xx - s.yy) / 2) * Math.sin(2 * th) + s.xy * Math.cos(2 * th));
  return { normal, shear };
}

// ───────────────────────── photoelastic colour ─────────────────────────

/** Fringe order for a principal-stress difference (MPa). */
export const fringeOrder = (dSigma: number) => N_PER_MPA * Math.abs(dSigma);

/** Wyman–Sloan–Shirley multi-lobe fit of the CIE 1931 colour-matching functions. */
function g(l: number, mu: number, s1: number, s2: number): number {
  const t = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cmf(l: number): [number, number, number] {
  return [
    1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2),
    0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1),
    1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8),
  ];
}
const LAMBDA0 = 560; // nm: one fringe order of retardation
const WL: number[] = [];
for (let l = 390; l <= 720; l += 5) WL.push(l);
const CMF = WL.map(cmf);
const xyzToLin = (X: number, Y: number, Z: number): [number, number, number] => [
  3.2406 * X - 1.5372 * Y - 0.4986 * Z,
  -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
  0.0557 * X - 0.204 * Y + 1.057 * Z,
];
const WHITE = (() => {
  let X = 0, Y = 0, Z = 0;
  for (const c of CMF) {
    X += c[0];
    Y += c[1];
    Z += c[2];
  }
  return xyzToLin(X, Y, Z);
})();
const toSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** Display tuning: exposure and a saturation lift (the hue sequence itself is computed). */
const EXPOSURE = 0.72;
const SAT = 1.3;

/**
 * Isochromatic colour (sRGB, 0..1) at fringe order N for white light through a dark-field circular
 * polariscope: intensity at wavelength λ is sin²(π N λ0 / λ), integrated against the eye's colour
 * matching functions. N = 0 is black; then grey, white, yellow, orange, magenta, blue, green, yellow…
 */
export function fringeColor(N: number): [number, number, number] {
  let X = 0, Y = 0, Z = 0;
  for (let i = 0; i < WL.length; i++) {
    const s = Math.sin((Math.PI * N * LAMBDA0) / WL[i]);
    const I = s * s;
    X += I * CMF[i][0];
    Y += I * CMF[i][1];
    Z += I * CMF[i][2];
  }
  const lin = xyzToLin(X, Y, Z);
  let r = (lin[0] / WHITE[0]) * EXPOSURE, gg = (lin[1] / WHITE[1]) * EXPOSURE, b = (lin[2] / WHITE[2]) * EXPOSURE;
  // high orders wash out towards pastel in white light; lift their (still computed) hue a little more
  const sat = SAT * Math.min(3.2, 1 + 0.3 * Math.max(0, N - 2));
  const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
  r = L + (r - L) * sat;
  gg = L + (gg - L) * sat;
  b = L + (b - L) * sat;
  const c = (v: number) => Math.max(0, Math.min(1, toSrgb(Math.max(0, v))));
  return [c(r), c(gg), c(b)];
}

/** Colour lookup table: LUT_SIZE entries spanning fringe orders 0..LUT_MAX_N (RGBA8, sRGB). */
export const LUT_MAX_N = 48;
export const LUT_SIZE = 4096;
let lut: Uint8Array | null = null;
export function fringeLut(): Uint8Array {
  if (lut) return lut;
  lut = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const c = fringeColor((i / (LUT_SIZE - 1)) * LUT_MAX_N);
    lut[i * 4] = Math.round(c[0] * 255);
    lut[i * 4 + 1] = Math.round(c[1] * 255);
    lut[i * 4 + 2] = Math.round(c[2] * 255);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

// ───────────────────────── sampled field (for the fringe texture) ─────────────────────────

export interface FieldGrid {
  w: number;
  h: number;
  /** Per texel, for unit grip load: σ1 − σ2, cos 2θp, sin 2θp, and 1 inside the hole (else 0). */
  data: Float32Array;
  /** Largest σ1 − σ2 on the grid, per unit load. */
  maxDiff: number;
}

/** Sample the unit-load field over the plate face; texel (i, j) sits at x = −W + (i+½)·2W/w, y = +H − (j+½)·2H/h (row 0 = top). */
export function sampleField(field: Field, w: number, h: number): FieldGrid {
  const data = new Float32Array(w * h * 4);
  let maxDiff = 0;
  const { halfW, halfH } = PLATE;
  for (let j = 0; j < h; j++) {
    const y = halfH - ((j + 0.5) / h) * 2 * halfH;
    for (let i = 0; i < w; i++) {
      const x = -halfW + ((i + 0.5) / w) * 2 * halfW;
      const s = field.unit(x, y);
      const c = (s.xx - s.yy) / 2;
      const R = Math.hypot(c, s.xy);
      const k = (j * w + i) * 4;
      data[k] = 2 * R;
      if (R > 1e-12) {
        data[k + 1] = c / R;
        data[k + 2] = s.xy / R;
      } else {
        data[k + 1] = 1;
        data[k + 2] = 0;
      }
      data[k + 3] = insideHole(field.hole, x, y) ? 1 : 0;
      if (data[k + 3] === 0 && 2 * R > maxDiff) maxDiff = 2 * R;
    }
  }
  return { w, h, data, maxDiff };
}

// ───────────────────────── self-test ─────────────────────────

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export function selfTest(): { pass: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const S = 5;
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));

  // Kirsch at the rim
  const side = kirschPolar(S, 1, 1, Math.PI / 2);
  add("Kirsch hoop stress at the side of the hole (r=a, θ=90°) = 3S", rel(side.tt, 3 * S) < 1e-6, `σθθ = ${side.tt.toFixed(9)} vs ${3 * S}`);
  const top = kirschPolar(S, 1, 1, 0);
  add("Kirsch hoop stress at the top of the hole (r=a, θ=0) = −S", rel(top.tt, -S) < 1e-6, `σθθ = ${top.tt.toFixed(9)} vs ${-S}`);
  add("Hole edge is traction-free (σrr = τrθ = 0 at r=a)", Math.abs(side.rr) < 1e-9 && Math.abs(kirschPolar(S, 1, 1, 0.7).rt) < 1e-9, `σrr = ${side.rr.toExponential(2)}`);
  // Cartesian conversion agrees at the side: σyy = 3S there
  const cs = kirschUniaxial(S, 1, 1, 0, Math.PI / 2);
  add("Cartesian Kirsch at (a, 0): σyy = 3S, σxx = 0", rel(cs.yy, 3 * S) < 1e-6 && Math.abs(cs.xx) < 1e-9, `σ = [${cs.xx.toFixed(4)}, ${cs.yy.toFixed(4)}, ${cs.xy.toFixed(4)}]`);
  // far field
  const far = kirschUniaxial(S, 1, 50 * Math.cos(0.6), 50 * Math.sin(0.6), Math.PI / 2);
  const farErr = Math.max(Math.abs(far.xx), Math.abs(far.yy - S), Math.abs(far.xy)) / S;
  add("Far field (r = 50a) ≈ [[0, 0], [0, S]]", farErr < 2e-3, `max deviation ${(farErr * 100).toFixed(3)} % of S`);

  // traction vs closed form, many cuts
  const sig: Sym2 = { xx: 3.2, yy: -1.7, xy: 2.4 };
  let tErr = 0;
  for (let p = 0; p < 180; p += 7.5) {
    const t = traction(sig, p), c = tractionClosedForm(sig, p);
    tErr = Math.max(tErr, Math.abs(t.normal - c.normal), Math.abs(t.shear - c.shear));
  }
  add("Traction t = σn matches the closed-form normal/shear formulas", tErr < 1e-9, `max error ${tErr.toExponential(2)} MPa`);

  // invariants under rotation
  const inv0 = invariants(sig);
  let invErr = 0;
  for (let a = 0; a < 360; a += 13) {
    const i1 = invariants(rotate(sig, a));
    invErr = Math.max(invErr, Math.abs(i1.trace - inv0.trace), Math.abs(i1.det - inv0.det), Math.abs(i1.s1 - inv0.s1), Math.abs(i1.s2 - inv0.s2));
  }
  add("Trace, determinant and principal stresses unchanged when the axes turn", invErr < 1e-9, `max change ${invErr.toExponential(2)}`);
  const r90 = rotate(sig, 90);
  add("Turning the axes 90° swaps σxx and σyy and flips τ", Math.abs(r90.xx - sig.yy) < 1e-9 && Math.abs(r90.yy - sig.xx) < 1e-9 && Math.abs(r90.xy + sig.xy) < 1e-9, `σ' = [${r90.xx.toFixed(3)}, ${r90.yy.toFixed(3)}, ${r90.xy.toFixed(3)}]`);

  // principal cut has no shear
  const pr = principal(sig);
  const tp = traction(sig, pr.angleDeg - 90); // cut perpendicular to σ1 → normal along σ1
  add("No shear on a principal cut, and the pull there is σ1", Math.abs(tp.shear) < 1e-9 && Math.abs(tp.normal - pr.s1) < 1e-9, `shear ${tp.shear.toExponential(2)}, normal ${tp.normal.toFixed(4)} vs σ1 ${pr.s1.toFixed(4)}`);

  // elliptical solver: m = 0 reproduces Kirsch everywhere
  let eErr = 0;
  for (const rem of [remoteStress("pull", 1), remoteStress("biaxial", 1), remoteStress("shear", 1)]) {
    const sol = ellipseSolver(rem, 1, 1);
    for (let k = 0; k < 40; k++) {
      const r = 1 + (k % 8) * 0.37, t = k * 0.71;
      const x = r * Math.cos(t), y = r * Math.sin(t);
      const a = sol.at(x, y), b = kirschGeneral(rem, 1, x, y);
      eErr = Math.max(eErr, Math.abs(a.xx - b.xx), Math.abs(a.yy - b.yy), Math.abs(a.xy - b.xy));
    }
  }
  add("Inglis/Muskhelishvili solver with a circle (m = 0) equals Kirsch (pull, both ways, shear)", eErr < 1e-9, `max difference ${eErr.toExponential(2)}`);

  // slot tip
  for (const ratio of [2, 5, 8]) {
    const sol = ellipseSolver(remoteStress("pull", 1), 1, 1 / ratio);
    const tip = sol.rim(0).yy;
    add(`Slot tip stress ratio = 1 + 2a/b (a/b = ${ratio})`, rel(tip, 1 + 2 * ratio) < 1e-6, `${tip.toFixed(6)} vs ${1 + 2 * ratio}`);
  }
  // ellipse rim is traction-free and the far field is recovered
  {
    const ax = 1, by = 0.3;
    const sol = ellipseSolver({ xx: 0.4, yy: 1, xy: 0.3 }, ax, by);
    let free = 0;
    for (let k = 0; k < 24; k++) {
      const t = (k / 24) * 2 * Math.PI + 0.05;
      const s = sol.rim(t);
      // outward normal of the ellipse (x/ax)² + (y/by)² = 1 at (ax cos t, by sin t)
      let nx = Math.cos(t) / ax, ny = Math.sin(t) / by;
      const nn = Math.hypot(nx, ny);
      nx /= nn;
      ny /= nn;
      free = Math.max(free, Math.hypot(s.xx * nx + s.xy * ny, s.xy * nx + s.yy * ny));
    }
    const f = sol.at(300, 170);
    const ff = Math.max(Math.abs(f.xx - 0.4), Math.abs(f.yy - 1), Math.abs(f.xy - 0.3));
    add("Elliptical hole: edge is traction-free and the far field is the grip load", free < 1e-9 && ff < 1e-3, `edge traction ${free.toExponential(2)}, far-field error ${ff.toExponential(2)}`);
  }
  // concentration factors of the live field
  const kc = makeField(makeHole("circle", 6), "pull").K;
  const kb = makeField(makeHole("circle", 6), "biaxial").K;
  const ks = makeField(makeHole("circle", 6), "shear").K;
  add("Concentration factor: 3 (pull), 2 (pull both ways), 4 (shear) for a round hole", rel(kc, 3) < 1e-6 && rel(kb, 2) < 1e-6 && rel(ks, 4) < 1e-4, `K = ${kc.toFixed(5)}, ${kb.toFixed(5)}, ${ks.toFixed(5)}`);

  // colour
  const c0 = fringeColor(0);
  add("Fringe colour at zero stress is black", c0[0] === 0 && c0[1] === 0 && c0[2] === 0, `rgb(${c0.map((v) => v.toFixed(3)).join(", ")})`);
  const c1 = fringeColor(1);
  add("First-order fringe (N = 1) is the magenta/violet tint of passage", c1[0] > c1[1] && c1[2] > c1[1], `rgb(${c1.map((v) => v.toFixed(2)).join(", ")})`);

  return { pass: checks.every((c) => c.pass), checks };
}
