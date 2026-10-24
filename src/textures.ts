/** Procedural canvases shared by both renderers: walnut, brass wear, the engraved tensor card and the dial face. */

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Small deterministic PRNG so textures look the same every load. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Walnut: dark warm base with long wavy grain lines and pores. */
export function walnut(w = 1024, h = 512): HTMLCanvasElement {
  const [c, x] = canvas(w, h);
  const r = rng(7);
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#4a2a1a");
  g.addColorStop(0.5, "#3b2115");
  g.addColorStop(1, "#45281a");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < 150; i++) {
    const y0 = r() * h;
    const amp = 2 + r() * 10;
    const f = 0.002 + r() * 0.006;
    const ph = r() * 10;
    const dark = r() < 0.6;
    x.strokeStyle = dark ? `rgba(20,9,4,${0.12 + r() * 0.25})` : `rgba(140,82,46,${0.06 + r() * 0.12})`;
    x.lineWidth = 0.6 + r() * 2.6;
    x.beginPath();
    for (let px = 0; px <= w; px += 8) {
      const y = y0 + Math.sin(px * f + ph) * amp + Math.sin(px * f * 3.1 + ph * 2) * amp * 0.25;
      if (px === 0) x.moveTo(px, y);
      else x.lineTo(px, y);
    }
    x.stroke();
  }
  for (let i = 0; i < 2600; i++) {
    x.fillStyle = `rgba(15,6,2,${0.15 + r() * 0.25})`;
    x.fillRect(r() * w, r() * h, 1 + r() * 3, 0.8);
  }
  return c;
}

/** Brass wear: mostly mid-grey (roughness ~0.3) with smudges and fine brushing. */
export function wear(w = 256, h = 256, seed = 3): HTMLCanvasElement {
  const [c, x] = canvas(w, h);
  const r = rng(seed);
  x.fillStyle = "rgb(84,84,84)";
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < 400; i++) {
    x.strokeStyle = `rgba(${r() < 0.5 ? 255 : 0},${r() < 0.5 ? 255 : 0},${r() < 0.5 ? 255 : 0},0.04)`;
    const y = r() * h;
    x.lineWidth = 0.5 + r();
    x.beginPath();
    x.moveTo(0, y);
    x.lineTo(w, y + (r() - 0.5) * 6);
    x.stroke();
  }
  for (let i = 0; i < 24; i++) {
    const gx = r() * w, gy = r() * h, rad = 8 + r() * 40;
    const g = x.createRadialGradient(gx, gy, 0, gx, gy, rad);
    g.addColorStop(0, `rgba(170,170,170,${0.15 + r() * 0.2})`);
    g.addColorStop(1, "rgba(170,170,170,0)");
    x.fillStyle = g;
    x.fillRect(gx - rad, gy - rad, rad * 2, rad * 2);
  }
  return c;
}

/** Stripes (knurls, screw threads): white/black bands across u. */
export function stripes(n: number, w = 256, h = 16, soft = 0.4): HTMLCanvasElement {
  const [c, x] = canvas(w, h);
  for (let i = 0; i < w; i++) {
    const t = (i / w) * n;
    const v = 0.5 + 0.5 * Math.cos(t * 2 * Math.PI);
    const k = Math.pow(v, soft * 2);
    const g = Math.round(40 + 200 * k);
    x.fillStyle = `rgb(${g},${g},${g})`;
    x.fillRect(i, 0, 1, h);
  }
  return c;
}

export function letter(text: string, color = "#2b1d0e", size = 128): HTMLCanvasElement {
  const [c, x] = canvas(size, size);
  x.font = `italic 700 ${Math.round(size * 0.78)}px Georgia, "Times New Roman", serif`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.lineWidth = size * 0.12;
  x.strokeStyle = "rgba(10,8,4,0.9)";
  x.strokeText(text, size / 2, size / 2 + size * 0.03);
  x.fillStyle = color;
  x.fillText(text, size / 2, size / 2 + size * 0.03);
  return c;
}

// ───────────────────────── the engraved card ─────────────────────────

export const CARD = { W: 600, H: 720 };

export interface CardData {
  /** 3×3 tensor in the current axes, MPa. */
  m: number[][];
  primed: boolean;
  axesDeg: number;
  /** 0..1 visibility of the "Same stress, new axes" note. */
  note: number;
}

export const fmt1 = (v: number) => {
  const r = Math.round(v * 10) / 10;
  if (Math.abs(r) < 0.05) return "0.0";
  return (r < 0 ? "−" : "") + Math.abs(r).toFixed(1);
};

let cardBase: HTMLCanvasElement | null = null;
function cardBackground(): HTMLCanvasElement {
  if (cardBase) return cardBase;
  const { W, H } = CARD;
  const [c, x] = canvas(W, H);
  const r = rng(11);
  const rr = 46;
  const path = () => {
    x.beginPath();
    x.roundRect(6, 6, W - 12, H - 12, rr);
  };
  // enamel body
  path();
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#f3ebd8");
  g.addColorStop(1, "#e6dbc2");
  x.fillStyle = g;
  x.fill();
  // speckle
  x.save();
  path();
  x.clip();
  for (let i = 0; i < 5000; i++) {
    x.fillStyle = r() < 0.5 ? `rgba(120,96,60,${0.04 + r() * 0.06})` : `rgba(255,255,255,${0.05 + r() * 0.08})`;
    x.fillRect(r() * W, r() * H, 1.4, 1.4);
  }
  x.restore();
  // bevelled edge
  x.lineWidth = 10;
  x.strokeStyle = "rgba(140,110,70,0.45)";
  path();
  x.stroke();
  x.lineWidth = 2;
  x.strokeStyle = "rgba(255,255,255,0.7)";
  x.beginPath();
  x.roundRect(14, 14, W - 28, H - 28, rr - 8);
  x.stroke();
  // engraved inner border
  x.lineWidth = 2.5;
  x.strokeStyle = "rgba(70,52,30,0.55)";
  x.beginPath();
  x.roundRect(34, 34, W - 68, H - 68, 22);
  x.stroke();
  // screws
  for (const [sx, sy] of [
    [40, 40],
    [W - 40, 40],
    [40, H - 40],
    [W - 40, H - 40],
  ]) {
    const sg = x.createRadialGradient(sx - 3, sy - 3, 1, sx, sy, 11);
    sg.addColorStop(0, "#f6dc9a");
    sg.addColorStop(0.7, "#a87b32");
    sg.addColorStop(1, "#5a3f17");
    x.fillStyle = sg;
    x.beginPath();
    x.arc(sx, sy, 10, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = "rgba(50,30,10,0.8)";
    x.lineWidth = 2.5;
    x.beginPath();
    x.moveTo(sx - 6, sy + 3);
    x.lineTo(sx + 6, sy - 3);
    x.stroke();
  }
  cardBase = c;
  return c;
}

function engrave(x: CanvasRenderingContext2D, text: string, px: number, py: number, ink = "#2a1f14"): void {
  x.fillStyle = "rgba(255,255,255,0.65)";
  x.fillText(text, px, py + 2);
  x.fillStyle = ink;
  x.fillText(text, px, py);
}

/** Draw the matte enamel tensor card into ctx at (0,0)..(CARD.W, CARD.H). */
export function drawCard(x: CanvasRenderingContext2D, d: CardData): void {
  const { W, H } = CARD;
  x.clearRect(0, 0, W, H);
  x.drawImage(cardBackground(), 0, 0);
  x.textAlign = "center";
  x.textBaseline = "alphabetic";
  x.font = "700 30px Georgia, 'Times New Roman', serif";
  engrave(x, "STRESS AT THE PROBE", W / 2, 96);
  x.font = "500 25px Georgia, 'Times New Roman', serif";
  engrave(x, d.primed ? `in MPa · axes turned ${Math.round(d.axesDeg)}°` : "in MPa · axes level", W / 2, 134, "#5a4630");

  const names = d.primed ? ["x′", "y′", "z"] : ["x", "y", "z"];
  const gx = 112, gy = 190, cw = 152, ch = 118;
  // column / row heads
  x.font = "italic 600 34px Georgia, 'Times New Roman', serif";
  for (let i = 0; i < 3; i++) {
    engrave(x, names[i], gx + cw * i + cw / 2, gy - 14, "#6b5132");
    x.textAlign = "right";
    engrave(x, names[i], gx - 18, gy + ch * i + ch / 2 + 12, "#6b5132");
    x.textAlign = "center";
  }
  // engraved matrix brackets
  x.strokeStyle = "rgba(42,31,20,0.85)";
  x.lineWidth = 4;
  const bl = gx - 4, br = gx + cw * 3 + 4, bt = gy + 4, bb = gy + ch * 3 - 4;
  x.beginPath();
  x.moveTo(bl + 16, bt);
  x.lineTo(bl, bt);
  x.lineTo(bl, bb);
  x.lineTo(bl + 16, bb);
  x.moveTo(br - 16, bt);
  x.lineTo(br, bt);
  x.lineTo(br, bb);
  x.lineTo(br - 16, bb);
  x.stroke();
  // faint cell rules
  x.strokeStyle = "rgba(90,70,40,0.18)";
  x.lineWidth = 1.5;
  for (let i = 1; i < 3; i++) {
    x.beginPath();
    x.moveTo(gx + 10, gy + ch * i);
    x.lineTo(gx + cw * 3 - 10, gy + ch * i);
    x.moveTo(gx + cw * i, gy + 10);
    x.lineTo(gx + cw * i, gy + ch * 3 - 10);
    x.stroke();
  }
  // the nine numbers
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const z = i === 2 || j === 2;
      const v = d.m[i][j];
      const s = z ? "0" : fmt1(v);
      x.font = z ? "500 44px ui-monospace, Menlo, Consolas, monospace" : `700 ${s.length > 5 ? 42 : 50}px ui-monospace, Menlo, Consolas, monospace`;
      engrave(x, s, gx + cw * j + cw / 2, gy + ch * i + ch / 2 + 17, z ? "#9b8a70" : v < -0.05 ? "#1f3a73" : "#2a1f14");
    }
  }
  // footer
  x.font = "500 22px Georgia, 'Times New Roman', serif";
  engrave(x, "thin plate: the z row and column stay zero", W / 2, gy + ch * 3 + 44, "#6b5132");
  if (d.note > 0.01) {
    x.save();
    x.globalAlpha = Math.min(1, d.note * 1.6);
    const nw = 400, nh = 58, nx = (W - nw) / 2, ny = H - 128;
    const g = x.createLinearGradient(0, ny, 0, ny + nh);
    g.addColorStop(0, "#f2cf7a");
    g.addColorStop(1, "#b8862f");
    x.fillStyle = g;
    x.beginPath();
    x.roundRect(nx, ny, nw, nh, 14);
    x.fill();
    x.strokeStyle = "rgba(70,45,10,0.7)";
    x.lineWidth = 2;
    x.stroke();
    x.font = "700 30px Georgia, 'Times New Roman', serif";
    x.fillStyle = "#2a1a06";
    x.fillText("Same stress, new axes", W / 2, ny + 40);
    x.restore();
  } else {
    x.font = "600 24px Georgia, 'Times New Roman', serif";
    engrave(x, "feed it a cut, it returns the force", W / 2, H - 92, "#5a4630");
  }
}

// ───────────────────────── the dial ─────────────────────────

export const DIAL = { S: 512 };
export const DIAL_SWEEP = 270;

export function dialMax(K: number): number {
  if (K <= 4.6) return 5;
  if (K <= 9.2) return 10;
  if (K <= 14) return 15;
  if (K <= 19) return 20;
  return 25;
}

/** Angle (radians, clockwise from straight up) of a reading on the dial. */
export function dialAngle(v: number, max: number): number {
  const u = Math.max(0, Math.min(1.04, v / max));
  return ((-DIAL_SWEEP / 2 + DIAL_SWEEP * u) * Math.PI) / 180;
}

export function drawDial(x: CanvasRenderingContext2D, max: number, K: number): void {
  const S = DIAL.S, c = S / 2, R = S / 2 - 10;
  x.clearRect(0, 0, S, S);
  const g = x.createRadialGradient(c, c * 0.8, 10, c, c, R);
  g.addColorStop(0, "#f7f0de");
  g.addColorStop(1, "#e2d6b8");
  x.fillStyle = g;
  x.beginPath();
  x.arc(c, c, R, 0, Math.PI * 2);
  x.fill();
  x.strokeStyle = "rgba(80,60,30,0.5)";
  x.lineWidth = 3;
  x.beginPath();
  x.arc(c, c, R - 14, 0, Math.PI * 2);
  x.stroke();
  const pt = (a: number, r: number): [number, number] => [c + Math.sin(a) * r, c - Math.cos(a) * r];
  // red zone from K to the end of the scale, and the red tick at K
  const aK = dialAngle(K, max);
  x.strokeStyle = "rgba(196,40,32,0.28)";
  x.lineWidth = 16;
  x.beginPath();
  x.arc(c, c, R - 40, aK - Math.PI / 2, dialAngle(max, max) - Math.PI / 2);
  x.stroke();
  const step = max / 5;
  const minor = step / 5;
  for (let v = 0; v <= max + 1e-6; v += minor) {
    const a = dialAngle(v, max);
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    const [x0, y0] = pt(a, R - 28);
    const [x1, y1] = pt(a, R - (major ? 64 : 46));
    x.strokeStyle = "#2a1f14";
    x.lineWidth = major ? 6 : 2.5;
    x.beginPath();
    x.moveTo(x0, y0);
    x.lineTo(x1, y1);
    x.stroke();
    if (major) {
      const [tx, ty] = pt(a, R - 100);
      x.font = "700 44px Georgia, 'Times New Roman', serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillStyle = "#2a1f14";
      x.fillText(String(Math.round(v)), tx, ty);
    }
  }
  {
    const [x0, y0] = pt(aK, R - 22);
    const [x1, y1] = pt(aK, R - 76);
    x.strokeStyle = "#c4281f";
    x.lineWidth = 10;
    x.beginPath();
    x.moveTo(x0, y0);
    x.lineTo(x1, y1);
    x.stroke();
  }
  x.textAlign = "center";
  x.textBaseline = "alphabetic";
  x.fillStyle = "#3a2c1c";
  x.font = "600 30px Georgia, 'Times New Roman', serif";
  x.fillText("stress here", c, c + 108);
  x.fillText("÷ grip pull", c, c + 142);
  x.fillStyle = "#c4281f";
  x.font = "700 26px Georgia, 'Times New Roman', serif";
  x.fillText(`red = hole edge ×${K.toFixed(K < 9.95 ? 2 : 1)}`, c, c + 186);
}
