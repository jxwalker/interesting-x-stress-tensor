/**
 * WebGL rig (three.js): a clear plate with a hole clamped in brass grips under a screw press, in front of a
 * dark polariser; the isochromatic fringes are a matte, unlit layer on the plate face (computed per pixel
 * from the sampled stress field and the spectral colour table, pre-compensated for the ACES tone map so
 * the colours on screen are the computed ones). A glass probe with the cut and two matte arrows, a brass
 * axis gnomon, the engraved tensor card, the concentration dial and the optional tensor-ranks shelf.
 * PBR brass and walnut, RoomEnvironment reflections, soft shadows, ACES, light bloom on the probe only.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Model } from "./model";
import { LUT_MAX_N, LUT_SIZE, PLATE, fringeLut, type Hole } from "./stress";
import { AMBER, CYAN, GOLD, type Anchors, type Layout, type View } from "./view";
import { CARD, DIAL, dialAngle, dialMax, drawCard, drawDial, letter, stripes, walnut, wear } from "./textures";

/** World units per unit of a (the hole's half-width). */
const U = 0.2;
const PW = PLATE.halfW * U;
const PH = PLATE.halfH * U;
const T = 0.07;
const PC = new THREE.Vector3(0, 1.62, 0);
const SURF = T / 2 + 0.012;
const EXPOSURE = 1.0;

interface Arrangement {
  card: [number, number, number];
  cardRot: [number, number];
  cardScale: number;
  dial: [number, number, number];
  dialRot: number;
  dialScale: number;
  shelf: [number, number, number];
  focus: [number, number, number];
  heroW: number;
  heroH: number;
  yaw: number;
  pitch: number;
}

const DESK: Arrangement = {
  card: [2.38, 0, 0.32],
  cardRot: [-0.3, 0],
  cardScale: 1.32,
  dial: [3.62, 0, 0.55],
  dialRot: -0.4,
  dialScale: 1.15,
  shelf: [0.25, 0, 1.25],
  focus: [1.3, 1.78, 0.1],
  heroW: 5.6,
  heroH: 4.1,
  yaw: -0.2,
  pitch: 0.12,
};
const PHONE: Arrangement = {
  card: [-0.66, 0, 1.95],
  cardRot: [0.1, -0.28],
  cardScale: 1.0,
  dial: [0.8, 0, 2.0],
  dialRot: -0.06,
  dialScale: 1.05,
  shelf: [0, 0, 2.8],
  focus: [0, 1.5, 0.9],
  heroW: 2.75,
  heroH: 3.95,
  yaw: -0.12,
  pitch: 0.2,
};

// ───────────────────────── colour: undo ACES so data surfaces show their exact colours ─────────────────────────
const IN = new THREE.Matrix3().set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777);
const OUT = new THREE.Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602);
const IN_INV = IN.clone().invert();
const OUT_INV = OUT.clone().invert();

function invRRT(y: number): number {
  y = Math.max(0, Math.min(0.985, y));
  const A = 1 - 0.983729 * y, B = 0.0245786 - 0.432951 * y, C = -(0.000090537 + 0.238081 * y);
  return (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
}
/** Linear-light colour that the ACES + sRGB output turns back into the given sRGB hex. */
function display(hex: string, gain = 1): THREE.Color {
  const c = new THREE.Color(hex); // stored linear
  const v = new THREE.Vector3(c.r, c.g, c.b).multiplyScalar(gain).applyMatrix3(OUT_INV);
  v.set(invRRT(v.x), invRRT(v.y), invRRT(v.z)).applyMatrix3(IN_INV).multiplyScalar(0.6 / EXPOSURE);
  return new THREE.Color().setRGB(Math.max(0, v.x), Math.max(0, v.y), Math.max(0, v.z), THREE.LinearSRGBColorSpace);
}

const FRINGE_VERT = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRINGE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uField;
uniform sampler2D uLut;
uniform float uScale;
uniform float uLutMax;
uniform float uLutSize;
uniform float uIso;
uniform vec2 uCells;
uniform vec2 uHalf;
uniform mat3 uInInv;
uniform mat3 uOutInv;
uniform float uExposure;
uniform float uDim;
varying vec2 vPos;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 invRRT(vec3 y) {
  y = clamp(y, 0.0, 0.985);
  vec3 A = 1.0 - 0.983729 * y;
  vec3 B = 0.0245786 - 0.4329510 * y;
  vec3 C = -(0.000090537 + 0.238081 * y);
  return (-B + sqrt(B * B - 4.0 * A * C)) / (2.0 * A);
}
vec3 field(vec2 uv) { return texture2D(uField, vec2(uv.x, 1.0 - uv.y)).rgb; }

void main() {
  vec2 uv = vPos / (2.0 * uHalf) + 0.5;
  vec3 f = field(uv);
  float N = uScale * f.r;
  float u = clamp(N / uLutMax, 0.0, 1.0);
  vec3 col = texture2D(uLut, vec2((u * (uLutSize - 1.0) + 0.5) / uLutSize, 0.5)).rgb;
  if (uIso > 0.001) {
    vec2 p = uv * uCells;
    vec2 cell = floor(p) + 0.5;
    vec2 q = p - cell;
    vec2 cuv = cell / uCells;
    vec4 fc = texture2D(uField, vec2(cuv.x, 1.0 - cuv.y));
    if (fc.a < 0.5) {
      float th = 0.5 * atan(fc.b, fc.g);
      vec2 d1 = vec2(cos(th), sin(th));
      vec2 d2 = vec2(-d1.y, d1.x);
      float w = fwidth(p.x) * 1.3;
      float l1 = (1.0 - smoothstep(0.022, 0.022 + w, abs(dot(q, d2)))) * step(abs(dot(q, d1)), 0.34);
      float l2 = (1.0 - smoothstep(0.016, 0.016 + w, abs(dot(q, d1)))) * step(abs(dot(q, d2)), 0.2);
      float o1 = (1.0 - smoothstep(0.05, 0.05 + w, abs(dot(q, d2)))) * step(abs(dot(q, d1)), 0.37);
      float o2 = (1.0 - smoothstep(0.04, 0.04 + w, abs(dot(q, d1)))) * step(abs(dot(q, d2)), 0.23);
      col = mix(col, vec3(0.0), max(o1, o2) * 0.6 * uIso);
      col = mix(col, vec3(1.0), l1 * 0.9 * uIso);
      col = mix(col, vec3(0.85, 0.93, 1.0), l2 * 0.7 * uIso);
    }
  }
  col = min(col * uDim, vec3(0.9));
  vec3 v = uOutInv * srgbToLinear(col);
  v = invRRT(max(v, vec3(0.0)));
  vec3 lin = max(uInInv * v, vec3(0.0)) * 0.6 / uExposure;
  gl_FragColor = vec4(lin, 1.0);
}`;

const BACKDROP_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const BACKDROP_FRAG = /* glsl */ `
varying vec3 vDir;
void main() {
  float h = vDir.y;
  vec3 navy = vec3(0.010, 0.016, 0.040);
  vec3 charcoal = vec3(0.012, 0.012, 0.016);
  vec3 col = mix(charcoal, navy, smoothstep(-0.1, 0.5, h));
  float glow = exp(-pow(length(vDir.xz - vec2(0.0, -0.98)) * 1.6, 2.0));
  col += vec3(0.010, 0.016, 0.034) * glow;
  gl_FragColor = vec4(col, 1.0);
}`;

const FINISH = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.32 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uVig; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = 1.0 - uVig * smoothstep(0.35, 0.85, length(d * vec2(1.0, 0.9)));
      gl_FragColor = vec4(c.rgb * v, c.a);
    }`,
};

interface ArrowParts {
  group: THREE.Group;
  shaft: THREE.Mesh;
  head: THREE.Mesh;
  shaftO: THREE.Mesh;
  headO: THREE.Mesh;
  tip: THREE.Mesh;
}

export class Scene3D implements View {
  readonly kind = "webgl" as const;
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 120);
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private mobile = matchMedia("(max-width: 760px)").matches || matchMedia("(pointer: coarse)").matches;
  private w = 1;
  private h = 1;
  private layout: Layout = { x: 0, y: 0, w: 1, h: 1, phone: false };
  private arr: Arrangement = DESK;
  private fitDist = 10;
  private time = 0;
  private idle = 99;
  private anch: Anchors = {};

  // materials
  private brass!: THREE.MeshStandardMaterial;
  private brassDark!: THREE.MeshStandardMaterial;
  private brassSatin!: THREE.MeshStandardMaterial;
  private steel!: THREE.MeshStandardMaterial;
  private knurl!: THREE.MeshStandardMaterial;

  // rig parts
  private plateGroup = new THREE.Group();
  private plateBody!: THREE.Mesh;
  private fringe!: THREE.Mesh;
  private fringeMat!: THREE.ShaderMaterial;
  private fieldTex: THREE.DataTexture | null = null;
  private gridVersion = -1;
  private fieldVersion = -1;
  private topGrip = new THREE.Group();
  private screw!: THREE.Mesh;
  private screwTex!: THREE.CanvasTexture;
  private handle = new THREE.Group();

  // probe and friends (children of the plate group, in plate-local coordinates)
  private probe = new THREE.Group();
  private probeCore!: THREE.Mesh;
  private halo!: THREE.Sprite;
  private cut = new THREE.Group();
  private cutLine!: THREE.Mesh;
  private cutLineMat!: THREE.MeshBasicMaterial;
  private cutPlaneMat!: THREE.MeshBasicMaterial;
  private pull!: ArrowParts;
  private slide!: ArrowParts;
  private cross = new THREE.Group();
  private gnomon = new THREE.Group();
  private gnomonLetters: THREE.Sprite[] = [];
  private letterTex: Record<string, THREE.CanvasTexture> = {};
  private primedShown: boolean | null = null;

  // card, dial, shelf
  private cardGroup = new THREE.Group();
  private cardCanvas: HTMLCanvasElement;
  private cardCtx: CanvasRenderingContext2D;
  private cardTex!: THREE.CanvasTexture;
  private cardKey = "";
  private dialGroup = new THREE.Group();
  private dialCanvas: HTMLCanvasElement;
  private dialTex!: THREE.CanvasTexture;
  private dialKey = "";
  private needle = new THREE.Group();
  private needleAng = 0;
  private shelf = new THREE.Group();
  private shelfK = 0;

  private v = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private disposed = false;

  constructor(container: HTMLElement, opts: { hq?: boolean } = {}) {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", "A clear plate with a hole held in brass grips, glowing with rainbow stress bands. Drag the glass probe on the plate; drag elsewhere to turn the view.");
    container.appendChild(canvas);
    this.canvas = canvas;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", alpha: false, preserveDrawingBuffer: !!opts.hq });
    } catch (e) {
      canvas.remove();
      throw e;
    }
    this.renderer = renderer;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2));

    [this.cardCanvas, this.cardCtx] = (() => {
      const c = document.createElement("canvas");
      c.width = CARD.W;
      c.height = CARD.H;
      return [c, c.getContext("2d")!] as const;
    })();
    this.dialCanvas = document.createElement("canvas");
    this.dialCanvas.width = this.dialCanvas.height = DIAL.S;

    this.scene.fog = new THREE.FogExp2(0x06080e, 0.045);
    this.buildEnvironment();
    this.buildMaterials();
    this.buildBench();
    this.buildFrame();
    this.buildPlate();
    this.buildProbe();
    this.buildGnomon();
    this.buildCard();
    this.buildDial();
    this.buildShelf();
    this.arrange(DESK);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.6;
    this.controls.addEventListener("start", () => (this.idle = 0));

    const samples = this.mobile ? 2 : 4;
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.3, 10.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(FINISH));
  }

  // ───────────────────────── build ─────────────────────────

  private buildEnvironment(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    room.dispose();
    pmrem.dispose();

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(60, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: BACKDROP_VERT, fragmentShader: BACKDROP_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    sky.renderOrder = -10;
    this.scene.add(sky);

    const key = new THREE.SpotLight(0xffe7c8, 42, 30, 0.55, 0.7, 1.3);
    key.position.set(-3.2, 6.4, 4.6);
    key.target.position.set(0.9, 1.0, 0);
    key.castShadow = true;
    const sm = this.mobile ? 1024 : 2048;
    key.shadow.mapSize.set(sm, sm);
    key.shadow.camera.near = 3;
    key.shadow.camera.far = 16;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;

    const rim = new THREE.DirectionalLight(0x8fb2ff, 2.2);
    rim.position.set(4.5, 3.5, -4.5);
    const rim2 = new THREE.DirectionalLight(0xffb070, 1.2);
    rim2.position.set(-5, 2.5, -3.5);
    const fill = new THREE.DirectionalLight(0xbfd0ff, 0.45);
    fill.position.set(4, 2.5, 6);
    const cardLight = new THREE.SpotLight(0xfff2dc, 7, 12, 0.45, 0.8, 1.2);
    cardLight.position.set(2.2, 3.8, 4.2);
    cardLight.target.position.set(2.6, 1.0, 0.3);
    this.scene.add(key, key.target, rim, rim2, fill, cardLight, cardLight.target, new THREE.HemisphereLight(0x2a3a5c, 0x140b06, 0.45));
  }

  private buildMaterials(): void {
    const wearTex = new THREE.CanvasTexture(wear());
    wearTex.wrapS = wearTex.wrapT = THREE.RepeatWrapping;
    this.brass = new THREE.MeshStandardMaterial({ color: 0xc9a05a, metalness: 1, roughness: 0.32, roughnessMap: wearTex, envMapIntensity: 1.1 });
    this.brassDark = new THREE.MeshStandardMaterial({ color: 0x9a7536, metalness: 1, roughness: 0.42, roughnessMap: wearTex });
    this.brassSatin = new THREE.MeshStandardMaterial({ color: 0x9a7536, metalness: 0.9, roughness: 0.62, roughnessMap: wearTex });
    this.steel = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 1, roughness: 0.35, roughnessMap: wearTex });
    const kn = new THREE.CanvasTexture(stripes(24));
    kn.wrapS = kn.wrapT = THREE.RepeatWrapping;
    this.knurl = new THREE.MeshStandardMaterial({ color: 0xc19650, metalness: 1, roughness: 0.38, bumpMap: kn, bumpScale: 2.5 });
  }

  private buildBench(): void {
    const wTex = new THREE.CanvasTexture(walnut());
    wTex.colorSpace = THREE.SRGBColorSpace;
    wTex.wrapS = wTex.wrapT = THREE.RepeatWrapping;
    wTex.anisotropy = 4;
    const deskTex = wTex.clone();
    deskTex.repeat.set(5, 9);
    deskTex.needsUpdate = true;
    const desk = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: deskTex, roughness: 0.55, metalness: 0, color: 0x9a8070 }));
    desk.rotation.x = -Math.PI / 2;
    desk.receiveShadow = true;
    this.scene.add(desk);

    // walnut plinth with brass trim and feet
    const plinthMat = new THREE.MeshStandardMaterial({ map: wTex, roughness: 0.42, metalness: 0, color: 0xc0a090 });
    const plinth = new THREE.Mesh(new RoundedBoxGeometry(2.7, 0.28, 1.3, 3, 0.04), plinthMat);
    plinth.position.set(0, 0.06 + 0.14, 0);
    plinth.castShadow = plinth.receiveShadow = true;
    this.scene.add(plinth);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(2.62, 0.022, 0.02), this.brass);
    trim.position.set(0, 0.29, 0.652);
    this.scene.add(trim);
    for (const sx of [-1.2, 1.2])
      for (const sz of [-0.5, 0.5]) {
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.06, 24), this.brass);
        foot.position.set(sx, 0.03, sz);
        foot.castShadow = true;
        this.scene.add(foot);
      }
    // pedestal under the lower grip
    const ped = new THREE.Mesh(new RoundedBoxGeometry(1.25, 0.16, 0.6, 2, 0.02), this.brassDark);
    ped.position.set(0, 0.34 + 0.08, 0);
    ped.castShadow = ped.receiveShadow = true;
    this.scene.add(ped);
  }

  private grip(): THREE.Group {
    const g = new THREE.Group();
    const jawGeo = new RoundedBoxGeometry(1.78, 0.3, 0.13, 2, 0.025);
    for (const z of [1, -1]) {
      const jaw = new THREE.Mesh(jawGeo, this.brass);
      jaw.position.set(0, 0, z * (T / 2 + 0.066));
      jaw.castShadow = jaw.receiveShadow = true;
      g.add(jaw);
    }
    // end blocks tying the jaws together
    for (const x of [-1, 1]) {
      const b = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.3, T + 0.27, 2, 0.02), this.brassDark);
      b.position.set(x * 0.95, 0, 0);
      b.castShadow = true;
      g.add(b);
    }
    // knurled clamp bolts
    const boltGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.07, 28);
    const capGeo = new THREE.CylinderGeometry(0.035, 0.04, 0.03, 6);
    for (const x of [-0.62, 0, 0.62]) {
      const bolt = new THREE.Mesh(boltGeo, this.knurl);
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(x, 0, T / 2 + 0.13 + 0.035);
      bolt.castShadow = true;
      g.add(bolt);
      const cap = new THREE.Mesh(capGeo, this.steel);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(x, 0, T / 2 + 0.13 + 0.08);
      g.add(cap);
    }
    return g;
  }

  private buildFrame(): void {
    const s = this.scene;
    const bottom = this.grip();
    bottom.position.set(0, 0.5 + 0.15, 0);
    s.add(bottom);
    this.topGrip.add(this.grip());
    const block = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.12, 0.34, 2, 0.02), this.brassDark);
    block.position.set(0, 0.21, 0);
    block.castShadow = true;
    this.topGrip.add(block);
    this.topGrip.position.set(0, PC.y + PH - 0.02, 0);
    s.add(this.topGrip);

    // columns and crossbar
    for (const x of [-1.16, 1.16]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 2.75, 32), this.steel);
      col.position.set(x, 0.34 + 1.375, -0.02);
      col.castShadow = true;
      s.add(col);
      for (const y of [0.37, 3.06]) {
        const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.07, 32), this.brass);
        collar.position.set(x, y, -0.02);
        s.add(collar);
      }
    }
    const bar = new THREE.Mesh(new RoundedBoxGeometry(2.62, 0.18, 0.28, 3, 0.03), this.brass);
    bar.position.set(0, 3.0, -0.02);
    bar.castShadow = true;
    s.add(bar);
    for (const x of [-1.16, 1.16]) {
      const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.06, 6), this.steel);
      nut.position.set(x, 3.12, -0.02);
      s.add(nut);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 6), this.brassDark);
    hub.position.set(0, 3.14, -0.02);
    s.add(hub);

    // the screw (thread texture slides as it turns)
    // thread: horizontal bands that slide along the screw as it turns
    const thc = document.createElement("canvas");
    thc.width = 16;
    thc.height = 256;
    const tx = thc.getContext("2d")!;
    for (let i = 0; i < 256; i++) {
      const v = 0.5 + 0.5 * Math.cos((i / 256) * 2 * Math.PI * 22);
      const g = Math.round(50 + 190 * v);
      tx.fillStyle = `rgb(${g},${g},${g})`;
      tx.fillRect(0, i, 16, 1);
    }
    this.screwTex = new THREE.CanvasTexture(thc);
    this.screwTex.wrapS = this.screwTex.wrapT = THREE.RepeatWrapping;
    const screwMat = new THREE.MeshStandardMaterial({ color: 0xb08a48, metalness: 1, roughness: 0.3, bumpMap: this.screwTex, bumpScale: 4 });
    this.screw = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 32, 1), screwMat);
    this.screw.castShadow = true;
    s.add(this.screw);

    // T handle
    const hubT = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.12, 32), this.brass);
    this.handle.add(hubT);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.95, 24), this.brass);
    rod.rotation.z = Math.PI / 2;
    this.handle.add(rod);
    for (const x of [-0.5, 0.5]) {
      const knob = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.12, 8, 16), this.knurl);
      knob.rotation.z = Math.PI / 2;
      knob.position.x = x;
      this.handle.add(knob);
    }
    this.handle.traverse((o) => (o.castShadow = true));
    s.add(this.handle);

    // dark polariser behind the plate: smoky glass in a brass ring
    const pol = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.09, 96),
      new THREE.MeshPhysicalMaterial({ color: 0x05070c, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.6 }),
    );
    pol.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.035, 16, 128), this.brass);
    pol.add(ring);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.04, 0.012, 8, 128), this.brassDark);
    ring2.position.z = 0.01;
    pol.add(ring2);
    pol.position.set(0, PC.y, -0.3);
    this.scene.add(pol);
  }

  private plateShape(hole: Hole): THREE.Shape {
    const sh = new THREE.Shape();
    const r = 0.03;
    sh.moveTo(-PW + r, -PH);
    sh.lineTo(PW - r, -PH);
    sh.quadraticCurveTo(PW, -PH, PW, -PH + r);
    sh.lineTo(PW, PH - r);
    sh.quadraticCurveTo(PW, PH, PW - r, PH);
    sh.lineTo(-PW + r, PH);
    sh.quadraticCurveTo(-PW, PH, -PW, PH - r);
    sh.lineTo(-PW, -PH + r);
    sh.quadraticCurveTo(-PW, -PH, -PW + r, -PH);
    const hp = new THREE.Path();
    const n = 160;
    for (let i = 0; i <= n; i++) {
      // denser near the ends of a slot
      const t = (i / n) * Math.PI * 2;
      const x = hole.ax * U * Math.cos(t), y = hole.by * U * Math.sin(t);
      if (i === 0) hp.moveTo(x, y);
      else hp.lineTo(x, y);
    }
    sh.holes.push(hp);
    return sh;
  }

  private buildPlate(): void {
    this.plateGroup.position.copy(PC);
    this.scene.add(this.plateGroup);
    this.plateBody = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshPhysicalMaterial({
        color: 0xcfeeff,
        roughness: 0.06,
        metalness: 0,
        transparent: true,
        opacity: 0.42,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        envMapIntensity: 1.4,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.plateBody.renderOrder = 2;
    this.plateGroup.add(this.plateBody);

    const lut = new THREE.DataTexture(fringeLut(), LUT_SIZE, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    lut.magFilter = lut.minFilter = THREE.LinearFilter;
    lut.needsUpdate = true;
    this.fringeMat = new THREE.ShaderMaterial({
      vertexShader: FRINGE_VERT,
      fragmentShader: FRINGE_FRAG,
      uniforms: {
        uField: { value: null },
        uLut: { value: lut },
        uScale: { value: 0 },
        uLutMax: { value: LUT_MAX_N },
        uLutSize: { value: LUT_SIZE },
        uIso: { value: 0 },
        uCells: { value: new THREE.Vector2(10.5, 14) },
        uHalf: { value: new THREE.Vector2(PW, PH) },
        uInInv: { value: IN_INV },
        uOutInv: { value: OUT_INV },
        uExposure: { value: EXPOSURE },
        uDim: { value: 1 },
      },
      fog: false,
    });
    this.fringe = new THREE.Mesh(new THREE.BufferGeometry(), this.fringeMat);
    this.fringe.position.z = T / 2 + 0.0085;
    this.plateGroup.add(this.fringe);
  }

  private rebuildPlate(hole: Hole): void {
    const shape = this.plateShape(hole);
    this.plateBody.geometry.dispose();
    const ex = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, curveSegments: 12 });
    ex.translate(0, 0, -T / 2);
    this.plateBody.geometry = ex;
    this.fringe.geometry.dispose();
    this.fringe.geometry = new THREE.ShapeGeometry(shape, 12);
  }

  private makeArrow(hex: string): ArrowParts {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: display(hex), fog: false });
    const out = new THREE.MeshBasicMaterial({ color: 0x050505, side: THREE.BackSide, fog: false });
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 16, 1).translate(0, 0.5, 0);
    const cone = new THREE.ConeGeometry(1, 1, 24, 1).translate(0, 0.5, 0);
    const shaft = new THREE.Mesh(cyl, mat);
    const head = new THREE.Mesh(cone, mat);
    const shaftO = new THREE.Mesh(cyl, out);
    const headO = new THREE.Mesh(cone, out);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(20), fog: false }));
    group.add(shaftO, headO, shaft, head, tip);
    for (const m of [shaft, head, shaftO, headO, tip]) m.renderOrder = 6;
    return { group, shaft, head, shaftO, headO, tip };
  }

  /** Point an arrow (plate-local, in the plate plane) from (x0,y0) along unit (dx,dy) for length L. */
  private setArrow(a: ArrowParts, x0: number, y0: number, dx: number, dy: number, L: number, r = 0.013): void {
    const on = L > 0.012;
    a.group.visible = on;
    if (!on) return;
    const hl = Math.min(0.1, L * 0.45), hr = r * 3.2;
    a.group.position.set(x0, y0, SURF + 0.035);
    a.group.rotation.set(0, 0, Math.atan2(dy, dx) - Math.PI / 2);
    a.shaft.scale.set(r, L - hl, r);
    a.shaftO.scale.set(r + 0.007, L - hl + 0.004, r + 0.007);
    a.shaftO.position.y = -0.002;
    a.head.position.y = L - hl;
    a.head.scale.set(hr, hl, hr);
    a.headO.position.y = L - hl - 0.006;
    a.headO.scale.set(hr + 0.008, hl + 0.014, hr + 0.008);
    a.tip.position.y = L;
    a.tip.scale.setScalar(0.011);
  }

  private buildProbe(): void {
    const s = 0.12;
    const glass = new THREE.Mesh(
      new RoundedBoxGeometry(s, s, s, 2, 0.008),
      new THREE.MeshPhysicalMaterial({ color: 0xe6fbff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.3, clearcoat: 1, envMapIntensity: 2.2, iridescence: 0.4, depthWrite: false }),
    );
    glass.renderOrder = 8;
    this.probe.add(glass);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(s, s, s)), new THREE.LineBasicMaterial({ color: new THREE.Color(0.8, 1.4, 1.8), transparent: true, opacity: 0.9, fog: false }));
    edges.renderOrder = 9;
    this.probe.add(edges);
    this.probeCore = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(11, 14, 16), fog: false }));
    this.probe.add(this.probeCore);
    const hc = document.createElement("canvas");
    hc.width = hc.height = 128;
    const hx = hc.getContext("2d")!;
    const g = hx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(160,235,255,0.32)");
    g.addColorStop(0.35, "rgba(120,220,255,0.1)");
    g.addColorStop(1, "rgba(120,220,255,0)");
    hx.fillStyle = g;
    hx.fillRect(0, 0, 128, 128);
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(hc), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.halo.scale.setScalar(0.34);
    this.halo.renderOrder = 7;
    this.probe.add(this.halo);
    this.probe.position.z = SURF + s / 2 - 0.004;
    this.plateGroup.add(this.probe);

    // the cut: a bright line on the plate and a sheet through the probe
    this.cutLineMat = new THREE.MeshBasicMaterial({ color: display(CYAN), fog: false });
    this.cutLine = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.016, 0.006), this.cutLineMat);
    this.cutLine.position.z = SURF + 0.006;
    this.cutLine.renderOrder = 5;
    const lineO = new THREE.Mesh(new THREE.BoxGeometry(0.468, 0.028, 0.004), new THREE.MeshBasicMaterial({ color: 0x050505, fog: false }));
    lineO.position.z = SURF + 0.003;
    this.cutPlaneMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(CYAN).multiplyScalar(0.9), transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, fog: false });
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.14), this.cutPlaneMat);
    sheet.rotation.x = Math.PI / 2;
    sheet.position.z = SURF + 0.07;
    sheet.renderOrder = 9;
    this.cut.add(lineO, this.cutLine, sheet);
    this.plateGroup.add(this.cut);

    this.pull = this.makeArrow(AMBER);
    this.slide = this.makeArrow(CYAN);
    this.plateGroup.add(this.pull.group, this.slide.group);

    // principal crosshair ("no slide here")
    const cm = new THREE.MeshBasicMaterial({ color: display("#ffffff", 0.92), fog: false });
    const co = new THREE.MeshBasicMaterial({ color: 0x050505, fog: false });
    for (const r of [0, Math.PI / 2]) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.006, 0.003), cm);
      l.rotation.z = r;
      l.position.z = SURF + 0.004;
      const o = new THREE.Mesh(new THREE.BoxGeometry(0.404, 0.014, 0.002), co);
      o.rotation.z = r;
      o.position.z = SURF + 0.002;
      this.cross.add(o, l);
    }
    this.cross.visible = false;
    this.plateGroup.add(this.cross);
  }

  private letterSprite(key: string): THREE.CanvasTexture {
    if (!this.letterTex[key]) {
      const t = new THREE.CanvasTexture(letter(key, "#ffe9b8"));
      t.colorSpace = THREE.SRGBColorSpace;
      this.letterTex[key] = t;
    }
    return this.letterTex[key];
  }

  private buildGnomon(): void {
    const g = this.gnomon;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.02, 32), this.brass);
    base.rotation.x = Math.PI / 2;
    g.add(base);
    const mk = (ang: number) => {
      const arm = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.24, 12).translate(0, 0.12, 0), this.brass);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.07, 16).translate(0, 0.275, 0), this.brass);
      arm.add(shaft, head);
      arm.rotation.z = ang;
      return arm;
    };
    g.add(mk(-Math.PI / 2), mk(0));
    for (let i = 0; i < 2; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.letterSprite("x"), transparent: true, depthWrite: false, fog: false }));
      sp.scale.setScalar(0.2);
      sp.renderOrder = 10;
      this.gnomonLetters.push(sp);
      this.plateGroup.add(sp);
    }
    g.position.set(-2.55 * U, -2.95 * U, SURF + 0.03);
    g.traverse((o) => (o.castShadow = true));
    this.plateGroup.add(g);
  }

  private buildCard(): void {
    const g = this.cardGroup;
    this.cardTex = new THREE.CanvasTexture(this.cardCanvas);
    this.cardTex.colorSpace = THREE.SRGBColorSpace;
    this.cardTex.anisotropy = 8;
    const cw = 1.0, ch = cw * (CARD.H / CARD.W);
    const body = new THREE.Mesh(new RoundedBoxGeometry(cw * 0.985, ch * 0.985, 0.035, 3, 0.03), new THREE.MeshStandardMaterial({ color: 0xd9ceb4, roughness: 0.8 }));
    body.position.set(0, 0.2 + ch / 2, 0);
    body.castShadow = true;
    g.add(body);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(cw, ch), new THREE.MeshStandardMaterial({ map: this.cardTex, roughness: 0.9, metalness: 0, transparent: true, envMapIntensity: 0.25 }));
    face.position.set(0, 0.2 + ch / 2, 0.019);
    g.add(face);
    // brass stand
    const foot = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.06, 0.36, 2, 0.02), this.brass);
    foot.position.set(0, 0.03, 0);
    foot.castShadow = foot.receiveShadow = true;
    g.add(foot);
    for (const x of [-0.32, 0.32]) {
      const post = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.22, 0.1, 2, 0.015), this.brass);
      post.position.set(x, 0.15, 0);
      post.castShadow = true;
      g.add(post);
    }
    const lip = new THREE.Mesh(new RoundedBoxGeometry(0.86, 0.05, 0.06, 2, 0.015), this.brassDark);
    lip.position.set(0, 0.23, 0.04);
    g.add(lip);
    this.scene.add(g);
  }

  private buildDial(): void {
    const g = this.dialGroup;
    this.dialTex = new THREE.CanvasTexture(this.dialCanvas);
    this.dialTex.colorSpace = THREE.SRGBColorSpace;
    this.dialTex.anisotropy = 8;
    const R = 0.33;
    const head = new THREE.Group();
    head.position.set(0, 0.62, 0);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(R + 0.02, 0.035, 20, 96), this.brass);
    bezel.castShadow = true;
    head.add(bezel);
    const back = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.03, R + 0.03, 0.1, 64), this.brassDark);
    back.rotation.x = Math.PI / 2;
    back.position.z = -0.05;
    back.castShadow = true;
    head.add(back);
    const face = new THREE.Mesh(new THREE.CircleGeometry(R, 96), new THREE.MeshStandardMaterial({ map: this.dialTex, roughness: 0.85, envMapIntensity: 0.25 }));
    face.position.z = 0.002;
    head.add(face);
    // needle (pivot at the centre)
    const nm = new THREE.MeshStandardMaterial({ color: 0xb3201a, roughness: 0.45, metalness: 0.2 });
    const n1 = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.27, 0.006).translate(0, 0.11, 0), nm);
    const n2 = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.05, 12).translate(0, 0.27, 0), nm);
    this.needle.add(n1, n2);
    this.needle.position.z = 0.02;
    head.add(this.needle);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 24), this.brass);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.03;
    head.add(cap);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(R + 0.01, 64), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, roughness: 0.02, clearcoat: 1, envMapIntensity: 1.2, depthWrite: false }));
    glass.position.z = 0.045;
    head.add(glass);
    g.add(head);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.3, 24), this.brassSatin);
    post.position.set(0, 0.16, -0.05);
    post.castShadow = true;
    g.add(post);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.23, 0.05, 48), this.brassSatin);
    foot.position.set(0, 0.025, -0.05);
    foot.castShadow = foot.receiveShadow = true;
    g.add(foot);
    this.scene.add(g);
  }

  private buildShelf(): void {
    const g = this.shelf;
    const board = new THREE.Mesh(new RoundedBoxGeometry(2.5, 0.05, 0.36, 2, 0.015), new THREE.MeshStandardMaterial({ color: 0x5a3622, roughness: 0.5 }));
    board.position.y = 0.06;
    board.castShadow = board.receiveShadow = true;
    g.add(board);
    for (const x of [-1.1, 1.1]) {
      const leg = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.04, 0.3, 2, 0.01), this.brass);
      leg.position.set(x, 0.02, 0);
      g.add(leg);
    }
    const glass = (hex: number) => new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.08, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.85, envMapIntensity: 1.6 });
    // 1 number
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.07, 32, 16), glass(0xbfe9ff));
    bead.position.set(-0.9, 0.16, 0);
    g.add(bead);
    // 3 numbers
    const arrow = new THREE.Group();
    const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.26, 12).translate(0, 0.13, 0), this.brass);
    const hd = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.08, 16).translate(0, 0.3, 0), this.brass);
    arrow.add(sh, hd);
    arrow.rotation.z = -0.7;
    arrow.position.set(-0.42, 0.09, 0);
    g.add(arrow);
    // 9 numbers: a mini card
    const mini = new THREE.Group();
    const mc = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.28, 0.02, 2, 0.01), new THREE.MeshStandardMaterial({ color: 0xece2cb, roughness: 0.85 }));
    mini.add(mc);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const d = new THREE.Mesh(new THREE.CircleGeometry(0.018, 16), new THREE.MeshStandardMaterial({ color: 0x2a1f14, roughness: 0.9 }));
        d.position.set((j - 1) * 0.065, (1 - i) * 0.075, 0.011);
        mini.add(d);
      }
    mini.position.set(0.18, 0.24, 0);
    mini.rotation.x = -0.12;
    g.add(mini);
    // 27 numbers: a 3×3×3 cube of beads, coloured like a tiny RGB image patch
    const cube = new THREE.Group();
    const cols = [0xff5a5a, 0x5aff8a, 0x5aa8ff];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++) {
          const b = new THREE.Mesh(new THREE.SphereGeometry(0.026, 16, 10), glass(cols[k]));
          b.position.set((i - 1) * 0.075, (j - 1) * 0.075, (k - 1) * 0.075);
          cube.add(b);
        }
    cube.position.set(0.85, 0.17, 0);
    cube.rotation.y = 0.5;
    g.add(cube);
    g.userData.items = [bead, arrow, mini, cube];
    g.visible = false;
    this.scene.add(g);
  }

  private arrange(a: Arrangement): void {
    this.arr = a;
    this.cardGroup.position.set(...a.card);
    this.cardGroup.rotation.set(a.cardRot[1], a.cardRot[0], 0, "YXZ");
    this.cardGroup.scale.setScalar(a.cardScale);
    this.dialGroup.position.set(...a.dial);
    this.dialGroup.rotation.set(0, a.dialRot, 0);
    this.dialGroup.scale.setScalar(a.dialScale);
    this.shelf.position.set(...a.shelf);
  }

  // ───────────────────────── view API ─────────────────────────

  resize(w: number, h: number, layout: Layout): void {
    const first = this.w === 1;
    this.w = w;
    this.h = h;
    const wasCompact = !!this.layout.compact;
    this.layout = layout;
    const want = layout.phone ? PHONE : DESK;
    const changed = want !== this.arr || !!layout.compact !== wasCompact;
    if (want !== this.arr) this.arrange(want);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const k = this.mobile ? 0.4 : 0.5;
    this.bloom.resolution.set(Math.max(64, w * k), Math.max(64, h * k));
    this.fit(first || changed);
  }

  /** Fit the hero box into the layout rectangle: distance from the visible height, centre via a view offset. */
  private fit(resetAngles: boolean): void {
    const a = this.arr, L = this.layout, cam = this.camera;
    const { w, h } = this;
    cam.aspect = w / h;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    let heroW = a.heroW, heroH = a.heroH;
    const target = new THREE.Vector3(...a.focus);
    if (L.compact) {
      // phones: the plate and its fringes are the point, so fit the plate (plus a little of the grips) into the free area
      this.plateGroup.updateWorldMatrix(true, false);
      const pw = this.local(-PW, 0).distanceTo(this.local(PW, 0));
      const ph = this.local(0, -PH).distanceTo(this.local(0, PH));
      heroW = pw * 1.1;
      heroH = ph * 1.16;
      target.copy(this.local(0, PH * 0.06, 0));
    }
    const visH = Math.max((heroH * h) / Math.max(80, L.h), (heroW * h) / Math.max(80, L.w));
    const dist = visH / (2 * tan);
    const c = this.controls;
    const ratio = this.fitDist > 0 && !resetAngles ? cam.position.distanceTo(c.target) / this.fitDist : 1;
    this.fitDist = dist;
    c.minDistance = dist * 0.72;
    c.maxDistance = dist * 1.25;
    c.minAzimuthAngle = a.yaw - 0.61;
    c.maxAzimuthAngle = a.yaw + 0.61;
    c.minPolarAngle = Math.PI / 2 - Math.min(0.62, a.pitch + 0.26);
    c.maxPolarAngle = Math.PI / 2 - Math.max(0.02, a.pitch - 0.26);
    let yaw = a.yaw, pitch = a.pitch;
    if (!resetAngles) {
      const off = cam.position.clone().sub(c.target);
      const sp = new THREE.Spherical().setFromVector3(off);
      yaw = sp.theta;
      pitch = Math.PI / 2 - sp.phi;
    }
    c.target.copy(target);
    const d = dist * Math.max(0.72, Math.min(1.25, ratio));
    cam.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * d, target.y + Math.sin(pitch) * d, target.z + Math.cos(yaw) * Math.cos(pitch) * d);
    cam.setViewOffset(w, h, w / 2 - (L.x + L.w / 2), h / 2 - (L.y + L.h / 2), w, h);
    cam.updateProjectionMatrix();
    c.update();
  }

  resetCamera(): void {
    this.fit(true);
    this.idle = 99;
  }

  poke(): void {
    this.idle = 0;
  }

  anchors(): Anchors {
    return this.anch;
  }

  platePoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    this.plateGroup.updateWorldMatrix(true, false);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(this.plateGroup.matrixWorld);
    const p0 = new THREE.Vector3(0, 0, SURF).applyMatrix4(this.plateGroup.matrixWorld);
    const hit = this.ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0), new THREE.Vector3());
    if (!hit) return null;
    this.plateGroup.worldToLocal(hit);
    return { x: hit.x / U, y: hit.y / U };
  }

  probeScreen(): { x: number; y: number; r: number } {
    const p = this.screen(this.probe.getWorldPosition(this.v));
    const q = this.screen(this.v.add(new THREE.Vector3(0.06, 0, 0)));
    return { x: p.x, y: p.y, r: Math.max(16, Math.hypot(q.x - p.x, q.y - p.y) * 1.3) };
  }

  private screen(wp: THREE.Vector3): { x: number; y: number; on: boolean } {
    const p = wp.clone().project(this.camera);
    return { x: ((p.x + 1) / 2) * this.w, y: ((1 - p.y) / 2) * this.h, on: p.z < 1 };
  }

  private local(x: number, y: number, z = SURF): THREE.Vector3 {
    return this.plateGroup.localToWorld(new THREE.Vector3(x, y, z));
  }

  // ───────────────────────── per frame ─────────────────────────

  private updateField(model: Model): void {
    if (model.fieldVersion !== this.fieldVersion) {
      this.fieldVersion = model.fieldVersion;
      this.rebuildPlate(model.hole);
    }
    if (model.gridVersion === this.gridVersion) return;
    this.gridVersion = model.gridVersion;
    const g = model.grid;
    const half = new Uint16Array(g.data.length);
    for (let i = 0; i < g.data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(g.data[i]);
    const tex = new THREE.DataTexture(half, g.w, g.h, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.fieldTex?.dispose();
    this.fieldTex = tex;
    this.fringeMat.uniforms.uField.value = tex;
  }

  render(dt: number, model: Model): void {
    if (this.disposed) return;
    this.time += dt;
    this.idle += dt;
    const s = model.s;
    this.updateField(model);

    // the press: screw turns and the top grip rises with the load (exaggerated)
    const lift = s.load * 0.009;
    this.topGrip.position.y = PC.y + PH - 0.02 + lift;
    this.plateGroup.scale.y = 1 + s.load * 0.002;
    this.plateGroup.position.y = PC.y + PH * s.load * 0.002;
    const topY = this.topGrip.position.y + 0.27;
    this.screw.position.set(0, (topY + 3.42) / 2, 0);
    this.screw.scale.y = 3.42 - topY;
    const turn = s.load * 1.6;
    this.handle.position.set(0, 3.44, 0);
    this.handle.rotation.y = turn;
    this.screwTex.offset.y = (-turn / (2 * Math.PI)) * 0.6;

    // fringes
    const u = this.fringeMat.uniforms;
    u.uScale.value = model.fringeScale;
    u.uIso.value += ((s.showIso ? 1 : 0) - u.uIso.value) * Math.min(1, dt * 6);

    // probe, cut, arrows
    const px = s.probe.x * U, py = s.probe.y * U;
    this.probe.position.x = px;
    this.probe.position.y = py;
    this.probeCore.scale.setScalar(1 + 0.12 * Math.sin(this.time * 3));
    this.halo.material.opacity = 0.75 + 0.25 * Math.sin(this.time * 2.2);
    const phi = (s.cut * Math.PI) / 180;
    this.cut.position.set(px, py, 0);
    this.cut.rotation.z = phi;
    const gold = Math.max(model.flash, model.principalNow ? 0.55 : 0);
    this.cutLineMat.color.copy(display(CYAN)).lerp(display(GOLD, 1.05), gold);
    this.cutPlaneMat.color.set(CYAN).lerp(new THREE.Color(GOLD), gold).multiplyScalar(0.9 + model.flash * 1.5);
    this.cutPlaneMat.opacity = 0.26 + model.flash * 0.3;

    const tr = model.trac;
    const k = 0.046; // world units per MPa
    const cap = 0.95;
    const nL = Math.min(cap, Math.abs(tr.normal) * k);
    const sL = Math.min(cap, Math.abs(tr.shear) * k);
    const [nx, ny] = tr.n, [sx, sy] = tr.s;
    if (tr.normal >= 0) this.setArrow(this.pull, px, py, nx, ny, nL);
    else this.setArrow(this.pull, px + nx * nL, py + ny * nL, -nx, -ny, nL); // a push points into the cut
    const sg = tr.shear >= 0 ? 1 : -1;
    this.setArrow(this.slide, px, py, sx * sg, sy * sg, sL);

    // principal crosshair
    this.cross.visible = s.showIso;
    this.cross.position.set(px, py, 0);
    this.cross.rotation.z = (model.prin.angleDeg * Math.PI) / 180;

    // gnomon (the measuring axes)
    const al = (s.axes * Math.PI) / 180;
    this.gnomon.rotation.z = al;
    const primed = s.axes > 0.05 && s.axes < 179.95;
    if (primed !== this.primedShown) {
      this.primedShown = primed;
      this.gnomonLetters[0].material.map = this.letterSprite(primed ? "x′" : "x");
      this.gnomonLetters[1].material.map = this.letterSprite(primed ? "y′" : "y");
      for (const l of this.gnomonLetters) l.material.needsUpdate = true;
    }
    const gp = this.gnomon.position;
    this.gnomonLetters[0].position.set(gp.x + Math.cos(al) * 0.37, gp.y + Math.sin(al) * 0.37, gp.z + 0.02);
    this.gnomonLetters[1].position.set(gp.x - Math.sin(al) * 0.37, gp.y + Math.cos(al) * 0.37, gp.z + 0.02);

    // the card (redraw only when what it shows changes)
    const m = model.sigmaRot;
    const note = Math.round(model.axesNote * 20);
    const key = `${m.xx.toFixed(2)}|${m.yy.toFixed(2)}|${m.xy.toFixed(2)}|${Math.round(s.axes)}|${note}`;
    if (key !== this.cardKey) {
      this.cardKey = key;
      drawCard(this.cardCtx, {
        m: [
          [m.xx, m.xy, 0],
          [m.xy, m.yy, 0],
          [0, 0, 0],
        ],
        primed,
        axesDeg: s.axes,
        note: model.axesNote,
      });
      this.cardTex.needsUpdate = true;
    }
    // the dial
    const max = dialMax(model.K);
    const dk = `${max}|${model.K.toFixed(2)}`;
    if (dk !== this.dialKey) {
      this.dialKey = dk;
      drawDial(this.dialCanvas.getContext("2d")!, max, model.K);
      this.dialTex.needsUpdate = true;
    }
    const target = -dialAngle(model.here, max);
    this.needleAng += (target - this.needleAng) * Math.min(1, dt * 7);
    this.needle.rotation.z = this.needleAng;

    // ranks shelf
    this.shelfK += ((s.showRanks ? 1 : 0) - this.shelfK) * Math.min(1, dt * 5);
    this.shelf.visible = this.shelfK > 0.02;
    this.shelf.scale.setScalar(0.6 + 0.4 * this.shelfK);
    if (this.shelf.visible) (this.shelf.userData.items[3] as THREE.Object3D).rotation.y = 0.5 + this.time * 0.3;

    this.updateCamera(dt, model);
    this.composer.render(dt);
    this.updateAnchors(model);
  }

  private updateCamera(dt: number, model: Model): void {
    const c = this.controls;
    if (this.idle > 4 && !model.wowActive) {
      // slow idle drift around the default view
      const a = this.arr;
      const off = this.camera.position.clone().sub(c.target);
      const sp = new THREE.Spherical().setFromVector3(off);
      const tYaw = a.yaw + Math.sin(this.time * 0.17) * 0.14;
      const tPitch = Math.PI / 2 - (a.pitch + Math.sin(this.time * 0.11) * 0.04);
      const k = 1 - Math.exp(-dt * 0.35);
      sp.theta += (tYaw - sp.theta) * k;
      sp.phi += (tPitch - sp.phi) * k;
      this.camera.position.copy(c.target).add(new THREE.Vector3().setFromSpherical(sp));
    }
    c.update();
  }

  private updateAnchors(model: Model): void {
    const s = model.s;
    const A: Anchors = {};
    const put = (id: string, wp: THREE.Vector3, on = true) => {
      const p = this.screen(wp);
      A[id] = { x: p.x, y: p.y, on: on && p.on };
    };
    put("plate", this.local(-2.7 * U, 2.6 * U));
    // plate corners (for the phone layout check) and a box round the hole's fringes (labels keep out)
    put("pc0", this.local(-PW, -PH));
    put("pc1", this.local(PW, -PH));
    put("pc2", this.local(PW, PH));
    put("pc3", this.local(-PW, PH));
    put("holeA", this.local(-(model.hole.ax + 1.4) * U, (model.hole.by + 1.4) * U));
    put("holeB", this.local((model.hole.ax + 1.4) * U, -(model.hole.by + 1.4) * U));
    // a point in the crowded bands beside the hole, on the side away from the probe
    const side = s.probe.x >= 0 ? -1 : 1;
    const hx = model.hole.ax;
    put("bands", this.local(side * (hx + 1.25) * U, 1.15 * U));
    put("probe", this.probe.getWorldPosition(new THREE.Vector3()));
    const phi = (s.cut * Math.PI) / 180;
    const px = s.probe.x * U, py = s.probe.y * U;
    // the cut label sits on the end of the line that the slide arrow isn't using
    const sg = model.trac.shear >= 0 ? -1 : 1;
    put("cut", this.local(px + Math.cos(phi) * 0.23 * sg, py + Math.sin(phi) * 0.23 * sg));
    if (this.pull.group.visible) {
      const tip = model.trac.normal >= 0 ? this.pull.tip.getWorldPosition(new THREE.Vector3()) : this.pull.group.getWorldPosition(new THREE.Vector3());
      put("pull", tip);
    } else put("pull", this.local(px, py), true);
    if (this.slide.group.visible) put("slide", this.slide.tip.getWorldPosition(new THREE.Vector3()));
    else put("slide", this.local(px, py), true);
    put("axes", this.gnomon.getWorldPosition(new THREE.Vector3()));
    const cw = 1.0, ch = cw * (CARD.H / CARD.W);
    put("card", this.cardGroup.localToWorld(new THREE.Vector3(0, 0.2 + ch, 0.02)));
    put("dial", this.dialGroup.localToWorld(new THREE.Vector3(0, this.layout.phone ? 0.62 + 0.38 : 0.05, this.layout.phone ? 0 : 0.2)));
    if (s.showIso) put("principal", this.local(px + Math.cos((model.prin.angleDeg * Math.PI) / 180) * 0.2, py + Math.sin((model.prin.angleDeg * Math.PI) / 180) * 0.2));
    if (this.shelf.visible && s.showRanks) {
      const items = this.shelf.userData.items as THREE.Object3D[];
      const ids = ["rank0", "rank1", "rank2", "rank3"];
      items.forEach((o, i) => put(ids[i], o.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, -0.1, 0.1))));
    }
    this.anch = A;
  }

  dispose(): void {
    this.disposed = true;
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
