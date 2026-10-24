import "./styles.css";
import { DEFAULTS, Model, type PresetId } from "./model";
import { Scene2D } from "./scene2d";
import { LOAD_MAX, N_PER_MPA, PLATE, full3, selfTest, type HoleShape, type Loading } from "./stress";
import { f1, f2, type Anchors, type Layout, type View } from "./view";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const recording = params.get("record") === "1";
if (recording) document.documentElement.classList.add("ix-record");
const force2d = params.get("renderer") === "2d";
const isPhone = () => innerWidth <= 760;
/** Phone portrait or a short landscape phone: the plate gets the free area, labels and readouts slim down. */
const isCompact = () => innerWidth <= 760 || innerHeight <= 500;

const model = new Model(isPhone() ? [300, 400] : [480, 640]);
const stage = $("stage");
let view: View;
let frames = 0;
/** Set once the user drags or taps the probe; on phones its "drag me" label then steps aside. */
let touchedProbe = false;
let fps = 60;

// ───────────────────────── renderer selection ─────────────────────────

async function makeWebGL(): Promise<View> {
  const probe = document.createElement("canvas");
  const ctx = probe.getContext("webgl2");
  if (!ctx) throw new Error("WebGL2 unavailable");
  (ctx.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
  const { Scene3D } = await import("./scene3d");
  return new Scene3D(stage, { hq: recording });
}

function use2D(): void {
  view = new Scene2D(stage);
  $("badge").hidden = false;
  onResize();
}

function switchTo2D(reason: string): void {
  if (view?.kind === "2d") return;
  console.warn(`[stress-tensor] using Canvas2D fallback: ${reason}`);
  try {
    view?.dispose();
  } catch {
    /* ignore */
  }
  stage.querySelectorAll("canvas").forEach((c) => c.remove());
  use2D();
}

async function boot(): Promise<void> {
  if (force2d) use2D();
  else {
    try {
      view = await makeWebGL();
      view.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        switchTo2D("webglcontextlost");
      });
      onResize();
      view.render(0, model); // compile now so init errors surface here
    } catch (err) {
      switchTo2D(`WebGL init failed: ${(err as Error)?.message ?? err}`);
    }
  }
  model.startWow();
  readyT = performance.now();
  window.__ixRecord.ready = true;
  requestAnimationFrame(loop);
}

// ───────────────────────── layout ─────────────────────────

const dock = $("dock");
const adv = $("adv");
const mohr = $("mohr");
const intro = $("intro");
const rightCol = $("right-col");
const explain = $("explain");
const foot = document.querySelector(".credit-foot") as HTMLElement;

function computeLayout(w: number, h: number): Layout {
  if (isPhone()) {
    const top = intro.getBoundingClientRect().bottom + 2;
    const sheet = adv.hidden ? dock : adv;
    const bottom = sheet.getBoundingClientRect().top - 2;
    return { x: 4, y: top, w: w - 8, h: Math.max(160, bottom - top), phone: true, compact: true };
  }
  const left = dock.getBoundingClientRect().right + 8;
  const rc = rightCol.getBoundingClientRect();
  const sideOpen = !adv.hidden || !mohr.hidden;
  const right = sideOpen ? rc.left - 8 : w - 10;
  const compact = isCompact();
  const top = compact ? 8 : 10;
  const bottom = compact ? h - 30 : h - 34;
  return { x: left, y: top, w: Math.max(compact ? 160 : 240, right - left), h: Math.max(compact ? 140 : 200, bottom - top), phone: false, compact };
}

let layoutKey = "";
function onResize(): void {
  const L = computeLayout(innerWidth, innerHeight);
  document.documentElement.classList.toggle("compact", isCompact());
  layoutKey = `${innerWidth}|${innerHeight}|${Math.round(L.x)}|${Math.round(L.y)}|${Math.round(L.w)}|${Math.round(L.h)}`;
  view?.resize(innerWidth, innerHeight, L);
}
function checkLayout(): void {
  const L = computeLayout(innerWidth, innerHeight);
  const k = `${innerWidth}|${innerHeight}|${Math.round(L.x)}|${Math.round(L.y)}|${Math.round(L.w)}|${Math.round(L.h)}`;
  if (k !== layoutKey) onResize();
}
addEventListener("resize", () => syncPanels());

// ───────────────────────── pointer: drag the probe, tap to place it, else orbit ─────────────────────────

let drag: { id: number; dx: number; dy: number } | null = null;
let down: { id: number; x: number; y: number; t: number } | null = null;

function overProbe(e: PointerEvent): boolean {
  if (!view) return false;
  const p = view.probeScreen();
  return Math.hypot(e.clientX - p.x, e.clientY - p.y) < p.r + (e.pointerType === "touch" ? 18 : 8);
}

stage.addEventListener(
  "pointerdown",
  (e) => {
    view?.poke();
    if (overProbe(e)) {
      const pp = view.platePoint(e.clientX, e.clientY);
      drag = { id: e.pointerId, dx: pp ? model.s.probe.x - pp.x : 0, dy: pp ? model.s.probe.y - pp.y : 0 };
      model.setProbe(model.s.probe.x, model.s.probe.y);
      stage.classList.add("dragging");
      touchedProbe = true;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
  },
  { capture: true },
);
addEventListener("pointermove", (e) => {
  if (drag && e.pointerId === drag.id) {
    const pp = view.platePoint(e.clientX, e.clientY);
    if (pp) model.setProbe(pp.x + drag.dx, pp.y + drag.dy);
    e.preventDefault();
    return;
  }
  if (!e.buttons && view) stage.classList.toggle("over-probe", overProbe(e));
});
function endPointer(e: PointerEvent): void {
  if (drag && e.pointerId === drag.id) {
    drag = null;
    stage.classList.remove("dragging");
    return;
  }
  if (down && e.pointerId === down.id) {
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (e.type === "pointerup" && moved < 6 && performance.now() - down.t < 400) {
      const pp = view.platePoint(e.clientX, e.clientY);
      if (pp && Math.abs(pp.x) < PLATE.halfW && Math.abs(pp.y) < PLATE.halfH - 0.8) {
        model.moveProbeTo(pp.x, pp.y);
        touchedProbe = true;
      }
    }
    down = null;
  }
}
addEventListener("pointerup", endPointer);
addEventListener("pointercancel", endPointer);

// ───────────────────────── controls ─────────────────────────

const loadIn = $<HTMLInputElement>("load");
const cutIn = $<HTMLInputElement>("cut");
const axesIn = $<HTMLInputElement>("axes");
const slotIn = $<HTMLInputElement>("slot-ratio");
const holeSel = $<HTMLSelectElement>("hole");
const loadingSel = $<HTMLSelectElement>("loading");
const chkMohr = $<HTMLInputElement>("show-mohr");
const chkIso = $<HTMLInputElement>("show-isoclinics");
const chkRanks = $<HTMLInputElement>("show-ranks");
loadIn.max = String(LOAD_MAX);

const pressed = new Set<HTMLInputElement>();
for (const el of [loadIn, cutIn, axesIn, slotIn]) {
  el.addEventListener("pointerdown", () => pressed.add(el));
}
addEventListener("pointerup", () => pressed.clear());
addEventListener("pointercancel", () => pressed.clear());

loadIn.addEventListener("input", () => model.setLoad(+loadIn.value));
cutIn.addEventListener("input", () => model.setCut(+cutIn.value));
axesIn.addEventListener("input", () => model.setAxes(+axesIn.value));
slotIn.addEventListener("input", () => model.setSlotRatio(+slotIn.value));
holeSel.addEventListener("change", () => model.setHole(holeSel.value as HoleShape));
loadingSel.addEventListener("change", () => model.setLoading(loadingSel.value as Loading));
chkMohr.addEventListener("change", () => {
  model.setToggle("showMohr", chkMohr.checked);
  syncPanels();
});
chkIso.addEventListener("change", () => model.setToggle("showIso", chkIso.checked));
chkRanks.addEventListener("change", () => model.setToggle("showRanks", chkRanks.checked));
$("btn-axes").addEventListener("click", () => model.turnAxes());
$("btn-reset").addEventListener("click", () => {
  model.reset();
  view?.resetCamera();
  touchedProbe = false;
  syncControls(true);
  syncPanels();
});
for (const id of ["edge", "far", "top"] as PresetId[]) $(`preset-${id}`).addEventListener("click", () => model.preset(id));

const advBtn = $("btn-advanced");
function setAdv(open: boolean): void {
  adv.hidden = !open;
  advBtn.setAttribute("aria-expanded", String(open));
  advBtn.classList.toggle("on", open);
  syncPanels();
}
advBtn.addEventListener("click", () => setAdv(adv.hidden));
$("btn-adv-close").addEventListener("click", () => setAdv(false));

const sheetBtn = $("btn-sheet");
const detailsBtn = $("btn-details");
function setSheet(open: boolean): void {
  dock.classList.toggle("collapsed", !open);
  sheetBtn.setAttribute("aria-expanded", String(open));
  setText($("sheet-label"), open ? "Hide controls" : "Show controls");
  onResize();
}
sheetBtn.addEventListener("click", () => setSheet(dock.classList.contains("collapsed")));
detailsBtn.addEventListener("click", () => {
  const open = !dock.classList.contains("details");
  dock.classList.toggle("details", open);
  detailsBtn.setAttribute("aria-expanded", String(open));
  detailsBtn.classList.toggle("on", open);
  onResize();
});

function syncPanels(): void {
  mohr.hidden = !model.s.showMohr;
  // on a phone with the Advanced sheet open, Mohr's circle rides inside the sheet instead of over the rig
  const inSheet = isPhone() && !adv.hidden;
  if (inSheet && mohr.parentElement !== adv) adv.insertBefore(mohr, adv.querySelector(".card-mini"));
  else if (!inSheet && mohr.parentElement !== rightCol) rightCol.appendChild(mohr);
  mohr.classList.toggle("in-sheet", inSheet);
  rightCol.classList.toggle("open", !adv.hidden || !mohr.hidden);
  document.documentElement.classList.toggle("adv-open", !adv.hidden);
  onResize();
}

function setRange(el: HTMLInputElement, v: number): void {
  if (pressed.has(el)) return;
  const s = String(Math.round(v * 100) / 100);
  if (el.value !== s) el.value = s;
}

function syncControls(force = false): void {
  const s = model.s;
  setRange(loadIn, s.load);
  setRange(cutIn, s.cut);
  setRange(axesIn, s.axes);
  setRange(slotIn, s.slotRatio);
  if (force || document.activeElement !== holeSel) holeSel.value = s.hole;
  if (force || document.activeElement !== loadingSel) loadingSel.value = s.loading;
  chkMohr.checked = s.showMohr;
  chkIso.checked = s.showIso;
  chkRanks.checked = s.showRanks;
  $("slot-box").classList.toggle("dim", s.hole !== "slot");
}

// ───────────────────────── intro card ─────────────────────────

const helpBtn = $("btn-help");
const INTRO_KEY = "stress-tensor:intro-seen";

function setExplain(open: boolean, remember = true): void {
  if (explain.hidden === !open) return;
  explain.hidden = !open;
  helpBtn.setAttribute("aria-expanded", String(open));
  if (open) $("btn-explain-ok").focus({ preventScroll: true });
  else if (remember) {
    try {
      localStorage.setItem(INTRO_KEY, "1");
    } catch {
      /* private mode */
    }
  }
}
helpBtn.addEventListener("click", () => setExplain(explain.hidden));
$("btn-explain-x").addEventListener("click", () => setExplain(false));
$("btn-explain-ok").addEventListener("click", () => setExplain(false));
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !explain.hidden) setExplain(false);
});
document.addEventListener(
  "pointerdown",
  (e) => {
    const t = e.target as Node;
    if (!explain.hidden && !explain.contains(t) && !helpBtn.contains(t)) setExplain(false);
  },
  true,
);
{
  let seen = false;
  try {
    seen = localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    /* ignore */
  }
  if (!seen && !recording && params.get("intro") !== "0") setExplain(true, false);
}

// ───────────────────────── labels next to the objects ─────────────────────────

interface LabelDef {
  id: string;
  cls: string;
  /** Preferred direction from the anchor (screen px); "probe" = away from the probe. */
  dir: [number, number] | "probe";
  dirPhone?: [number, number];
  text: () => string | null;
}

const labelDefs: LabelDef[] = [
  { id: "probe", cls: "glass", dir: [-1, 1], text: () => (isCompact() ? "Probe <small>(drag me)</small>" : "Glass probe <small>(drag me)</small>") },
  { id: "pull", cls: "amber", dir: "probe", text: () => (Math.abs(model.trac.normal) < 0.05 ? "No pull on this cut" : `${model.trac.normal >= 0 ? "Pull on" : "Push on"} this cut <b>${f1(Math.abs(model.trac.normal))} MPa</b>`) },
  { id: "slide", cls: "cyan", dir: "probe", text: () => (Math.abs(model.trac.shear) < 0.05 ? "No slide along this cut" : `Slide along this cut <b>${f1(Math.abs(model.trac.shear))} MPa</b>`) },
  { id: "cut", cls: "cut", dir: "probe", text: () => "Cut" },
  { id: "card", cls: "", dir: [0, -1], text: () => "Stress grid at the probe <small>(the tensor)</small>" },
  { id: "dial", cls: "", dir: [0, 1], dirPhone: [0, -1], text: () => "Pull at the hole's edge vs at the grips" },
  { id: "bands", cls: "", dir: [-1, -0.4], text: () => (model.s.load > 0.2 ? "Stress bands <small>(more bands = more stress)</small>" : null) },
  { id: "axes", cls: "", dir: [-1, 0.6], text: () => "Measuring axes" },
  { id: "plate", cls: "", dir: [-1, -1], text: () => "Plate with a hole" },
  { id: "principal", cls: "", dir: "probe", text: () => (model.s.showIso ? "no slide here" : null) },
  { id: "rank0", cls: "small", dir: [0, 1], text: () => "1 number<br><small>scalar</small>" },
  { id: "rank1", cls: "small", dir: [0, 1], text: () => "3 numbers<br><small>vector</small>" },
  { id: "rank2", cls: "small", dir: [0, 1], text: () => "9 numbers<br><small>matrix: the card</small>" },
  { id: "rank3", cls: "small", dir: [0, 1], text: () => "27 numbers<br><small>3×3×3, like an RGB patch</small>" },
];

const labelsBox = $("labels");
const leaders = document.getElementById("leaders") as unknown as SVGSVGElement;
const labelEls = new Map<string, { el: HTMLElement; html: string; w: number; h: number; line: SVGLineElement; dot: SVGCircleElement }>();
for (const d of labelDefs) {
  const el = document.createElement("div");
  el.className = `lbl3d ${d.cls}`;
  labelsBox.appendChild(el);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("class", d.cls);
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("r", "2.5");
  dot.setAttribute("class", d.cls);
  leaders.append(line, dot);
  labelEls.set(d.id, { el, html: "", w: 0, h: 0, line, dot });
}

function obstacles(): DOMRect[] {
  const r: DOMRect[] = [];
  for (const el of [dock, adv, mohr, intro, explain, $("badge"), foot]) if (!el.hidden && el.offsetParent !== null) r.push(el.getBoundingClientRect());
  return r;
}

function layoutLabels(a: Anchors): void {
  const W = innerWidth, H = innerHeight;
  const phone = isPhone();
  const compact = isCompact();
  const obs = obstacles();
  const ir = intro.getBoundingClientRect();
  const top = phone ? ir.bottom + 2 : 4;
  const pr = a.probe;
  type B = { id: string; x: number; y: number; w: number; h: number; ax: number; ay: number };
  const boxes: B[] = [];
  for (const d of labelDefs) {
    const rec = labelEls.get(d.id)!;
    const an = a[d.id];
    // phones keep a single small label (the probe's hint) until it has been used; values live in the sheet
    if (compact && (d.id !== "probe" || touchedProbe || recording)) {
      rec.el.style.display = "none";
      rec.line.style.display = rec.dot.style.display = "none";
      continue;
    }
    const inside = an && an.on && an.x > 2 && an.x < W - 2 && an.y > top && an.y < H - 2 && !obs.some((r) => r !== ir && an.x > r.left && an.x < r.right && an.y > r.top && an.y < r.bottom);
    const txt = inside ? d.text() : null;
    if (!txt) {
      rec.el.style.display = "none";
      rec.line.style.display = rec.dot.style.display = "none";
      continue;
    }
    rec.el.style.display = "";
    if (txt !== rec.html) {
      rec.el.innerHTML = txt;
      rec.html = txt;
      rec.w = rec.el.offsetWidth;
      rec.h = rec.el.offsetHeight;
    }
    let dx: number, dy: number;
    if (d.dir === "probe") {
      dx = pr ? an!.x - pr.x : 1;
      dy = pr ? an!.y - pr.y : 0;
      if (Math.hypot(dx, dy) < 3) [dx, dy] = [1, 0];
    } else [dx, dy] = phone && d.dirPhone ? d.dirPhone : d.dir;
    const n = Math.hypot(dx, dy) || 1;
    dx /= n;
    dy /= n;
    const off = phone ? 10 : 16;
    let x = an!.x + dx * off, y = an!.y + dy * off;
    x -= dx > 0.35 ? 0 : dx < -0.35 ? rec.w : rec.w / 2;
    y -= dy > 0.35 ? 0 : dy < -0.35 ? rec.h : rec.h / 2;
    boxes.push({ id: d.id, x, y, w: rec.w, h: rec.h, ax: an!.x, ay: an!.y });
  }
  // keep labels off the probe and off the arrows and cut springing from it
  const keepOut: { left: number; right: number; top: number; bottom: number }[] = [];
  if (pr) {
    keepOut.push({ left: pr.x - 16, right: pr.x + 16, top: pr.y - 16, bottom: pr.y + 16 });
    for (const id of ["pull", "slide", "cut"]) {
      const t = a[id];
      if (!t) continue;
      const n = Math.max(1, Math.ceil(Math.hypot(t.x - pr.x, t.y - pr.y) / 12));
      for (let i = 1; i <= n; i++) {
        const x = pr.x + ((t.x - pr.x) * i) / n, y = pr.y + ((t.y - pr.y) * i) / n;
        keepOut.push({ left: x - 7, right: x + 7, top: y - 7, bottom: y + 7 });
      }
    }
  }
  if (compact && a.holeA && a.holeB) {
    // never cover the fringes crowding round the hole
    keepOut.push({ left: Math.min(a.holeA.x, a.holeB.x), right: Math.max(a.holeA.x, a.holeB.x), top: Math.min(a.holeA.y, a.holeB.y), bottom: Math.max(a.holeA.y, a.holeB.y) });
  }
  const pad = 3;
  for (let it = 0; it < 50; it++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      const p = boxes[i];
      for (let j = i + 1; j < boxes.length; j++) {
        const q = boxes[j];
        const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) + pad;
        const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) + pad;
        if (ox > 0 && oy > 0) {
          moved = true;
          if (oy < ox) {
            const s = p.y + p.h / 2 < q.y + q.h / 2 ? -1 : 1;
            p.y += s * oy * 0.35;
            q.y -= s * oy * 0.65;
          } else {
            const s = p.x + p.w / 2 < q.x + q.w / 2 ? -1 : 1;
            p.x += s * ox * 0.35;
            q.x -= s * ox * 0.65;
          }
        }
      }
      for (const r of [...obs, ...keepOut]) {
        const ox = Math.min(p.x + p.w, r.right) - Math.max(p.x, r.left) + pad;
        const oy = Math.min(p.y + p.h, r.bottom) - Math.max(p.y, r.top) + pad;
        if (ox > 0 && oy > 0) {
          moved = true;
          const opts = [
            { d: r.right + pad - p.x, ax: "x" },
            { d: r.left - pad - (p.x + p.w), ax: "x" },
            { d: r.bottom + pad - p.y, ax: "y" },
            { d: r.top - pad - (p.y + p.h), ax: "y" },
          ].sort((u, v) => Math.abs(u.d) - Math.abs(v.d));
          const fits = (o: { d: number; ax: string }) => (o.ax === "x" ? p.x + o.d >= 4 && p.x + o.d <= W - p.w - 4 : p.y + o.d >= top && p.y + o.d <= H - p.h - 4);
          const o = opts.find(fits) ?? opts[0];
          if (o.ax === "x") p.x += o.d;
          else p.y += o.d;
        }
      }
      p.x = Math.max(4, Math.min(W - p.w - 4, p.x));
      p.y = Math.max(top, Math.min(H - p.h - 4, p.y));
    }
    if (!moved) break;
  }
  const hit = (b: B, x: number, y: number, w: number, h: number) => b.x < x + w - 2 && x < b.x + b.w - 2 && b.y < y + h - 2 && y < b.y + b.h - 2;
  const kept: B[] = [];
  for (const b of boxes) {
    const rec = labelEls.get(b.id)!;
    if (obs.some((r) => hit(b, r.left, r.top, r.width, r.height)) || kept.some((k) => hit(b, k.x, k.y, k.w, k.h))) {
      rec.el.style.display = "none";
      rec.line.style.display = rec.dot.style.display = "none";
      continue;
    }
    kept.push(b);
    rec.el.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
    const cx = Math.max(b.x, Math.min(b.x + b.w, b.ax)), cy = Math.max(b.y, Math.min(b.y + b.h, b.ay));
    const far = Math.hypot(cx - b.ax, cy - b.ay) > 6;
    rec.line.style.display = far ? "" : "none";
    rec.dot.style.display = "";
    rec.line.setAttribute("x1", b.ax.toFixed(1));
    rec.line.setAttribute("y1", b.ay.toFixed(1));
    rec.line.setAttribute("x2", cx.toFixed(1));
    rec.line.setAttribute("y2", cy.toFixed(1));
    rec.dot.setAttribute("cx", b.ax.toFixed(1));
    rec.dot.setAttribute("cy", b.ay.toFixed(1));
  }
}

// ───────────────────────── caption ─────────────────────────

const captionText = $("caption-text");
const caption = $("caption");
const times = (v: number) => (Math.abs(v - Math.round(v)) < 0.06 ? `${Math.round(v)}x` : `${v.toFixed(1)}x`);
let lastLoad = model.s.load;
let loadDir = 1;

function positionLine(): string {
  const m = model, s = m.s;
  const S = s.load;
  const r = Math.hypot(s.probe.x / m.hole.ax, s.probe.y / m.hole.by);
  if (m.prin.s2 < -0.3 * S && Math.abs(m.prin.s2) > Math.abs(m.prin.s1) && s.loading === "pull") return "Above the hole the plate is actually being squeezed, even though you're pulling it.";
  if (m.here >= 0.85 * m.K && r < 1.25) {
    if (s.hole === "circle" && s.loading === "pull") return `Right at the side of the hole: about ${times(m.here)} the pull at the grips. This is where cracks start.`;
    return `Right at the hole's edge: about ${times(m.here)} the grip pull, the highest anywhere on the plate. This is where cracks start.`;
  }
  if (Math.hypot(s.probe.x, s.probe.y) > 3 && Math.abs(m.here - 1) < 0.12 && s.loading !== "shear") return `Far from the hole the plate just feels the grips: about ${times(m.here)} their pull, and the bands are even.`;
  return `Here the strongest stress is ${times(m.here)} the grip pull. Turn the cut to feel it from another side.`;
}

function holeLine(): string {
  const m = model, s = m.s;
  const K = m.K;
  if (s.loading === "biaxial") return `Pulled both ways: the hole's edge feels ${times(K)} the grip pull.`;
  if (s.loading === "shear") return `Twist-like shear: the edge peaks at ${times(K)}, pulled along one diagonal and squeezed along the other.`;
  if (s.hole === "slot") return `A thin slot concentrates stress far more: about 1 + 2 x (length ÷ width) times. Here 1 + 2 × ${s.slotRatio} = ${times(K)}.`;
  if (s.hole === "ellipse") return `An oval hole lying across the pull: its tips feel 1 + 2 × 2 = ${times(K)} the grip pull.`;
  return "Rainbow bands show stress: they crowd at the sides of the hole, where the pull is 3x stronger.";
}

function captionNow(): string {
  const m = model, s = m.s, t = m.time, ev = m.ev;
  if (s.load < 0.05) return "No pull yet, so the plate stays black: drag Pull harder. An unstressed plate looks black between the filters.";
  // the reset's own glide shouldn't read as "pulling harder"
  if (t - ev.reset < 1.6 && ev.user - ev.reset < 0.05) return "Back to the example: 3.5 MPa pull, a round hole, the probe at the hole's side.";
  const recent: [string, number, number][] = [
    ["load", ev.load, 1.6],
    ["cut", ev.cut, 2.4],
    ["axes", ev.axes, 3.2],
    ["probe", ev.probe, 2.6],
    ["preset", ev.preset, 2.6],
    ["hole", ev.hole, 5],
    ["loading", ev.loading, 5],
    ["reset", ev.reset, 2.2],
  ];
  let best: string | null = null, bt = -1e9;
  for (const [k, at, win] of recent) if (t - at < win && at > bt) {
    best = k;
    bt = at;
  }
  switch (best) {
    case "load":
      return loadDir >= 0 ? "Pulling harder: stress grows everywhere, so more bands appear." : "Easing off: the stress drops and the bands melt back toward black.";
    case "cut":
      if (m.principalNow || m.flash > 0.2) return "No sliding at this angle: this is a principal direction.";
      return "Same spot, different slice: the pull and slide change with the angle of the cut.";
    case "axes":
      return "Every number in the grid changed, yet the arrows and bands didn't move. The numbers are just one view of the same stress.";
    case "probe":
    case "preset":
      return positionLine();
    case "hole":
    case "loading":
      return holeLine();
    case "reset":
      return "Back to the example: 3.5 MPa pull, a round hole, the probe at the hole's side.";
  }
  if (t - Math.max(...recent.map((r) => r[1])) > 7 || s.hole !== "circle" || s.loading !== "pull") return holeLine();
  return positionLine();
}

// ───────────────────────── readouts ─────────────────────────

const el = {
  loadV: $("load-val"),
  cutV: $("cut-val"),
  axesV: $("axes-val"),
  normal: $("r-normal"),
  normalD: $("r-normal-d"),
  shear: $("r-shear"),
  trace: $("r-trace"),
  s1: $("r-s1"),
  s2: $("r-s2"),
  here: $("r-here"),
  k: $("r-k"),
  fringe: $("r-fringe"),
  more: $("r-more"),
  holeK: $("hole-k"),
  slotV: $("slot-val"),
  mNormal: $("m-normal"),
  mShear: $("m-shear"),
  txx: $("t-xx"),
  txy: $("t-xy"),
  tyx: $("t-yx"),
  tyy: $("t-yy"),
};
const setText = (e: HTMLElement, s: string) => {
  if (e.textContent !== s) e.textContent = s;
};

function updateHud(): void {
  const m = model, s = m.s;
  if (Math.abs(s.load - lastLoad) > 1e-6) loadDir = s.load > lastLoad ? 1 : -1;
  lastLoad = s.load;
  setText(el.loadV, `${s.load.toFixed(1)} MPa`);
  setText(el.cutV, `${Math.round(s.cut)}°`);
  setText(el.axesV, `${Math.round(s.axes)}°`);
  const n = m.trac.normal;
  setText(el.normal, `${f1(n)} MPa`);
  el.normal.parentElement!.classList.toggle("push", n < -0.05);
  setText(el.shear, `${f1(Math.abs(m.trac.shear))} MPa`);
  setText(el.mNormal, `${f1(n)} MPa`);
  setText(el.mShear, `${f1(Math.abs(m.trac.shear))} MPa`);
  setText(el.txx, f1(m.sigmaRot.xx));
  setText(el.txy, f1(m.sigmaRot.xy));
  setText(el.tyx, f1(m.sigmaRot.xy));
  setText(el.tyy, f1(m.sigmaRot.yy));
  setText(el.trace, f1(m.inv.trace));
  setText(el.s1, f1(m.inv.s1));
  setText(el.s2, f1(m.inv.s2));
  setText(el.here, s.load < 0.05 ? "—" : `×${f2(m.here)}`);
  setText(el.k, `At the hole's edge it peaks at ×${f2(m.K)}: the stress concentration factor.`);
  setText(el.fringe, m.fringeMax.toFixed(1));
  setText(el.more, `det ${f1(m.inv.det)} MPa² · von Mises ${f1(m.inv.vonMises)} MPa · max slide ${f1(m.prin.maxShear)} MPa · σ₁ points ${Math.round(m.prin.angleDeg)}° from x`);
  setText(el.holeK, `K = ${f2(m.K)}`);
  setText(el.slotV, `${s.slotRatio} : 1 → tip ×${f2(1 + 2 * s.slotRatio)}`);
  const full = captionNow();
  // phones: the first sentence carries the point; the rest would cover the scene
  const cap = isCompact() ? (full.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? full) : full;
  if (captionText.textContent !== cap) {
    captionText.textContent = cap;
    caption.classList.remove("pulse");
    void caption.offsetWidth;
    caption.classList.add("pulse");
  }
  caption.classList.toggle("gold", m.principalNow && m.time - m.ev.cut < 2.4);
  if (!mohr.hidden) drawMohr();
}

// ───────────────────────── Mohr's circle ─────────────────────────

const mohrCanvas = $<HTMLCanvasElement>("mohr-canvas");
const mctx = mohrCanvas.getContext("2d")!;
let mohrKey = "";
function drawMohr(): void {
  const m = model;
  const { s1, s2 } = m.inv;
  const key = `${s1.toFixed(3)}|${s2.toFixed(3)}|${m.trac.normal.toFixed(3)}|${m.trac.shear.toFixed(3)}|${m.sigmaRot.xx.toFixed(3)}|${m.principalNow}`;
  if (key === mohrKey) return;
  mohrKey = key;
  const W = mohrCanvas.width, H = mohrCanvas.height, x = mctx;
  x.clearRect(0, 0, W, H);
  x.fillStyle = "#efe6d2";
  x.beginPath();
  x.roundRect(0, 0, W, H, 18);
  x.fill();
  const c = (s1 + s2) / 2, R = (s1 - s2) / 2;
  const span = Math.max(1, Math.max(Math.abs(s1), Math.abs(s2), R * 2) * 1.15);
  const sc = Math.min((W - 80) / (2 * span), (H - 70) / (2 * Math.max(R, 0.3 * span)));
  const ox = W / 2 - c * sc * (Math.abs(c) < span ? 1 : 0), oy = H / 2;
  const X = (v: number) => ox + v * sc, Y = (v: number) => oy - v * sc;
  x.strokeStyle = "rgba(60,45,25,0.55)";
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(24, oy);
  x.lineTo(W - 24, oy);
  x.moveTo(X(0), 18);
  x.lineTo(X(0), H - 18);
  x.stroke();
  x.fillStyle = "#3a2c1c";
  x.font = "600 22px Georgia, serif";
  x.textAlign = "right";
  x.fillText("pull →", W - 26, oy - 10);
  x.textAlign = "left";
  x.fillText("slide", X(0) + 8, 36);
  x.strokeStyle = "#2a1f14";
  x.lineWidth = 3;
  x.beginPath();
  x.arc(X(c), oy, Math.max(1, R * sc), 0, Math.PI * 2);
  x.stroke();
  // the axes' two faces (a diameter) and the principal ends
  const r = m.sigmaRot;
  x.strokeStyle = "rgba(120,90,40,0.8)";
  x.setLineDash([8, 6]);
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(X(r.xx), Y(-r.xy));
  x.lineTo(X(r.yy), Y(r.xy));
  x.stroke();
  x.setLineDash([]);
  x.font = "600 21px Georgia, serif";
  x.textAlign = "center";
  for (const [v, name] of [
    [s1, "σ₁"],
    [s2, "σ₂"],
  ] as const) {
    x.fillStyle = "#2a1f14";
    x.beginPath();
    x.arc(X(v), oy, 6, 0, Math.PI * 2);
    x.fill();
    x.fillText(name, X(v), oy + 30);
  }
  const prim = m.s.axes > 0.05 && m.s.axes < 179.95 ? "′" : "";
  x.fillStyle = "#7a5a28";
  x.fillText(`x${prim}`, X(r.xx), Y(-r.xy) - 12);
  x.fillText(`y${prim}`, X(r.yy), Y(r.xy) - 12);
  // the current cut
  const px = X(m.trac.normal), py = Y(m.trac.shear);
  x.fillStyle = m.principalNow ? "#e0a92a" : "#0f8fb5";
  x.strokeStyle = "#111";
  x.lineWidth = 2.5;
  x.beginPath();
  x.arc(px, py, 11, 0, Math.PI * 2);
  x.fill();
  x.stroke();
  x.fillStyle = "#1a1208";
  x.font = "700 20px Georgia, serif";
  x.textAlign = px > W / 2 ? "right" : "left";
  x.fillText("this cut", px + (px > W / 2 ? -18 : 18), py - 14);
}

// ───────────────────────── loop ─────────────────────────

let last = performance.now();
let fpsT = 0, fpsN = 0;
let stepped = false;
let readyT = Infinity;

function loop(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  // In record mode the clock waits for the recorder's fixed-dt steps (or starts on its own 3 s after ready).
  if (!stepped) frame(recording && now - readyT < 3000 ? 0 : dt);
  requestAnimationFrame(loop);
}

function frame(dt: number, draw = true): void {
  model.step(dt);
  syncControls();
  if (draw && view) {
    try {
      view.render(dt, model);
    } catch (err) {
      if (view.kind === "webgl") switchTo2D(`render error: ${(err as Error)?.message ?? err}`);
      else throw err;
    }
    layoutLabels(view.anchors());
  }
  updateHud();
  if (frames % 10 === 0) checkLayout();
  frames++;
  const now = performance.now();
  if (!fpsT) fpsT = now;
  fpsN++;
  if (now - fpsT >= 500) {
    fps = (fpsN * 1000) / (now - fpsT);
    fpsT = now;
    fpsN = 0;
  }
}

// ───────────────────────── hooks ─────────────────────────

declare global {
  interface Window {
    __stressInfo: () => Record<string, unknown>;
    __stressSelfTest: () => ReturnType<typeof selfTest>;
    __stressAdvance: (seconds: number) => Record<string, unknown>;
    __stressAnchors: () => Anchors;
    __ixRecord: { ready: boolean; setStepped: (on: boolean) => void; stepFrame: (dt: number) => void };
  }
}
const r6 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x);
const r6m = (m: number[][]) => m.map((row) => row.map(r6));
window.__stressInfo = () => {
  const m = model, s = m.s;
  return {
    renderer: view?.kind ?? "webgl",
    load: r6(s.load),
    hole: s.hole,
    slotRatio: s.slotRatio,
    loading: s.loading,
    probe: { x: r6(s.probe.x), y: r6(s.probe.y) },
    cutDeg: r6(s.cut),
    axesDeg: r6(s.axes),
    tensor: r6m(full3(m.sigma)),
    tensorRotated: r6m(full3(m.sigmaRot)),
    traction: { normal: r6(m.trac.normal), shear: r6(m.trac.shear) },
    principal: { s1: r6(m.prin.s1), s2: r6(m.prin.s2), angleDeg: r6(m.prin.angleDeg) },
    trace: r6(m.inv.trace),
    traceRotated: r6(m.sigmaRot.xx + m.sigmaRot.yy),
    det: r6(m.inv.det),
    vonMises: r6(m.inv.vonMises),
    concentration: r6(m.K),
    here: r6(m.here),
    fringeMax: r6(m.fringeMax),
    fringesPerMPa: N_PER_MPA,
    principalCut: m.principalNow,
    showMohr: s.showMohr,
    showIso: s.showIso,
    showRanks: s.showRanks,
    defaults: { ...DEFAULTS },
    wow: m.wowActive,
    wowT: r6(m.wowT),
    caption: captionText.textContent ?? "",
    gridVersion: m.gridVersion,
    frames,
    fps: Math.round(fps * 10) / 10,
    nan: !m.finite(),
  };
};
/** On-screen bounding box of the plate (CSS px), from its four corners. */
(window as unknown as { __stressPlateRect: () => unknown }).__stressPlateRect = () => {
  const a = view?.anchors() ?? {};
  const pts = ["pc0", "pc1", "pc2", "pc3"].map((k) => a[k]).filter((p): p is NonNullable<typeof p> => !!p);
  if (pts.length < 4) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };
};
window.__stressSelfTest = () => selfTest();
window.__stressAnchors = () => view?.anchors() ?? {};
(window as unknown as { __stressView: () => View }).__stressView = () => view;
window.__stressAdvance = (seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 30) frame(1 / 30, false);
  return window.__stressInfo();
};
// Deterministic fixed-dt stepping for scripts/record-demo.mjs ("capture": "frames").
window.__ixRecord = {
  ready: false,
  setStepped(on: boolean) {
    stepped = on;
    if (on) setExplain(false, false);
  },
  stepFrame(dt: number) {
    frame(Math.min(0.1, Math.max(1 / 240, dt || 1 / 30)));
  },
};

syncControls(true);
syncPanels();
void boot();
