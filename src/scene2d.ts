/**
 * Canvas2D fallback: the same rig seen straight on, the same physics, the same fringe colour table and
 * the same engraved card and dial (used when WebGL is missing or lost, or with ?renderer=2d).
 */
import type { Model } from "./model";
import { LUT_MAX_N, LUT_SIZE, PLATE, fringeLut } from "./stress";
import { AMBER, CYAN, GOLD, type Anchors, type Layout, type View } from "./view";
import { CARD, DIAL, dialAngle, dialMax, drawCard, drawDial } from "./textures";

const U = 0.2;
const PW = PLATE.halfW * U;
const PH = PLATE.halfH * U;
const PCY = 1.62;

interface Arr {
  /** World box to fit: x0, x1, y0, y1 (y up). */
  box: [number, number, number, number];
  card: [number, number, number]; // centre x, bottom y, width
  dial: [number, number, number]; // centre x, centre y, radius
  shelf: [number, number];
}
const DESK: Arr = { box: [-1.45, 3.75, -0.05, 3.6], card: [2.2, 0.2, 1.0], dial: [3.25, 0.7, 0.36], shelf: [0.2, -0.05] };
const PHONE: Arr = { box: [-1.45, 1.45, -1.55, 3.6], card: [-0.62, -1.5, 0.95], dial: [0.78, -0.88, 0.4], shelf: [0, -1.6] };

export class Scene2D implements View {
  readonly kind = "2d" as const;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private arr: Arr = DESK;
  private sc = 100;
  private ox = 0;
  private oy = 0;
  private fr: HTMLCanvasElement;
  private frx: CanvasRenderingContext2D;
  private frKey = "";
  private card: HTMLCanvasElement;
  private cardKey = "";
  private dial: HTMLCanvasElement;
  private dialKey = "";
  private needle = 0;
  private time = 0;
  private anch: Anchors = {};
  private probeP = { x: 0, y: 0 };

  constructor(container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-label", "A clear plate with a hole held in brass grips, glowing with rainbow stress bands (simple 2D view). Drag the glass probe on the plate.");
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.fr = document.createElement("canvas");
    this.frx = this.fr.getContext("2d")!;
    this.card = document.createElement("canvas");
    this.card.width = CARD.W;
    this.card.height = CARD.H;
    this.dial = document.createElement("canvas");
    this.dial.width = this.dial.height = DIAL.S;
  }

  resize(w: number, h: number, layout: Layout): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.arr = layout.phone ? PHONE : DESK;
    // phones: fit the plate itself (plus a little of the grips) so its fringes fill the free area
    const [x0, x1, y0, y1] = layout.compact ? [-PW * 1.08, PW * 1.08, PCY - PH * 1.06, PCY + PH * 1.16] : this.arr.box;
    this.sc = Math.min(layout.w / (x1 - x0), layout.h / (y1 - y0));
    this.ox = layout.x + layout.w / 2 - ((x0 + x1) / 2) * this.sc;
    this.oy = layout.y + layout.h / 2 + ((y0 + y1) / 2) * this.sc;
  }

  private X(x: number): number {
    return this.ox + x * this.sc;
  }
  private Y(y: number): number {
    return this.oy - y * this.sc;
  }
  /** plate coords (a units) → screen */
  private P(x: number, y: number): [number, number] {
    return [this.X(x * U), this.Y(PCY + y * U)];
  }

  anchors(): Anchors {
    return this.anch;
  }
  platePoint(cx: number, cy: number): { x: number; y: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const x = (cx - r.left - this.ox) / this.sc, y = (this.oy - (cy - r.top)) / this.sc;
    return { x: x / U, y: (y - PCY) / U };
  }
  probeScreen(): { x: number; y: number; r: number } {
    return { x: this.probeP.x, y: this.probeP.y, r: Math.max(16, 0.07 * this.sc) };
  }
  resetCamera(): void {}
  poke(): void {}
  dispose(): void {
    this.canvas.remove();
  }

  private brassGrad(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    const g = this.ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "#f3d48c");
    g.addColorStop(0.45, "#b88a3e");
    g.addColorStop(1, "#6e4e1e");
    return g;
  }
  private rrect(x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient, stroke = "rgba(0,0,0,0.35)"): void {
    const c = this.ctx;
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = stroke;
    c.lineWidth = 1;
    c.stroke();
  }

  private updateFringe(model: Model): void {
    const g = model.grid;
    const key = `${model.gridVersion}|${model.fringeScale.toFixed(4)}|${model.s.showIso}`;
    if (key === this.frKey) return;
    this.frKey = key;
    if (this.fr.width !== g.w || this.fr.height !== g.h) {
      this.fr.width = g.w;
      this.fr.height = g.h;
    }
    const img = this.frx.createImageData(g.w, g.h);
    const lut = fringeLut();
    const k = model.fringeScale;
    const d = g.data, o = img.data;
    for (let i = 0, n = g.w * g.h; i < n; i++) {
      const N = k * d[i * 4];
      const li = Math.min(LUT_SIZE - 1, Math.round((N / LUT_MAX_N) * (LUT_SIZE - 1))) * 4;
      o[i * 4] = Math.min(230, lut[li]);
      o[i * 4 + 1] = Math.min(230, lut[li + 1]);
      o[i * 4 + 2] = Math.min(230, lut[li + 2]);
      o[i * 4 + 3] = d[i * 4 + 3] > 0.5 ? 0 : 255;
    }
    this.frx.putImageData(img, 0, 0);
    if (model.s.showIso) {
      const x = this.frx;
      const cw = g.w / 12;
      for (let j = 0; j < 16; j++)
        for (let i = 0; i < 12; i++) {
          const cx = (i + 0.5) * cw, cy = (j + 0.5) * cw;
          const t = (Math.floor(cy) * g.w + Math.floor(cx)) * 4;
          if (d[t + 3] > 0.5) continue;
          const th = 0.5 * Math.atan2(d[t + 2], d[t + 1]);
          const c = Math.cos(th), s = -Math.sin(th);
          x.lineCap = "round";
          for (const [len, lw, col] of [
            [0.36, 3.2, "rgba(0,0,0,0.5)"],
            [0.36, 1.6, "#ffffff"],
          ] as const) {
            x.strokeStyle = col;
            x.lineWidth = lw;
            x.beginPath();
            x.moveTo(cx - c * cw * len, cy - s * cw * len);
            x.lineTo(cx + c * cw * len, cy + s * cw * len);
            x.moveTo(cx + s * cw * len * 0.6, cy - c * cw * len * 0.6);
            x.lineTo(cx - s * cw * len * 0.6, cy + c * cw * len * 0.6);
            x.stroke();
          }
        }
    }
  }

  private arrow(x0: number, y0: number, x1: number, y1: number, col: string): void {
    const c = this.ctx;
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (L < 2) return;
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    const hl = Math.min(16, L * 0.45), hw = 7;
    const bx = x1 - ux * hl, by = y1 - uy * hl;
    for (const [lw, st] of [
      [7, "#050505"],
      [3.5, col],
    ] as const) {
      c.strokeStyle = st;
      c.lineWidth = lw;
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(bx, by);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(bx - uy * hw, by + ux * hw);
    c.lineTo(bx + uy * hw, by - ux * hw);
    c.closePath();
    c.fillStyle = col;
    c.strokeStyle = "#050505";
    c.lineWidth = 2;
    c.stroke();
    c.fill();
  }

  render(dt: number, model: Model): void {
    this.time += dt;
    const c = this.ctx, s = model.s, sc = this.sc;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bg = c.createLinearGradient(0, 0, 0, this.h);
    bg.addColorStop(0, "#0a1020");
    bg.addColorStop(1, "#050608");
    c.fillStyle = bg;
    c.fillRect(0, 0, this.w, this.h);
    const a = this.arr;
    // desk
    const deskY = this.Y(a === PHONE ? -1.5 : 0);
    const dg = c.createLinearGradient(0, deskY, 0, this.h);
    dg.addColorStop(0, "#3a2216");
    dg.addColorStop(1, "#140b06");
    c.fillStyle = dg;
    c.fillRect(0, deskY, this.w, this.h - deskY);

    // polariser
    c.beginPath();
    c.arc(this.X(0), this.Y(PCY), 1.09 * sc, 0, Math.PI * 2);
    c.fillStyle = "#04060a";
    c.fill();
    c.lineWidth = 0.06 * sc;
    c.strokeStyle = this.brassGrad(this.X(-1.1), this.Y(2.7), this.X(1.1), this.Y(0.5));
    c.stroke();
    // columns, crossbar, screw, handle
    for (const x of [-1.16, 1.16]) this.rrect(this.X(x - 0.055), this.Y(3.05), 0.11 * sc, 2.7 * sc, 3, "#80858c");
    this.rrect(this.X(-1.31), this.Y(3.09), 2.62 * sc, 0.18 * sc, 6, this.brassGrad(0, this.Y(3.09), 0, this.Y(2.91)));
    const lift = s.load * 0.009;
    const topGripY = PCY + PH - 0.02 + lift;
    this.rrect(this.X(-0.05), this.Y(3.42), 0.1 * sc, (3.42 - topGripY - 0.27) * sc, 2, "#a8843f");
    const turn = s.load * 1.6;
    const hw = Math.abs(Math.cos(turn)) * 0.5 + 0.06;
    this.rrect(this.X(-hw), this.Y(3.47), hw * 2 * sc, 0.06 * sc, 4, this.brassGrad(0, this.Y(3.47), 0, this.Y(3.41)));
    this.rrect(this.X(-0.08), this.Y(3.5), 0.16 * sc, 0.12 * sc, 4, "#b88a3e");
    // plinth + pedestal
    this.rrect(this.X(-1.35), this.Y(0.34), 2.7 * sc, 0.28 * sc, 6, "#4a2a1a");
    this.rrect(this.X(-0.62), this.Y(0.5), 1.25 * sc, 0.16 * sc, 4, "#9a7536");

    // plate + fringes
    this.updateFringe(model);
    const ps = 1 + s.load * 0.002;
    const pcy = PCY + PH * s.load * 0.002;
    const [plx, ply] = [this.X(-PW), this.Y(pcy + PH * ps)];
    c.imageSmoothingEnabled = true;
    c.drawImage(this.fr, plx, ply, 2 * PW * sc, 2 * PH * ps * sc);
    c.strokeStyle = "rgba(190,230,255,0.55)";
    c.lineWidth = 1.5;
    c.strokeRect(plx, ply, 2 * PW * sc, 2 * PH * ps * sc);
    c.beginPath();
    c.ellipse(this.X(0), this.Y(pcy), model.hole.ax * U * sc, model.hole.by * U * sc * ps, 0, 0, Math.PI * 2);
    c.strokeStyle = "rgba(200,235,255,0.6)";
    c.stroke();
    // grips
    for (const gy of [0.8, topGripY + 0.15]) {
      this.rrect(this.X(-0.89), this.Y(gy), 1.78 * sc, 0.3 * sc, 5, this.brassGrad(0, this.Y(gy), 0, this.Y(gy - 0.3)));
      for (const x of [-0.62, 0, 0.62]) {
        c.beginPath();
        c.arc(this.X(x), this.Y(gy - 0.15), 0.052 * sc, 0, Math.PI * 2);
        c.fillStyle = "#c9a05a";
        c.fill();
        c.strokeStyle = "#5a3f17";
        c.stroke();
      }
    }

    // gnomon
    const al = (s.axes * Math.PI) / 180;
    const [gx, gy] = this.P(-2.55, -2.95 * ps);
    const gl = 0.3 * sc;
    const primed = s.axes > 0.05 && s.axes < 179.95;
    for (const [ang, name] of [
      [al, primed ? "x′" : "x"],
      [al + Math.PI / 2, primed ? "y′" : "y"],
    ] as const) {
      this.arrow(gx, gy, gx + Math.cos(ang) * gl, gy - Math.sin(ang) * gl, "#d9b062");
      c.font = `italic 700 ${Math.max(12, 0.09 * sc)}px Georgia, serif`;
      c.fillStyle = "#ffe9b8";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(name, gx + Math.cos(ang) * gl * 1.3, gy - Math.sin(ang) * gl * 1.3);
    }

    // probe, cut, arrows
    const [px, py] = this.P(s.probe.x, s.probe.y * ps);
    this.probeP = { x: px, y: py };
    const tr = model.trac;
    const k = 0.046 * sc;
    const nL = Math.min(0.95 * sc, Math.abs(tr.normal) * k), sL = Math.min(0.95 * sc, Math.abs(tr.shear) * k);
    const [nx, ny] = tr.n, [sx, sy] = tr.s;
    const gold = Math.max(model.flash, model.principalNow ? 0.55 : 0);
    const phi = (s.cut * Math.PI) / 180;
    const cl = 0.23 * sc;
    c.strokeStyle = "#050505";
    c.lineWidth = 6;
    c.beginPath();
    c.moveTo(px - Math.cos(phi) * cl, py + Math.sin(phi) * cl);
    c.lineTo(px + Math.cos(phi) * cl, py - Math.sin(phi) * cl);
    c.stroke();
    c.strokeStyle = gold > 0.3 ? GOLD : CYAN;
    c.lineWidth = 3;
    c.stroke();
    if (tr.normal >= 0) this.arrow(px, py, px + nx * nL, py - ny * nL, AMBER);
    else this.arrow(px + nx * nL, py - ny * nL, px, py, AMBER);
    const sg = tr.shear >= 0 ? 1 : -1;
    this.arrow(px, py, px + sx * sg * sL, py - sy * sg * sL, CYAN);
    if (s.showIso) {
      const t = (model.prin.angleDeg * Math.PI) / 180;
      c.strokeStyle = "#fff";
      c.lineWidth = 1.5;
      for (const q of [t, t + Math.PI / 2]) {
        c.beginPath();
        c.moveTo(px - Math.cos(q) * 0.2 * sc, py + Math.sin(q) * 0.2 * sc);
        c.lineTo(px + Math.cos(q) * 0.2 * sc, py - Math.sin(q) * 0.2 * sc);
        c.stroke();
      }
    }
    const ph = 0.05 * sc;
    const glow = c.createRadialGradient(px, py, 0, px, py, ph * 3);
    glow.addColorStop(0, "rgba(170,240,255,0.55)");
    glow.addColorStop(1, "rgba(170,240,255,0)");
    c.fillStyle = glow;
    c.fillRect(px - ph * 3, py - ph * 3, ph * 6, ph * 6);
    c.fillStyle = "rgba(220,250,255,0.22)";
    c.strokeStyle = "rgba(200,245,255,0.95)";
    c.lineWidth = 1.5;
    c.beginPath();
    c.roundRect(px - ph, py - ph, ph * 2, ph * 2, 3);
    c.fill();
    c.stroke();

    // card
    const m = model.sigmaRot;
    const note = Math.round(model.axesNote * 20);
    const key = `${m.xx.toFixed(2)}|${m.yy.toFixed(2)}|${m.xy.toFixed(2)}|${Math.round(s.axes)}|${note}`;
    if (key !== this.cardKey) {
      this.cardKey = key;
      drawCard(this.card.getContext("2d")!, { m: [[m.xx, m.xy, 0], [m.xy, m.yy, 0], [0, 0, 0]], primed, axesDeg: s.axes, note: model.axesNote });
    }
    const [ccx, cby, cw] = a.card;
    const ch = cw * (CARD.H / CARD.W);
    this.rrect(this.X(ccx - 0.45), this.Y(cby), 0.9 * sc, 0.18 * sc, 4, this.brassGrad(0, this.Y(cby), 0, this.Y(cby - 0.2)));
    c.drawImage(this.card, this.X(ccx - cw / 2), this.Y(cby + 0.05 + ch), cw * sc, ch * sc);
    // dial
    const max = dialMax(model.K);
    const dk = `${max}|${model.K.toFixed(2)}`;
    if (dk !== this.dialKey) {
      this.dialKey = dk;
      drawDial(this.dial.getContext("2d")!, max, model.K);
    }
    const [dx, dy, dr] = a.dial;
    c.beginPath();
    c.arc(this.X(dx), this.Y(dy), (dr + 0.04) * sc, 0, Math.PI * 2);
    c.fillStyle = this.brassGrad(this.X(dx - dr), this.Y(dy + dr), this.X(dx + dr), this.Y(dy - dr));
    c.fill();
    c.drawImage(this.dial, this.X(dx - dr), this.Y(dy + dr), 2 * dr * sc, 2 * dr * sc);
    this.needle += (dialAngle(model.here, max) - this.needle) * Math.min(1, dt * 7);
    c.strokeStyle = "#b3201a";
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(this.X(dx), this.Y(dy));
    c.lineTo(this.X(dx) + Math.sin(this.needle) * dr * 0.85 * sc, this.Y(dy) - Math.cos(this.needle) * dr * 0.85 * sc);
    c.stroke();

    // ranks shelf
    const A: Anchors = {};
    if (s.showRanks) {
      const [shx, shy] = a.shelf;
      this.rrect(this.X(shx - 1.25), this.Y(shy + 0.05), 2.5 * sc, 0.05 * sc, 3, "#5a3622");
      const base = shy + 0.18;
      const r0 = [shx - 0.9, base], r1 = [shx - 0.42, base], r2 = [shx + 0.18, base + 0.06], r3 = [shx + 0.85, base];
      c.fillStyle = "rgba(190,233,255,0.85)";
      c.beginPath();
      c.arc(this.X(r0[0]), this.Y(r0[1]), 0.07 * sc, 0, Math.PI * 2);
      c.fill();
      this.arrow(this.X(r1[0] - 0.1), this.Y(r1[1] - 0.08), this.X(r1[0] + 0.12), this.Y(r1[1] + 0.12), "#d9b062");
      this.rrect(this.X(r2[0] - 0.12), this.Y(r2[1] + 0.14), 0.24 * sc, 0.28 * sc, 3, "#ece2cb");
      const cols = ["#ff5a5a", "#5aff8a", "#5aa8ff"];
      for (let kk = 2; kk >= 0; kk--)
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++) {
            c.fillStyle = cols[kk];
            c.beginPath();
            c.arc(this.X(r3[0] + (i - 1) * 0.075 + kk * 0.03), this.Y(r3[1] + (j - 1) * 0.075 + kk * 0.03), 0.026 * sc, 0, Math.PI * 2);
            c.fill();
          }
      [r0, r1, r2, r3].forEach((r, i) => (A[`rank${i}`] = { x: this.X(r[0]), y: this.Y(r[1] - 0.12), on: true }));
    }

    const put = (id: string, x: number, y: number) => (A[id] = { x, y, on: true });
    const P = (x: number, y: number) => this.P(x, y * ps);
    put("plate", ...P(-2.7, 2.6));
    put("pc0", ...P(-PLATE.halfW, -PLATE.halfH));
    put("pc1", ...P(PLATE.halfW, -PLATE.halfH));
    put("pc2", ...P(PLATE.halfW, PLATE.halfH));
    put("pc3", ...P(-PLATE.halfW, PLATE.halfH));
    put("holeA", ...P(-(model.hole.ax + 1.4), model.hole.by + 1.4));
    put("holeB", ...P(model.hole.ax + 1.4, -(model.hole.by + 1.4)));
    const side = s.probe.x >= 0 ? -1 : 1;
    put("bands", ...P(side * (model.hole.ax + 1.25), 1.15));
    put("probe", px, py);
    const csg = tr.shear >= 0 ? -1 : 1;
    put("cut", px + Math.cos(phi) * cl * csg, py - Math.sin(phi) * cl * csg);
    if (tr.normal >= 0) put("pull", px + nx * nL, py - ny * nL);
    else put("pull", px + nx * nL, py - ny * nL);
    put("slide", px + sx * sg * sL, py - sy * sg * sL);
    put("axes", gx, gy);
    put("card", this.X(ccx), this.Y(cby + 0.05 + ch));
    put("dial", this.X(dx), a === PHONE ? this.Y(dy + dr + 0.04) : this.Y(dy - dr - 0.04));
    if (s.showIso) {
      const t = (model.prin.angleDeg * Math.PI) / 180;
      put("principal", px + Math.cos(t) * 0.2 * sc, py - Math.sin(t) * 0.2 * sc);
    }
    this.anch = A;
  }
}
