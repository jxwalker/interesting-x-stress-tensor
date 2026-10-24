/** Demo state, smooth programmatic moves (tweens), the opening sequence, and everything derived from the physics. */
import {
  LOAD_DEFAULT,
  N_PER_MPA,
  clampToPlate,
  invariants,
  makeField,
  makeHole,
  principal,
  rotate,
  sampleField,
  traction,
  type Field,
  type FieldGrid,
  type Hole,
  type HoleShape,
  type Invariants,
  type Loading,
  type Principal,
  type Sym2,
  type Traction,
} from "./stress";

export interface Settings {
  load: number;
  hole: HoleShape;
  slotRatio: number;
  loading: Loading;
  probe: { x: number; y: number };
  /** Cut line angle from horizontal, degrees (kept in [0, 180)). */
  cut: number;
  /** Measuring axes turned by this many degrees, [0, 180]. */
  axes: number;
  showMohr: boolean;
  showIso: boolean;
  showRanks: boolean;
}

export const DEFAULTS: Readonly<Settings> = Object.freeze({
  load: LOAD_DEFAULT,
  hole: "circle",
  slotRatio: 6,
  loading: "pull",
  probe: Object.freeze({ x: 1, y: 0 }),
  cut: 30,
  axes: 0,
  showMohr: false,
  showIso: false,
  showRanks: false,
});

export type PresetId = "edge" | "far" | "top";

type Key = "load" | "cut" | "axes" | "probe";
interface Tween {
  key: Key;
  t: number;
  delay: number;
  dur: number;
  from: number[];
  to: number[];
  /** Optional curved path for the probe (quadratic Bézier control point). */
  ctrl?: number[];
  /** Overshoot (for the cut swing): a back-ease. */
  back?: number;
  /** Ease out only (fast start, gentle landing). */
  out?: boolean;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeBack = (t: number, s: number) => {
  const c3 = s + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
};
const mod180 = (a: number) => ((a % 180) + 180) % 180;

/** Seconds of the opening sequence. */
export const WOW = {
  loadStart: 0.4,
  loadEnd: 3.4,
  probeStart: 3.5,
  probeEnd: 5.5,
  cutStart: 5.7,
  cutEnd: 7.6,
  axesStart: 7.9,
  axesEnd: 10.1,
  end: 10.3,
};
const WOW_PROBE0 = { x: 2.3, y: 2.9 };
const WOW_CUT0 = 62;

export class Model {
  s: Settings = clone(DEFAULTS);
  time = 0;

  hole: Hole = makeHole("circle", 6);
  field: Field = makeField(this.hole, "pull");
  fieldVersion = 0;
  grid: FieldGrid;
  gridVersion = 0;
  private gridDue = -1;
  private readonly hi: [number, number];

  private tweens: Tween[] = [];
  /** Seconds since the opening sequence started, or −1 when it isn't running. */
  wowT = -1;
  /** Event clocks (model time of the last change) for the caption. */
  ev = { load: -99, cut: -99, axes: -99, probe: -99, hole: -99, loading: -99, reset: -99, preset: -99, user: -99 };
  lastPreset: PresetId | null = null;
  /** Gold flash on the cut (1 → 0) and the card's "Same stress, new axes" note. */
  flash = 0;
  axesNote = 0;
  principalNow = false;
  private wasPrincipal = false;

  // derived (updated every step)
  sigma: Sym2 = { xx: 0, yy: 0, xy: 0 };
  sigmaRot: Sym2 = { xx: 0, yy: 0, xy: 0 };
  trac!: Traction;
  prin!: Principal;
  inv!: Invariants;
  /** Strongest stress at the probe ÷ grip load. */
  here = 0;

  constructor(gridRes: [number, number]) {
    this.hi = gridRes;
    this.grid = sampleField(this.field, gridRes[0], gridRes[1]);
    this.derive();
  }

  // ───────────── setters (user = true when a person did it: stops the opening sequence) ─────────────

  private touch(user: boolean): void {
    if (user) {
      this.ev.user = this.time;
      if (this.wowT >= 0) this.stopWow();
    }
  }

  setLoad(v: number, user = true): void {
    this.touch(user);
    if (user) this.cancel("load");
    if (Math.abs(v - this.s.load) > 1e-9) this.ev.load = this.time;
    this.s.load = Math.max(0, v);
  }

  setCut(v: number, user = true): void {
    this.touch(user);
    if (user) this.cancel("cut");
    const c = mod180(v);
    if (Math.abs(c - this.s.cut) > 1e-9) this.ev.cut = this.time;
    this.s.cut = c;
  }

  setAxes(v: number, user = true): void {
    this.touch(user);
    if (user) this.cancel("axes");
    const a = Math.max(0, Math.min(180, v));
    if (Math.abs(a - this.s.axes) > 1e-9) {
      this.ev.axes = this.time;
      this.axesNote = 1;
    }
    this.s.axes = a;
  }

  setProbe(x: number, y: number, user = true): void {
    this.touch(user);
    if (user) this.cancel("probe");
    const p = clampToPlate(this.hole, x, y);
    if (Math.hypot(p.x - this.s.probe.x, p.y - this.s.probe.y) > 1e-9) this.ev.probe = this.time;
    this.s.probe = p;
  }

  setHole(shape: HoleShape, user = true): void {
    this.touch(user);
    if (shape === this.s.hole) return;
    this.s.hole = shape;
    this.ev.hole = this.time;
    this.rebuild();
  }

  setSlotRatio(r: number, user = true): void {
    this.touch(user);
    if (Math.abs(r - this.s.slotRatio) < 1e-9) return;
    this.s.slotRatio = r;
    this.ev.hole = this.time;
    if (this.s.hole !== "circle") this.rebuild(true);
  }

  setLoading(l: Loading, user = true): void {
    this.touch(user);
    if (l === this.s.loading) return;
    this.s.loading = l;
    this.ev.loading = this.time;
    this.rebuild();
  }

  setToggle(k: "showMohr" | "showIso" | "showRanks", on: boolean): void {
    this.touch(true);
    this.s[k] = on;
  }

  /** "Turn my axes": glide 45° further (wrapping 180° back to 0, which is the same set of numbers). */
  turnAxes(user = true, dur = 2.0): void {
    this.touch(user);
    let from = this.s.axes;
    const pending = this.tweens.find((t) => t.key === "axes");
    if (pending) from = pending.to[0];
    if (from >= 180 - 1e-6) {
      from = 0;
      this.s.axes = 0;
    }
    const to = Math.min(180, Math.round(from / 45) * 45 + 45);
    this.cancel("axes");
    this.tween({ key: "axes", dur, to: [to] });
  }

  preset(id: PresetId): void {
    this.touch(true);
    const h = this.hole;
    const target = id === "edge" ? this.field.hot.x >= 0 ? this.field.hot : { x: -this.field.hot.x, y: -this.field.hot.y } : id === "top" ? { x: 0, y: h.by } : { x: 2.4, y: 3.3 };
    const p = clampToPlate(h, target.x, target.y);
    this.cancel("probe");
    this.tween({ key: "probe", dur: 0.9, to: [p.x, p.y] });
    this.lastPreset = id;
    this.ev.preset = this.time;
  }

  /** Glide the probe to a point (a tap on the plate). */
  moveProbeTo(x: number, y: number, dur = 0.5): void {
    this.touch(true);
    const p = clampToPlate(this.hole, x, y);
    this.cancel("probe");
    this.tween({ key: "probe", dur, to: [p.x, p.y] });
  }

  reset(): void {
    this.touch(true);
    this.tweens = [];
    const d = DEFAULTS;
    this.s.hole = d.hole;
    this.s.slotRatio = d.slotRatio;
    this.s.loading = d.loading;
    this.s.showMohr = d.showMohr;
    this.s.showIso = d.showIso;
    this.s.showRanks = d.showRanks;
    this.rebuild();
    this.tween({ key: "load", dur: 0.7, to: [d.load] });
    this.tween({ key: "probe", dur: 0.7, to: [d.probe.x, d.probe.y] });
    this.tween({ key: "cut", dur: 0.7, to: [d.cut] });
    this.tween({ key: "axes", dur: 0.7, to: [d.axes] });
    this.lastPreset = null;
    this.ev.reset = this.time;
  }

  /** The opening sequence: bloom the load, glide the probe to the hole's side, swing the cut, turn the axes. */
  startWow(): void {
    this.tweens = [];
    this.s.load = 0;
    this.s.probe = { ...WOW_PROBE0 };
    this.s.cut = WOW_CUT0;
    this.s.axes = 0;
    this.wowT = 0;
    this.tween({ key: "load", delay: WOW.loadStart, dur: WOW.loadEnd - WOW.loadStart, to: [LOAD_DEFAULT], out: true });
    this.tween({ key: "probe", delay: WOW.probeStart, dur: WOW.probeEnd - WOW.probeStart, to: [1, 0], ctrl: [2.6, 0.7] });
    this.tween({ key: "cut", delay: WOW.cutStart, dur: WOW.cutEnd - WOW.cutStart, to: [0], back: 1.6 });
    this.tween({ key: "axes", delay: WOW.axesStart, dur: WOW.axesEnd - WOW.axesStart, to: [45] });
  }

  stopWow(): void {
    this.wowT = -1;
    this.tweens = [];
  }

  get wowActive(): boolean {
    return this.wowT >= 0;
  }

  // ───────────── internals ─────────────

  private cancel(key: Key): void {
    this.tweens = this.tweens.filter((t) => t.key !== key);
  }

  private current(key: Key): number[] {
    if (key === "probe") return [this.s.probe.x, this.s.probe.y];
    return [this.s[key]];
  }

  private tween(t: Partial<Tween> & { key: Key; dur: number; to: number[] }): void {
    this.tweens.push({ t: 0, delay: 0, from: [], ...t });
  }

  private rebuild(lowFirst = false): void {
    this.hole = makeHole(this.s.hole, this.s.slotRatio);
    this.field = makeField(this.hole, this.s.loading);
    this.fieldVersion++;
    if (lowFirst) {
      const k = 3;
      this.grid = sampleField(this.field, Math.round(this.hi[0] / k), Math.round(this.hi[1] / k));
      this.gridDue = this.time + 0.35;
    } else {
      this.grid = sampleField(this.field, this.hi[0], this.hi[1]);
      this.gridDue = -1;
    }
    this.gridVersion++;
    // keep the probe out of the (possibly larger) hole
    const p = clampToPlate(this.hole, this.s.probe.x, this.s.probe.y);
    this.s.probe = p;
  }

  step(dt: number): void {
    this.time += dt;
    if (this.wowT >= 0) {
      this.wowT += dt;
      if (this.wowT > WOW.end) this.wowT = -1;
    }
    if (this.gridDue >= 0 && this.time >= this.gridDue) {
      this.grid = sampleField(this.field, this.hi[0], this.hi[1]);
      this.gridDue = -1;
      this.gridVersion++;
    }
    // tweens
    for (const tw of this.tweens) {
      if (tw.delay > 0) {
        tw.delay -= dt;
        if (tw.delay > 0) continue;
        tw.t = -tw.delay;
        tw.delay = 0;
        tw.from = [];
      } else tw.t += dt;
      if (!tw.from.length) {
        tw.from = this.current(tw.key);
        if (tw.key === "cut") {
          // swing the short way round (angles live mod 180)
          let d = tw.to[0] - tw.from[0];
          d -= Math.round(d / 180) * 180;
          tw.to = [tw.from[0] + d];
        }
      }
      const u = Math.min(1, tw.t / tw.dur);
      const e = tw.back ? easeBack(u, tw.back) : tw.out ? 1 - Math.pow(1 - u, 3) : ease(u);
      const v = tw.from.map((f, i) => {
        if (tw.ctrl) {
          const a = 1 - e;
          return a * a * f + 2 * a * e * tw.ctrl[i] + e * e * tw.to[i];
        }
        return f + (tw.to[i] - f) * e;
      });
      if (tw.key === "probe") this.setProbe(v[0], v[1], false);
      else if (tw.key === "load") this.setLoad(v[0], false);
      else if (tw.key === "cut") this.setCut(v[0], false);
      else this.setAxes(v[0], false);
    }
    this.tweens = this.tweens.filter((t) => t.delay > 0 || t.t < t.dur);

    this.flash = Math.max(0, this.flash - dt / 1.4);
    this.axesNote = Math.max(0, this.axesNote - dt / 2.2);
    this.derive();
    // principal direction reached while the cut is moving → flash gold
    if (this.principalNow && !this.wasPrincipal && this.time - this.ev.cut < 0.6) this.flash = 1;
    this.wasPrincipal = this.principalNow;
  }

  private derive(): void {
    const S = this.s.load;
    this.sigma = this.field.at(this.s.probe.x, this.s.probe.y, S);
    this.sigmaRot = rotate(this.sigma, this.s.axes);
    this.trac = traction(this.sigma, this.s.cut);
    this.prin = principal(this.sigma);
    this.inv = invariants(this.sigma);
    const big = Math.max(Math.abs(this.prin.s1), Math.abs(this.prin.s2));
    this.here = S > 1e-9 ? big / S : 0;
    const tmag = Math.hypot(this.trac.tx, this.trac.ty);
    this.principalNow = tmag > 0.08 && Math.abs(this.trac.shear) < Math.max(0.03, 0.025 * tmag);
  }

  /** Grip load S, the highest fringe order on the plate, concentration factor. */
  get K(): number {
    return this.field.K;
  }
  get fringeMax(): number {
    return N_PER_MPA * this.s.load * Math.max(this.field.rimDiff, this.grid.maxDiff);
  }
  /** Fringe orders per unit of the grid's (σ1 − σ2) value. */
  get fringeScale(): number {
    return N_PER_MPA * this.s.load;
  }
  /** Angle of the principal cut nearest the current one (the cut with no slide), degrees in [0, 180). */
  get principalCut(): number {
    const a = mod180(this.prin.angleDeg - 90);
    const b = mod180(a + 90);
    const d = (x: number) => Math.abs(((x - this.s.cut + 90) % 180 + 180) % 180 - 90);
    return d(a) <= d(b) ? a : b;
  }

  finite(): boolean {
    const v = [this.sigma.xx, this.sigma.yy, this.sigma.xy, this.sigmaRot.xx, this.sigmaRot.yy, this.sigmaRot.xy, this.trac.normal, this.trac.shear, this.here, this.K, this.s.load, this.s.cut, this.s.axes, this.s.probe.x, this.s.probe.y];
    return v.every(Number.isFinite);
  }
}

function clone(s: Readonly<Settings>): Settings {
  return { ...s, probe: { ...s.probe } };
}
