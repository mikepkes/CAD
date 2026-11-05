import * as THREE from "three";
import { sampleSpline, splineCurvatureComb } from "../core/geometry/spline";
import { SpaceMouseState, SpaceMouseSettings, NavigationDelta, IDLE, DEFAULT_SETTINGS, navigationDelta, isIdle } from "./spaceMouse";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { PaperOverlay } from "../core/sheetSequence";
import { studioEnvironmentScene } from "./studioEnvironment";
import { PLANES, WorkPlane, to3d } from "../geometry/plane";
import { DimensionConstraint, Sketch, SketchArc, SketchCircle, SketchEllipse, SketchLine, SketchPoint } from "../sketch/types";
import { isDimension } from "../sketch/types";
import { extractProfiles, Loop } from "../core/geometry/profile";
import { HandleManager } from "./handles";
import { makeThreadNormalMap } from "./threadTexture";
import type { Rigid } from "../math/transform";

/** Rigid transform → THREE.Matrix4 (basis columns + origin). */
function rigidMat(R: Rigid): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    R.x.x, R.y.x, R.z.x, R.origin.x,
    R.x.y, R.y.y, R.z.y, R.origin.y,
    R.x.z, R.y.z, R.z.z, R.origin.z,
    0, 0, 0, 1,
  );
}
import { createMaterial, MaterialSpec, WoodFrame, wrapsTexture, wrapCoords } from "./material";
import { Fades, fadeMaterial } from "./fade";

/** Wrapped-texture coordinates per body mesh (see wrapCoords), computed once per mesh. */
const WRAP = new WeakMap<Float32Array, Float32Array>();
function addWrapCoords(geo: THREE.BufferGeometry, positions: Float32Array, normals: Float32Array, material: MaterialSpec | undefined) {
  if (!wrapsTexture(material)) return;
  let w = WRAP.get(positions);
  if (!w) { w = wrapCoords(positions, normals); WRAP.set(positions, w); }
  geo.setAttribute("aWrap", new THREE.BufferAttribute(w, 4));
}
import type { ThreadDecal } from "../core/document";
import type { SweepGuide } from "../core/sweepGuides";
import type { Vec3 } from "../math/vec";
import { fitDistance, fitTangent, orbitDirection } from "./orbitCamera";
import { prefersReducedMotion } from "./motion";
import { LensPass, type LensSpec } from "./lensPass";
import { onViewportTheme, viewportColors } from "./palette";
import { WORLD_VERT, curvatureColors, draftFrag, zebraFrag } from "./analysisShaders";
import { mouldFlags } from "./mouldability";
import { HATCH_ANGLES } from "../core/drawingAnnotations"; // the shop drawing's section hatching, part by part

/** Options for an offscreen still (render_view). A free camera — `azimuthDeg` /
 *  `elevationDeg`, see orbitDirection — overrides the named `view`. */
export interface RenderViewOpts {
  view?: string; width?: number; height?: number; hideSketches?: boolean;
  azimuthDeg?: number; elevationDeg?: number;
  /** Vertical field of view (default 45°; narrow it to mimic a zoomed photo). */
  fovDeg?: number;
  /** Rotation about the view axis, e.g. to match a hand-held reference shot. */
  rollDeg?: number;
  /** Also hide the grid and axes (a product shot rather than a modelling view). */
  clean?: boolean;
}

export interface PreviewGeom {
  segments?: { u1: number; v1: number; u2: number; v2: number }[];
  circles?: { cu: number; cv: number; r: number }[];
  arcs?: { cu: number; cv: number; r: number; a1: number; a2: number; ccw: boolean }[];
  ellipses?: { cu: number; cv: number; rx: number; ry: number; rotation: number }[];
  snap?: { u: number; v: number; kind: string } | null;
  cursor?: { u: number; v: number } | null;
  /** Inference glyphs (H/V, ∥, ⊥, on-line, …) shown beside the cursor. */
  markers?: string[];
}

type P3 = { x: number; y: number; z: number };

export interface SolidView {
  /** Stable body id (feature id), for caching per-body materials. */
  id?: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edges: Float32Array;
  /** Cosmetic thread regions drawn as a shaded normal-mapped sleeve. */
  threadDecals?: ThreadDecal[];
  /** Assigned appearance (resolved from the owning component). */
  material?: MaterialSpec;
  /** Per-body wood grain frame (grain axis + pith), for the procedural shader. */
  woodFrame?: WoodFrame;
  /** Per vertex, its point on the flat sheet (mm): paper folded in steps, so the paper's texture stays put as it folds. */
  uvs?: Float32Array;
  /** Paper folded in steps: its raw edges and contact shadows (core/sheetSequence.ts sequencePaper). */
  paper?: PaperOverlay;
  /** A hidden body drawn as a faint, unpickable ghost ("show hidden" mode). */
  ghost?: boolean;
  /** A ghost that is another design (a compared Design Space pin): the kit's ghost accent, dashed edges. Implies `ghost`. */
  variant?: boolean;
  /** A reference part's body drawn see-through (Component.reference "ghost"): a stand-in for what the design holds,
   *  in its own colour but translucent and not writing depth, so the parts behind it stay in view. Picked only where
   *  no real part lies behind it; the lens passes it by. */
  reference?: boolean;
  /** Principal curvatures (k1, k2) per vertex, for the curvature map. */
  curvature?: Float32Array;
  /** Curvature-comb line segments along the body's curved edges (flat xyz pairs). */
  combs?: Float32Array;
}

/** Surface-quality display: zebra stripes, a draft check against a pull
 *  direction, or a curvature colour map — plus curvature combs. */
export interface AnalysisView {
  mode: "none" | "zebra" | "draft" | "curvature";
  stripes: number;
  draftDeg: number;
  pull: { x: number; y: number; z: number };
  quantity: "mean" | "gaussian" | "max" | "min";
  combs: boolean;
}

export interface ViewData {
  mode: "model" | "sketch";
  planeId: string | null;
  /** Resolved work plane of the active sketch (origin, offset, or face). */
  plane: WorkPlane | null;
  sketch: Sketch | null;
  selection: Set<string>;
  hover: string | null;
  preview: PreviewGeom | null;
  showPlanes: boolean;
  showGrid: boolean;
  /** The origin axes (default shown). */
  showAxes?: boolean;
  gridSize?: number;
  showConstraints: boolean;
  /** Overall constrained state of the active sketch, for Fusion-style coloring. */
  constraintState: "under" | "full" | "conflict";
  solids?: SolidView[];
  /** Datum/reference planes to show in the scene (resolved frames), pickable for Create Sketch. */
  datumPlanes?: { id: string; name: string; plane: WorkPlane }[];
  /** Other sketches to show dimmed on their planes (every sketch but the active one). */
  ghostSketches?: { sketch: Sketch; plane: WorkPlane }[];
  /** 3D sweeps' construction (core/sweepGuides): the spine and the sections on it, drawn with their shown path sketch. */
  sweepGuides?: SweepGuide[];
  /** Pickable region fills for the active extrude session (click to choose a region). */
  extrudeRegions?: { plane: WorkPlane; regions: { interior: { x: number; y: number }; outer: { x: number; y: number }[]; holes: { x: number; y: number }[][]; selected: boolean }[] };
  /** Live translucent preview of the pending extrude. */
  extrudePreview?: { plane: WorkPlane; regions: { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][] }[]; distance: number; symmetric: boolean; operation: "new" | "join" | "cut" | "intersect" };
  /** Active section (cross-section) cut: clips the solids on a base plane at an offset. */
  section?: { plane: "XY" | "XZ" | "YZ"; offset: number; flip: boolean } | null;
  /** Surface-quality display (zebra / draft / curvature, combs). */
  analysis?: AnalysisView;
}

export interface PickResult {
  type: "plane" | "entity" | "face" | "region" | "empty";
  id?: string;
  entityKind?: string;
  world?: THREE.Vector3;
  /** World-space normal of a picked solid face. */
  normal?: { x: number; y: number; z: number };
  /** Interior (u,v) of a picked extrude region. */
  interior?: { x: number; y: number };
  /** The picked solid triangle (its first index in the body mesh's `indices`), to name the face it lies on. */
  tri?: number;
}

/** The active theme's viewport colours (palette.ts): read at build time, so a
 *  theme switch takes effect on the next build (applyTheme rebuilds at once). */
const COLORS = viewportColors;

// Distinct per-object colors used in section view, so each body (and its cut
// cap) reads as its own part. Picked to stay legible on the dark background.
const BODY_PALETTE = [
  0x6f8cff, 0x4fc3a1, 0xe0863e, 0xd4607a, 0xb074e0, 0xd9b84a, 0x4aa6d9, 0x8fbf5a,
];
const bodyColor = (i: number) => BODY_PALETTE[((i % BODY_PALETTE.length) + BODY_PALETTE.length) % BODY_PALETTE.length];
/** A slightly lighter tint of a body's colour for its section cap. */
function tint(hex: number, f = 0.4): number {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const m = (c: number) => Math.round(c + (255 - c) * f);
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

/** A THREE clip plane for a section cut. Keeps the half below the offset along
 *  the base-plane normal (Z for XY, Y for XZ, X for YZ); `flip` keeps the other. */
function sectionPlane(sec: { plane: "XY" | "XZ" | "YZ"; offset: number; flip: boolean }): THREE.Plane {
  const n = sec.plane === "XY" ? new THREE.Vector3(0, 0, -1)
    : sec.plane === "XZ" ? new THREE.Vector3(0, -1, 0)
    : new THREE.Vector3(-1, 0, 0);
  let constant = sec.offset;
  if (sec.flip) { n.negate(); constant = -constant; }
  return new THREE.Plane(n, constant);
}

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  /** Active camera: perspective in model mode, orthographic in a sketch. */
  camera: THREE.Camera;
  private perspCam: THREE.PerspectiveCamera;
  private orthoCam: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  private clock = new THREE.Clock();
  /** Held 3D-mouse deflection, applied every frame (see spaceMouse.ts). */
  private navInput: SpaceMouseState = IDLE;
  navSettings: SpaceMouseSettings = DEFAULT_SETTINGS;
  /** Active camera animation (reorient / dolly between two framings). */
  private tween: {
    t: number; dur: number;
    from: { off: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number };
    to: { off: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number };
    onDone?: () => void;
  } | null = null;

  private planeMeshes = new Map<string, THREE.Mesh>();
  private datumMeshes = new Map<string, THREE.Mesh>();
  private datumGroup = new THREE.Group();
  private ghostGroup = new THREE.Group();
  /** The motion study's ghosts (setMotionGhosts): the moving parts sweeping round, see-through. */
  private motionGroup = new THREE.Group();
  /** Their geometry, one per body, shared by every pose and kept while a study runs. */
  private motionGeo = new Map<string, { src: Float32Array; geo: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
  /** Their meshes, by trail slot and body, kept and moved frame to frame (redrawn every frame while a study runs). */
  private motionPool = new Map<string, { mesh: THREE.Mesh; lines: THREE.LineSegments }>();
  private regionGroup = new THREE.Group();
  private previewSolidGroup = new THREE.Group();
  private planeGroup = new THREE.Group();
  private grid: THREE.GridHelper;
  private gridSize = 10;
  private axes = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private solidsGroup = new THREE.Group();
  // ---- transform-driven animation (turntable / mechanism export): bodies are
  // grouped per component and MOVED by a matrix each frame, instead of rebuilding
  // geometry. Only joint transforms change, so this needs no OCC rebuild. ----
  private recording = false;
  private animating = false;
  private animGroups = new Map<string, THREE.Group>();         // componentId -> group of its bodies
  private animBuildInv = new Map<string, THREE.Matrix4>();     // inverse of each component's build-pose world
  private animWood: { mat: THREE.Material; axis: THREE.Vector3; pith: THREE.Vector3; cid: string }[] = [];
  private animDeltas = new Map<string, THREE.Matrix4>();       // componentId -> current pose delta (Wpose · inv(Wbuild))
  /** Display-only fades (fadeBodies): bodies and sketches drawn see-through or not at all, eased, without a rebuild. */
  private fades = new Fades();
  private fading = false;
  /** See-through materials compiled ahead of a fade (warmFades), kept so their shader programs stay compiled; by the
   *  uuids of the materials they copy. */
  private fadeWarm = { of: new Set<string>(), mats: [] as THREE.Material[] };
  private raycaster = new THREE.Raycaster();
  private rayHelper = new THREE.Raycaster();
  readonly handles = new HandleManager(this);
  private disposed = false;
  private resizeObs?: ResizeObserver;
  private lastPixelScale = 0;
  private container: HTMLElement;
  private lastData: ViewData | null = null;
  /** Active section cut plane (null when sectioning is off). Applied to solids. */
  private clipPlane: THREE.Plane | null = null;
  /** Procedural thread normal maps, cached by their parameters (they are costly
   *  to build and re-used across re-renders). */
  private threadTexCache = new Map<string, THREE.DataTexture>();
  /** The Lens (concept UI): a masked analysis pass drawn after each frame. All
   *  of its logic lives in lensPass.ts; this only holds the spec. */
  private lensPass = new LensPass();
  /** Unsubscribes from theme changes (palette.ts). */
  private offTheme: () => void = () => {};

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true });
    this.renderer.localClippingEnabled = true; // per-material section clipping
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; // filmic highlight roll-off for PBR
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = "none";
    // Trackpad-aware navigation: two-finger scroll pans, pinch zooms (handled
    // in capture phase so we can suppress OrbitControls' wheel-dolly for pans).
    this.renderer.domElement.addEventListener("wheel", this.onWheel, { passive: false, capture: true });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS().bg);
    this.offTheme = onViewportTheme(() => this.applyTheme());

    const aspect = container.clientWidth / container.clientHeight;
    this.perspCam = new THREE.PerspectiveCamera(45, aspect, 0.1, 100000);
    this.perspCam.up.set(0, 0, 1); // Z up
    this.perspCam.position.set(140, -180, 140);
    this.orthoCam = new THREE.OrthographicCamera(-100 * aspect, 100 * aspect, 100, -100, -100000, 100000);
    this.orthoCam.up.set(0, 0, 1);
    this.orthoCam.position.set(140, -180, 140);
    this.camera = this.perspCam;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !prefersReducedMotion(); // no gliding on after a drag when reduced motion is asked for
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true; // pinch / wheel zoom toward the cursor
    this.controls.target.set(0, 0, 0);

    // lights
    // most of the light is the studio environment below; a little ambient keeps shadowed plastic from going black
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.18));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(1, -1, 2);
    this.scene.add(dir);

    // Image-based environment so PBR materials (esp. metals) read correctly —
    // without a reflection probe, metalness renders near-black.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(studioEnvironmentScene(), 0.02).texture;
      this.scene.environmentIntensity = 1.0;
      pmrem.dispose();
    } catch { /* headless / no-WebGL: skip */ }

    // grid on XY (world), rotated so it lies in XY with Z up
    this.grid = this.makeGrid(this.gridSize);
    this.scene.add(this.grid);

    this.buildAxes();
    this.buildPlanes();
    this.scene.add(this.ghostGroup);
    this.scene.add(this.motionGroup);
    this.scene.add(this.regionGroup);
    this.scene.add(this.previewSolidGroup);
    this.scene.add(this.planeGroup);
    this.scene.add(this.datumGroup);
    this.scene.add(this.sketchGroup);
    this.scene.add(this.previewGroup);
    this.scene.add(this.solidsGroup);
    this.scene.add(this.handles.group);

    window.addEventListener("resize", this.onResize);
    // The viewport also resizes when side panels toggle (Agent drawer, inspector)
    // or when the layout settles after mount — none of which fire window.resize.
    // Observe the container directly so the renderer and both camera frustums
    // always match the real canvas size (otherwise aspect goes anisotropic).
    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(container);
    this.animate();
  }

  /** Repaint for the current theme (palette.ts): background, grid, axes, origin
   *  planes, then everything update() builds (sketch, dimensions, datums, regions). */
  private applyTheme() {
    if (this.disposed) return;
    const c = COLORS();
    (this.scene.background as THREE.Color).set(c.bg);
    this.applyGrid(this.gridSize, true);
    const axisColors = [c.axisX, c.axisY, c.axisZ];
    this.axes.children.forEach((l, i) => ((l as THREE.Line).material as THREE.LineBasicMaterial).color.set(axisColors[i]));
    for (const m of this.planeMeshes.values()) (m.material as THREE.MeshBasicMaterial).opacity = c.planeFill;
    for (const o of this.planeGroup.children) if (o.userData.planeOutline) ((o as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity = c.planeLine;
    // A live animation moves bodies by matrix; rebuilding them would drop its groups, so only the sketch layer repaints then.
    if (this.lastData && !this.animating && !this.recording) this.update(this.lastData);
    else this.rerenderSketchLayer();
    if (!this.recording) this.drawFrame();
  }

  private makeGrid(size: number): THREE.GridHelper {
    const divisions = 40;
    const grid = new THREE.GridHelper(size * divisions, divisions, COLORS().gridMajor, COLORS().grid);
    grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default; lay it in XY (Z up)
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = COLORS().gridOpacity;
    this.gridSize = size;
    return grid;
  }

  /** Rebuild the grid at a new cell size (mm). */
  private applyGrid(size: number, force = false) {
    if (!force && Math.abs(size - this.gridSize) < 1e-9) return;
    const visible = this.grid.visible;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.grid = this.makeGrid(size);
    this.grid.visible = visible;
    this.scene.add(this.grid);
  }

  private buildAxes() {
    const mk = (dir: THREE.Vector3, color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        dir.clone().multiplyScalar(180),
      ]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    };
    const c = COLORS();
    this.axes.add(mk(new THREE.Vector3(1, 0, 0), c.axisX));
    this.axes.add(mk(new THREE.Vector3(0, 1, 0), c.axisY));
    this.axes.add(mk(new THREE.Vector3(0, 0, 1), c.axisZ));
    this.scene.add(this.axes);
  }

  /** Hide the editing overlays (origin planes, datums, grid, axes) for a clean
   *  product capture; returns a function that restores their visibility. */
  hideOverlays(): () => void {
    const items = [this.planeGroup, this.datumGroup, this.grid, this.axes];
    const was = items.map((o) => o.visible);
    for (const o of items) o.visible = false;
    return () => items.forEach((o, i) => { o.visible = was[i]; });
  }

  private buildPlanes() {
    const size = 120;
    for (const p of PLANES) {
      const geo = new THREE.PlaneGeometry(size, size);
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(p.color),
        transparent: true,
        opacity: COLORS().planeFill,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      this.orientToPlane(mesh, p, size / 2);
      mesh.userData = { planeId: p.id, kind: "plane" };
      this.planeMeshes.set(p.id, mesh);
      this.planeGroup.add(mesh);

      // border outline
      const edges = new THREE.EdgesGeometry(geo);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: new THREE.Color(p.color), transparent: true, opacity: COLORS().planeLine })
      );
      line.userData = { planeOutline: true };
      this.orientToPlane(line, p, size / 2);
      this.planeGroup.add(line);
      for (const label of this.planeLabel(p.name, p.color, size)) {
        this.orientToPlane(label, p, size / 2);
        this.placeLabel(label, size);
        this.planeGroup.add(label);
      }
    }
  }

  // A plane's name, printed faintly in its far corner (top right, away from the axes it shares): lying in the plane at a size
  // set by the plane's, behind any solid in front of it, and never picked. Two one-sided
  // copies back to back, so it reads the right way round from either side.
  private labelTextures = new Map<string, { tex: THREE.CanvasTexture; aspect: number }>();
  private planeLabel(text: string, color: THREE.ColorRepresentation, planeSize: number): THREE.Mesh[] {
    const css = `#${new THREE.Color(color).getHexString()}`, key = `${text}\u0000${css}`;
    let t = this.labelTextures.get(key);
    if (!t) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return []; // no 2D canvas (tests): no label
      const font = `500 64px -apple-system, system-ui, sans-serif`;
      ctx.font = font;
      canvas.width = Math.ceil(ctx.measureText(text).width) + 8;
      canvas.height = 84;
      ctx.font = font;
      ctx.fillStyle = css;
      ctx.textBaseline = "middle";
      ctx.fillText(text, 4, canvas.height / 2);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      t = { tex, aspect: canvas.width / canvas.height };
      this.labelTextures.set(key, t);
    }
    const h = planeSize * 0.045;
    return [0, Math.PI].map((turn) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(h * t!.aspect, h),
        new THREE.MeshBasicMaterial({ map: t!.tex, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false }),
      );
      mesh.userData = { planeLabel: true, turn, width: h * t!.aspect, height: h };
      mesh.renderOrder = 1; // over the plane's fill
      mesh.raycast = () => {};
      return mesh;
    });
  }

  /** Move a label (already oriented like its plane, at the plane's centre) into the top-right corner. */
  private placeLabel(label: THREE.Object3D, planeSize: number) {
    const { turn, width, height } = label.userData as { turn: number; width: number; height: number };
    const pad = planeSize * 0.03;
    label.translateX(planeSize / 2 - pad - width / 2);
    label.translateY(planeSize / 2 - pad - height / 2);
    if (turn) label.rotateY(turn); // the back copy faces the other way
  }

  private orientToPlane(obj: THREE.Object3D, p: WorkPlane, half: number) {
    // Build a basis matrix from plane u, v, normal and offset to the +quadrant.
    const u = new THREE.Vector3(p.u.x, p.u.y, p.u.z);
    const v = new THREE.Vector3(p.v.x, p.v.y, p.v.z);
    const n = new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z);
    const m = new THREE.Matrix4().makeBasis(u, v, n);
    obj.setRotationFromMatrix(m);
    // center the square around the +,+ quadrant a little
    const center = u.clone().multiplyScalar(half * 0.6).add(v.clone().multiplyScalar(half * 0.6));
    obj.position.copy(center);
  }

  /** Rebuild the datum/reference plane visuals each frame (they are parametric). */
  private renderDatumPlanes(datums: { id: string; name: string; plane: WorkPlane }[]) {
    this.clearGroup(this.datumGroup);
    this.datumMeshes.clear();
    const size = 90;
    for (const d of datums) {
      const p = d.plane;
      const color = new THREE.Color(COLORS().datum); // datum amber, distinct from origin planes
      const geo = new THREE.PlaneGeometry(size, size);
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      this.orientDatum(mesh, p, size / 2);
      mesh.userData = { planeId: d.id, datumId: d.id, kind: "plane" };
      this.datumMeshes.set(d.id, mesh);
      this.datumGroup.add(mesh);

      const edges = new THREE.EdgesGeometry(geo);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })
      );
      this.orientDatum(line, p, size / 2);
      this.datumGroup.add(line);
      for (const label of this.planeLabel(d.name, color, size)) {
        this.orientDatum(label, p, size / 2);
        this.placeLabel(label, size);
        this.datumGroup.add(label);
      }
    }
  }

  /** Orient+position a datum visual: basis from the frame, centered on its origin. */
  private orientDatum(obj: THREE.Object3D, p: WorkPlane, half: number) {
    const u = new THREE.Vector3(p.u.x, p.u.y, p.u.z);
    const v = new THREE.Vector3(p.v.x, p.v.y, p.v.z);
    const n = new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z);
    obj.setRotationFromMatrix(new THREE.Matrix4().makeBasis(u, v, n));
    const center = u.clone().multiplyScalar(half * 0.6).add(v.clone().multiplyScalar(half * 0.6));
    obj.position.set(p.origin.x, p.origin.y, p.origin.z).add(center);
  }

  // Once we have seen a wheel event that could only come from a trackpad
  // (a horizontal component, or fine/fractional vertical deltas), we treat
  // subsequent plain scrolls as two-finger pans rather than zoom.
  private trackpadSeen = false;

  private onWheel = (e: WheelEvent) => {
    // Pinch-zoom on a trackpad (and ctrl+wheel on a mouse) arrives with
    // ctrlKey set — let OrbitControls dolly it (zoomToCursor is on).
    if (e.ctrlKey) return;
    const pixelMode = e.deltaMode === 0;
    if (pixelMode && (e.deltaX !== 0 || Math.abs(e.deltaY) < 40 || !Number.isInteger(e.deltaY))) {
      this.trackpadSeen = true;
    }
    if (this.trackpadSeen && pixelMode) {
      // Two-finger scroll → pan. Suppress OrbitControls' wheel-dolly.
      e.preventDefault();
      e.stopImmediatePropagation();
      this.panByPixels(e.deltaX, e.deltaY);
      return;
    }
    // Otherwise it's a classic mouse wheel → let OrbitControls zoom.
  };

  /** Pan the view by a screen-pixel delta (trackpad two-finger scroll). */
  private panByPixels(dx: number, dy: number) {
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    // Content follows the fingers: scroll right/down slides the view that way.
    const move = right.multiplyScalar(this.pixelToWorld(dx)).add(up.multiplyScalar(-this.pixelToWorld(dy)));
    cam.position.add(move);
    this.controls.target.add(move);
  }

  private onResize = () => {
    // screen-space line widths follow the canvas (folded paper's raw edges)
    { const size = this.renderer.getSize(new THREE.Vector2()); this.scene.traverse((o) => { if (o.userData.paper && o instanceof LineSegments2) (o.material as LineMaterial).resolution.copy(size); }); }
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return; // container not laid out / hidden
    const aspect = w / h;
    this.perspCam.aspect = aspect;
    this.perspCam.updateProjectionMatrix();
    const halfH = (this.orthoCam.top - this.orthoCam.bottom) / 2;
    this.orthoCam.left = -halfH * aspect;
    this.orthoCam.right = halfH * aspect;
    this.orthoCam.updateProjectionMatrix();
    this.applyViewInset();
    this.renderer.setSize(w, h);
    // setSize clears the canvas; draw again now, or the browser can paint it blank before the next frame
    // (the model flickers out while a side panel is dragged). The recorder draws its own frames.
    if (!this.recording) this.drawFrame();
  };

  // ---- what the UI covers ----
  /** Canvas covered by UI (CSS px): the customize viewer's card on the right, its bottom sheet on a
   *  phone. The camera centres on, and frames into, the part of the canvas that's left. */
  private viewInset = { right: 0, bottom: 0 };
  setViewInset(inset: { right?: number; bottom?: number }) {
    const next = { right: Math.max(0, Math.round(inset.right ?? 0)), bottom: Math.max(0, Math.round(inset.bottom ?? 0)) };
    if (next.right === this.viewInset.right && next.bottom === this.viewInset.bottom) return;
    this.viewInset = next;
    this.applyViewInset();
    this.invalidate();
  }
  /** Shift the projection so the camera's target sits in the middle of the free area. */
  private applyViewInset() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const { right, bottom } = this.viewInset;
    for (const cam of [this.perspCam, this.orthoCam]) {
      if (right || bottom) cam.setViewOffset(w, h, right / 2, bottom / 2, w, h);
      else if (cam.view?.enabled) cam.clearViewOffset();
    }
  }
  /** The tangent of the half-angle a model may fill when framed: the vertical field of view, narrowed
   *  to the horizontal one on a portrait screen, and to the area the UI leaves uncovered. */
  private fitTan(fovDeg: number): number {
    return fitTangent(fovDeg, this.container.clientWidth, this.container.clientHeight, this.viewInset);
  }

  // ---- render on demand ----
  // A frame is drawn when something to see changed: the view was rebuilt, an overlay
  // (handles, the pick highlight, the lens) changed, or the camera moved — by the
  // controls, a tween, the 3D mouse, or anyone setting it directly (its pose is
  // stamped every tick). Nothing changing, nothing is drawn.
  private needsRender = true;
  private lastCamStamp = "";
  /** Ask for a frame: something in the scene changed. */
  invalidate() { this.needsRender = true; }
  private camStamp(): string {
    const c = this.camera as THREE.PerspectiveCamera & THREE.OrthographicCamera;
    const p = c.position, q = c.quaternion, u = c.up;
    // to 8 significant digits: the controls recompute the pose from spherical coordinates every
    // tick, which jitters in the last bits of a double without the camera having moved
    const f = (v: number | undefined) => (v === undefined ? "" : v === 0 ? "0" : v.toPrecision(8));
    return `${f(p.x)},${f(p.y)},${f(p.z)}|${f(q.x)},${f(q.y)},${f(q.z)},${f(q.w)}|${f(u.x)},${f(u.y)},${f(u.z)}|${f(c.zoom)},${c.fov},${f(c.left)},${f(c.top)}|${c.uuid}`;
  }

  private animate = () => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    if (this.recording) return; // the turntable recorder drives render() itself
    const dt = this.clock.getDelta();
    let moving = false;
    if (this.fading) { this.applyFades(); moving = true; } // the frame a fade ends on is drawn at its final opacity too
    if (this.tween) { this.stepTween(dt); moving = true; }
    else {
      if (this.controls.update()) moving = true;
      const nav = navigationDelta(this.navInput, Math.min(dt, 0.05), this.navSettings, this.lastData?.mode === "sketch");
      if (!isIdle(nav)) { this.applyNavigation(nav); moving = true; }
    }
    // Dimension annotations and constraint badges are sized in world units from
    // the on-screen pixel scale, computed when the sketch is built. That scale
    // changes with zoom but not with a document edit, so re-render the sketch
    // layer whenever the zoom (pixels-per-world) shifts — keeps labels/arrows a
    // constant screen size instead of ballooning until the next edit.
    const scale = this.worldThreshold(1);
    if (this.lastPixelScale && Math.abs(scale - this.lastPixelScale) > this.lastPixelScale * 0.002) {
      this.rerenderSketchLayer();
    }
    this.lastPixelScale = scale;
    const stamp = this.camStamp();
    if (stamp !== this.lastCamStamp) { this.lastCamStamp = stamp; moving = true; }
    if (moving || this.needsRender) {
      this.needsRender = false;
      this.drawFrame();
    }
    this.noticeCameraChange();
  };

  /** Draw the scene, then the lens over it: redraw the solids under the lens with the analysis material (no-op when unset). */
  private drawFrame() {
    this.fitNear();
    this.renderer.render(this.scene, this.camera);
    this.lensPass.render(this.renderer, this.scene, this.camera, this.solidsGroup, this.lastData?.solids);
  }

  /** Show analysis under a lens / wipe (null clears it). See lensPass.ts. */
  setLens(spec: LensSpec | null) { this.lensPass.setSpec(spec); this.invalidate(); }

  // Screen-anchored HTML (pins, cards, dimensions) follows the camera through
  // this: listeners run once per frame in which the view actually moved.
  private cameraListeners = new Set<() => void>();
  private cameraStamp = "";
  private noticeCameraChange() {
    if (!this.cameraListeners.size) return;
    const c = this.camera as THREE.PerspectiveCamera & THREE.OrthographicCamera;
    const m = c.matrixWorld.elements;
    const el = this.renderer.domElement;
    const stamp = `${m[12].toFixed(3)},${m[13].toFixed(3)},${m[14].toFixed(3)},${m[0].toFixed(4)},${m[5].toFixed(4)},${m[10].toFixed(4)},${m[1].toFixed(4)},${(c.zoom ?? 1).toFixed(4)},${c.fov ?? 0},${el.clientWidth}x${el.clientHeight}`;
    if (stamp === this.cameraStamp) return;
    this.cameraStamp = stamp;
    for (const fn of this.cameraListeners) fn();
  }

  /** Run `fn` after every frame in which the camera (or the canvas size) changed. Returns the unsubscribe. */
  onCameraChange(fn: () => void): () => void {
    this.cameraListeners.add(fn);
    return () => { this.cameraListeners.delete(fn); };
  }

  /** The camera's position and view direction in world space. */
  /** The camera's axes in world space: screen right, screen up, and back (from the target towards the camera). */
  cameraBasis(): { right: { x: number; y: number; z: number }; up: { x: number; y: number; z: number }; back: { x: number; y: number; z: number } } {
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorld.elements;
    return { right: { x: e[0], y: e[1], z: e[2] }, up: { x: e[4], y: e[5], z: e[6] }, back: { x: e[8], y: e[9], z: e[10] } };
  }

  cameraPose(): { position: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } } {
    const p = this.camera.position, d = this.camera.getWorldDirection(new THREE.Vector3());
    return { position: { x: p.x, y: p.y, z: p.z }, direction: { x: d.x, y: d.y, z: d.z } };
  }

  /** The 3D mouse's current deflection (from WebHID or the desktop's HID reader). */
  setNavigationInput(state: SpaceMouseState) { this.navInput = state; }

  /** Move the camera by one frame of 3D-mouse motion: orbit about the orbit
   *  target (yaw about world up, pitch about the screen's right axis, stopping
   *  short of the poles; the view stays Z-up, so roll is not applied), pan in
   *  the view plane by a fraction of the visible height, and dolly / zoom. */
  private applyNavigation(d: NavigationDelta) {
    const cam = this.camera as THREE.PerspectiveCamera & THREE.OrthographicCamera;
    const target = this.controls.target;
    const off = cam.position.clone().sub(target);
    const up = cam.up.clone().normalize();
    if (d.yaw) off.applyAxisAngle(up, -d.yaw);
    if (d.pitch) {
      const right = new THREE.Vector3().crossVectors(off, up).normalize();
      const turned = off.clone().applyAxisAngle(right, -d.pitch);
      if (Math.abs(turned.clone().normalize().dot(up)) < 0.995) off.copy(turned);
    }
    const dist = off.length();
    const visible = (cam as THREE.PerspectiveCamera).isPerspectiveCamera
      ? 2 * dist * Math.tan(((cam.fov * Math.PI) / 180) / 2)
      : (cam.top - cam.bottom) / (cam.zoom || 1);
    if (d.panX || d.panY) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      // the model follows the cap, so the camera moves the other way
      const move = right.multiplyScalar(-d.panX * visible).add(screenUp.multiplyScalar(-d.panY * visible));
      target.add(move);
    }
    if (d.zoom !== 1) {
      if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) off.multiplyScalar(1 / d.zoom);
      else { cam.zoom *= d.zoom; cam.updateProjectionMatrix(); }
    }
    cam.position.copy(target).add(off);
    cam.lookAt(target);
  }

  /** Rebuild only the sketch + preview groups (cheap; leaves solids alone). */
  private rerenderSketchLayer() {
    const d = this.lastData;
    if (!d || !d.sketch || !d.plane) return;
    this.clearGroup(this.sketchGroup);
    this.clearGroup(this.previewGroup);
    this.renderSketch(d.sketch, d.plane, d);
    if (d.preview) this.renderPreview(d.preview, d.plane);
    this.invalidate();
  }

  /** Advance the active-camera animation one frame (slerp orientation, lerp dolly). */
  private stepTween(dt: number) {
    const tw = this.tween!;
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const e = tw.t * tw.t * (3 - 2 * tw.t); // smoothstep
    const target = tw.from.target.clone().lerp(tw.to.target, e);
    // Slerp the camera offset direction, lerp its length, so it arcs around the target.
    const fromDir = tw.from.off.clone().normalize();
    const toDir = tw.to.off.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(fromDir, toDir);
    const dir = fromDir.clone().applyQuaternion(new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), q, e));
    const len = THREE.MathUtils.lerp(tw.from.off.length(), tw.to.off.length(), e);
    const up = tw.from.up.clone().lerp(tw.to.up, e).normalize();
    this.camera.position.copy(target).addScaledVector(dir, len);
    this.camera.up.copy(up);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    const oc = this.camera as THREE.OrthographicCamera;
    if (oc.isOrthographicCamera) {
      oc.zoom = THREE.MathUtils.lerp(tw.from.zoom, tw.to.zoom, e);
      oc.updateProjectionMatrix();
    }
    if (tw.t >= 1) {
      this.tween = null;
      this.controls.enabled = true;
      tw.onDone?.();
    }
  }

  dispose() {
    this.disposed = true;
    this.clearMotionGhosts();
    this.offTheme();
    for (const t of this.threadTexCache.values()) t.dispose();
    this.threadTexCache.clear();
    this.lensPass.dispose();
    this.resizeObs?.disconnect();
    this.renderer.domElement.removeEventListener("wheel", this.onWheel, { capture: true } as EventListenerOptions);
    window.removeEventListener("resize", this.onResize);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---- interaction helpers ----

  /** Pointer position (clientX/Y) -> normalized device coords. */
  ndc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  /** Intersect the active work plane; returns sketch (u,v). */
  pointerToUV(clientX: number, clientY: number, p: WorkPlane): { u: number; v: number } | null {
    const ndc = this.ndc(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane();
    const normal = new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z);
    plane.setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(p.origin.x, p.origin.y, p.origin.z));
    const hit = new THREE.Vector3();
    const ok = this.raycaster.ray.intersectPlane(plane, hit);
    if (!ok) return null;
    const dx = hit.x - p.origin.x;
    const dy = hit.y - p.origin.y;
    const dz = hit.z - p.origin.z;
    return {
      u: dx * p.u.x + dy * p.u.y + dz * p.u.z,
      v: dx * p.v.x + dy * p.v.y + dz * p.v.z,
    };
  }

  /** Pick a plane (model mode) or sketch entity (sketch mode). */
  pick(clientX: number, clientY: number, data: ViewData): PickResult {
    const ndc = this.ndc(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Line = { threshold: this.worldThreshold(6) };
    this.raycaster.params.Points = { threshold: this.worldThreshold(8) };

    if (data.mode === "sketch") {
      const hits = this.raycaster.intersectObjects(this.sketchGroup.children, true);
      // A dimension label the ray hits wins over geometry at the same depth, so
      // grabbing/editing the label is reliable (it's an overlay you reach for).
      const label = hits.find((h) => h.object.userData?.dimLabel);
      if (label) return { type: "entity", id: label.object.userData.id as string, entityKind: "dimension", world: label.point };
      // A point within a few pixels wins over the curve it sits on: clicking a line's end picks the end (M8).
      const point = hits.find((h) => h.object.userData?.id && h.object.userData?.kind === "point");
      if (point) return { type: "entity", id: point.object.userData.id as string, entityKind: "point", world: point.point };
      for (const h of hits) {
        const id = h.object.userData?.id as string | undefined;
        if (id) return { type: "entity", id, entityKind: h.object.userData?.kind, world: h.point };
      }
      return { type: "empty", world: hits[0]?.point };
    } else {
      // During an extrude session, region fills take priority (click to choose).
      if (this.regionGroup.children.length) {
        const regionHits = this.raycaster.intersectObjects(this.regionGroup.children, false);
        if (regionHits[0]) {
          const interior = regionHits[0].object.userData?.interior as { x: number; y: number } | undefined;
          return { type: "region", world: regionHits[0].point, interior };
        }
      }
      // Prefer a solid face (for sketch-on-face / face extrude), else an origin plane.
      const solidMeshes = this.solidsGroup.children.filter((c) => (c as THREE.Mesh).isMesh && !c.userData.ghost && c.visible); // a body faded out is not there to pick
      const faceHits = this.raycaster.intersectObjects(solidMeshes, false);
      const planeHits = this.raycaster.intersectObjects(
        [...this.planeMeshes.values(), ...this.datumMeshes.values()],
        false
      );
      // a see-through reference part (a stand-in in front of the mechanism) yields to a real part behind it
      const fh = faceHits.find((h) => !h.object.userData.reference) ?? faceHits[0], ph = planeHits[0];
      if (fh && fh.face && (!ph || fh.distance <= ph.distance)) {
        const n = fh.face.normal.clone().transformDirection(fh.object.matrixWorld).normalize();
        return { type: "face", id: fh.object.userData.bodyId as string | undefined, world: fh.point, normal: { x: n.x, y: n.y, z: n.z }, tri: fh.faceIndex != null ? fh.faceIndex * 3 : undefined };
      }
      if (ph) return { type: "plane", id: ph.object.userData.planeId, world: ph.point };
      return { type: "empty" };
    }
  }

  /** Every sketch entity under a screen point (sketch mode), points first then curves, without repeats: what a long
   *  press in a sketch offers to pick from. */
  pickAllSketch(clientX: number, clientY: number): { id: string; kind: string }[] {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    this.raycaster.params.Line = { threshold: this.worldThreshold(6) };
    this.raycaster.params.Points = { threshold: this.worldThreshold(8) };
    const out: { id: string; kind: string }[] = [];
    for (const h of this.raycaster.intersectObjects(this.sketchGroup.children, true)) {
      const id = h.object.userData?.id as string | undefined;
      if (!id || out.some((o) => o.id === id)) continue;
      out.push({ id, kind: h.object.userData?.dimLabel ? "dimension" : String(h.object.userData?.kind ?? "") });
    }
    return out.sort((a, b) => Number(b.kind === "point") - Number(a.kind === "point"));
  }

  /** Everything along the ray under a screen point, nearest first: every solid face crossing (front and back, so a
   *  face behind the model is reachable) and every origin/datum plane. The long-press selection picker lists these. */
  pickAll(clientX: number, clientY: number): { faces: { bodyId: string; world: P3; normal: P3; distance: number }[]; planes: { planeId: string; world: P3; distance: number }[] } {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const solidMeshes = this.solidsGroup.children.filter((c) => (c as THREE.Mesh).isMesh && !c.userData.ghost && c.userData.bodyId && c.visible);
    const faces = this.raycaster.intersectObjects(solidMeshes, false).filter((h) => h.face).map((h) => {
      const n = h.face!.normal.clone().transformDirection(h.object.matrixWorld).normalize();
      return { bodyId: h.object.userData.bodyId as string, world: { x: h.point.x, y: h.point.y, z: h.point.z }, normal: { x: n.x, y: n.y, z: n.z }, distance: h.distance };
    });
    const planes = this.raycaster.intersectObjects([...this.planeMeshes.values(), ...this.datumMeshes.values()], false)
      .filter((h) => h.object.visible && h.object.userData.planeId)
      .map((h) => ({ planeId: h.object.userData.planeId as string, world: { x: h.point.x, y: h.point.y, z: h.point.z }, distance: h.distance }));
    return { faces, planes };
  }

  private pickHighlight: THREE.Mesh | null = null;

  /** Light one face (its triangles' positions, flat xyz) in the accent colour, drawn over everything so a face
   *  behind the model shows through; null clears it. The selection picker calls this as you hover its entries. */
  setPickHighlight(triangles: Float32Array | null) {
    this.invalidate();
    if (this.pickHighlight) { this.scene.remove(this.pickHighlight); this.pickHighlight.geometry.dispose(); (this.pickHighlight.material as THREE.Material).dispose(); this.pickHighlight = null; }
    if (!triangles || !triangles.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(triangles, 3));
    const mat = new THREE.MeshBasicMaterial({ color: 0xf0a44b, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide });
    this.pickHighlight = new THREE.Mesh(geo, mat);
    this.pickHighlight.renderOrder = 999;
    this.scene.add(this.pickHighlight);
  }

  /** The world placement of a body's mesh (identity unless the body is placed by a transform). */
  private bodyMatrix(bodyId: string | undefined): THREE.Matrix4 | null {
    if (!bodyId) return null;
    const o = this.solidsGroup.children.find((c) => (c as THREE.Mesh).isMesh && c.userData.bodyId === bodyId);
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    return o.matrixWorld.clone();
  }

  private selectionLayer: THREE.Group | null = null;
  private hoverLayer: THREE.Mesh | null = null;

  private static disposeTree(o: THREE.Object3D) {
    o.traverse((c) => { const m = c as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose(); });
  }

  /** Light the selection: faces (triangles, flat xyz in the body's own frame) tinted in the accent colour and edges
   *  (segments, flat xyz) drawn over them. Null/empty clears. The picked face, Shell's faces to open, and the edges
   *  an edge-pick Fillet/Chamfer holds show here. */
  setSelectionHighlight(parts: { bodyId?: string; faces?: Float32Array | null; edges?: Float32Array | null }[] | null) {
    this.invalidate();
    if (this.selectionLayer) { this.scene.remove(this.selectionLayer); SceneManager.disposeTree(this.selectionLayer); this.selectionLayer = null; }
    if (!parts?.some((p) => p.faces?.length || p.edges?.length)) return;
    const g = new THREE.Group();
    for (const p of parts) {
      const m = this.bodyMatrix(p.bodyId);
      if (p.faces?.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(p.faces, 3));
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf0a44b, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
        if (m) mesh.applyMatrix4(m);
        mesh.renderOrder = 997;
        g.add(mesh);
      }
      if (p.edges?.length) {
        // picked edges as screen-space thick lines (a plain line is one pixel wide), drawn over the faces
        const geo = new LineSegmentsGeometry().setPositions(p.edges);
        const size = this.renderer.getSize(new THREE.Vector2());
        const mat = new LineMaterial({ color: 0xf07a1b, linewidth: 4, depthTest: false, transparent: true });
        mat.resolution.set(size.x, size.y);
        const lines = new LineSegments2(geo, mat);
        if (m) lines.applyMatrix4(m);
        lines.renderOrder = 998;
        g.add(lines);
      }
    }
    this.selectionLayer = g;
    this.scene.add(g);
  }

  /** A faint tint on the face under the cursor (flat xyz triangles in the body's frame), so you see what a click
   *  would pick; null clears. */
  setHoverHighlight(bodyId: string | undefined, faces: Float32Array | null) {
    if (this.hoverLayer) { this.scene.remove(this.hoverLayer); SceneManager.disposeTree(this.hoverLayer); this.hoverLayer = null; this.invalidate(); }
    if (!faces?.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(faces, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf0a44b, transparent: true, opacity: 0.18, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide }));
    const m = this.bodyMatrix(bodyId);
    if (m) mesh.applyMatrix4(m);
    mesh.renderOrder = 996;
    this.hoverLayer = mesh;
    this.scene.add(mesh);
    this.invalidate();
  }

  /** Public: approximate world/uv distance covered by `px` screen pixels. */
  pixelToWorld(px: number): number {
    return this.worldThreshold(px);
  }

  /** A world-space pick ray through a client point (for the HandleManager). */
  rayFrom(clientX: number, clientY: number): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    this.rayHelper.setFromCamera(this.ndc(clientX, clientY), this.camera);
    return { origin: this.rayHelper.ray.origin.clone(), dir: this.rayHelper.ray.direction.clone() };
  }

  /** Project a sketch-plane (u,v) point to client screen coordinates. */
  uvToScreen(plane: WorkPlane, u: number, v: number): { x: number; y: number } {
    const world = this.worldPt(plane, u, v);
    const ndc = world.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-ndc.y * 0.5 + 0.5) * rect.height,
    };
  }

  /**
   * Render the scene from a named view into an offscreen buffer and return a
   * PNG (base64). Used by the agent / WebMCP render_view tool; does not disturb
   * the user's camera.
   */
  renderView(opts: RenderViewOpts = {}): { base64: string; width: number; height: number; view: string } {
    const width = Math.max(64, Math.min(Math.round(opts.width ?? 960), 1920));
    const height = Math.max(64, Math.min(Math.round(opts.height ?? 720), 1920));
    // Only honour hideSketches when there is a solid to show; otherwise the capture would be empty.
    const hideSketches = !!opts.hideSketches && this.solidsGroup.children.length > 0;

    const box = new THREE.Box3();
    for (const g of hideSketches ? [this.solidsGroup] : [this.solidsGroup, this.sketchGroup, this.ghostGroup]) {
      const b = new THREE.Box3().setFromObject(g);
      if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-20, -20, -20), new THREE.Vector3(20, 20, 20));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);

    const DIRS: Record<string, [number, number, number]> = {
      iso: [1, -1, 0.8], front: [0, -1, 0], back: [0, 1, 0],
      top: [0, 0, 1], bottom: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0],
    };
    // A free camera (azimuth/elevation) overrides the named view.
    const free = opts.azimuthDeg != null || opts.elevationDeg != null;
    const view = free
      ? `az${Math.round(opts.azimuthDeg ?? -60)}_el${Math.round(opts.elevationDeg ?? 30)}`
      : opts.view && DIRS[opts.view] ? opts.view : "iso";
    const dir = free
      ? new THREE.Vector3(...orbitDirection(opts.azimuthDeg ?? -60, opts.elevationDeg ?? 30))
      : new THREE.Vector3(...DIRS[view]).normalize();
    const fov = Math.max(1, Math.min(opts.fovDeg ?? 45, 120));
    const dist = fitDistance(radius, fov, width / height);
    const cam = new THREE.PerspectiveCamera(fov, width / height, Math.max(0.1, Math.min(dist - radius, dist / 200)), 1e6);
    cam.up.set(0, 0, 1);
    if (view === "top" || view === "bottom") cam.up.set(0, 1, 0);
    cam.position.copy(center).addScaledVector(dir, dist);
    cam.lookAt(center);
    if (opts.rollDeg) cam.rotateZ((opts.rollDeg * Math.PI) / 180); // about the view axis
    cam.updateProjectionMatrix();

    const rt = new THREE.WebGLRenderTarget(width, height);
    // Hide the big origin-plane overlays (keep grid + axes for context unless `clean`).
    const restoreOverlays = opts.clean ? this.hideOverlays() : null;
    const planesVisible = this.planeGroup.visible;
    const sketchVisible = this.sketchGroup.visible;
    this.planeGroup.visible = false;
    if (hideSketches) this.sketchGroup.visible = false;
    // Capture lighting: a key/fill pair from the camera side so faces read as
    // distinct values in the PNG (the live viewport's soft ambient looks flat
    // when reviewed as a still image).
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.copy(cam.position).add(new THREE.Vector3(radius, -radius * 0.5, radius * 1.5));
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.45);
    fill.position.copy(center).add(new THREE.Vector3(-radius * 2, radius, radius * 0.5));
    this.scene.add(key, fill);
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, cam);
    const buf = new Uint8Array(width * height * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
    this.renderer.setRenderTarget(null);
    this.scene.remove(key, fill);
    this.planeGroup.visible = planesVisible;
    this.sketchGroup.visible = sketchVisible;
    restoreOverlays?.();
    rt.dispose();
    this.invalidate(); // the on-screen frame is as it was, but a render changed GL state

    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * width * 4; // readPixels is bottom-up
      img.data.set(buf.subarray(src, src + width * 4), y * width * 4);
    }
    ctx.putImageData(img, 0, 0);
    return { base64: canvas.toDataURL("image/png").split(",")[1], width, height, view };
  }

  /** Project a world point to client (screen) coordinates. */
  worldToScreen(p: { x: number; y: number; z: number }): { x: number; y: number } {
    const ndc = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width, y: rect.top + (-ndc.y * 0.5 + 0.5) * rect.height };
  }

  /** Approximate world-space size of `px` screen pixels at the target depth. */
  private worldThreshold(px: number): number {
    const oc = this.camera as THREE.OrthographicCamera;
    if (oc.isOrthographicCamera) {
      return (px * (oc.top - oc.bottom)) / oc.zoom / this.container.clientHeight;
    }
    const pc = this.camera as THREE.PerspectiveCamera;
    const dist = pc.position.distanceTo(this.controls.target);
    const vFov = (pc.fov * Math.PI) / 180;
    return (px * (2 * Math.tan(vFov / 2) * dist)) / this.container.clientHeight;
  }

  // ---- camera transitions (Fusion-style) ----

  private camOff(): THREE.Vector3 {
    return this.camera.position.clone().sub(this.controls.target);
  }

  /** Copy the perspective framing onto the ortho camera (so a swap is seamless). */
  private matchOrthoToPerspective() {
    const t = this.controls.target;
    const dist = this.perspCam.position.distanceTo(t);
    const h = 2 * dist * Math.tan(((this.perspCam.fov * Math.PI) / 180) / 2);
    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.orthoCam.top = h / 2; this.orthoCam.bottom = -h / 2;
    this.orthoCam.left = (-h / 2) * aspect; this.orthoCam.right = (h / 2) * aspect;
    this.orthoCam.zoom = 1;
    this.orthoCam.position.copy(this.perspCam.position);
    this.orthoCam.up.copy(this.perspCam.up);
    this.orthoCam.lookAt(t);
    this.orthoCam.updateProjectionMatrix();
  }

  /** Copy the ortho framing onto the perspective camera (reverse of the above). */
  private matchPerspectiveToOrtho() {
    const t = this.controls.target;
    const h = (this.orthoCam.top - this.orthoCam.bottom) / this.orthoCam.zoom;
    const dist = (h / 2) / Math.tan(((this.perspCam.fov * Math.PI) / 180) / 2);
    const dir = this.orthoCam.position.clone().sub(t).normalize();
    this.perspCam.position.copy(t).addScaledVector(dir, dist);
    this.perspCam.up.copy(this.orthoCam.up);
    this.perspCam.lookAt(t);
    this.perspCam.updateProjectionMatrix();
  }

  private setActiveCamera(cam: THREE.Camera) {
    this.camera = cam;
    (this.controls as unknown as { object: THREE.Camera }).object = cam;
  }

  /**
   * Animate from the current view (perspective or ortho) into the orthographic,
   * plane-aligned sketch view. Used on sketch entry and by "Look At".
   */
  transitionToSketchView(p: WorkPlane) {
    // Ensure the ortho camera is active, matched to the current framing.
    if (!(this.camera as THREE.OrthographicCamera).isOrthographicCamera) {
      this.matchOrthoToPerspective();
      this.setActiveCamera(this.orthoCam);
    }
    const target = new THREE.Vector3(p.origin.x, p.origin.y, p.origin.z);
    const normal = new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z).normalize();
    const curOff = this.camOff();
    const len = Math.max(50, curOff.length());
    this.beginTween({
      from: { off: curOff, target: this.controls.target.clone(), up: this.camera.up.clone(), zoom: this.orthoCam.zoom },
      to: { off: normal.multiplyScalar(len), target, up: new THREE.Vector3(p.v.x, p.v.y, p.v.z), zoom: this.orthoCam.zoom },
    });
  }

  /** Animate back to a perspective 3D view (on finishing a sketch): ease from looking straight at the sketch to a
   *  three-quarter view of it, Z up, so an extrude's depth can be seen. */
  exitSketchView() {
    if ((this.camera as THREE.OrthographicCamera).isOrthographicCamera) {
      this.matchPerspectiveToOrtho();
      this.setActiveCamera(this.perspCam);
    }
    this.tween = null;
    this.controls.enabled = true;
    this.controls.update();
    const off = this.camOff();
    const len = off.length();
    if (len < 1e-6) return;
    const n = off.clone().normalize();
    // the screen's right and up while looking at the sketch: lean the view up and to the right of its normal
    const right = new THREE.Vector3().crossVectors(this.camera.up, n).normalize();
    const up = new THREE.Vector3().crossVectors(n, right).normalize();
    if (!Number.isFinite(right.x) || right.lengthSq() < 1e-9) return;
    // lean to the +X side, and upward (a wall-like sketch) or towards the front (a floor-like one): a front-right,
    // from-above three-quarter view like the standard iso
    if (right.x < -1e-6) right.negate();
    const s = Math.abs(up.z) > 0.5 ? Math.sign(up.z) : up.y > 0 ? -1 : 1;
    const dir = n.clone().addScaledVector(right, 0.85).addScaledVector(up, 0.75 * s).normalize();
    // a view from below the floor looks wrong: keep it above
    if (dir.z < 0.25) { dir.z = 0.25 + Math.abs(dir.z) * 0.5; dir.normalize(); }
    this.beginTween({
      from: { off, target: this.controls.target.clone(), up: this.camera.up.clone(), zoom: this.perspCam.zoom },
      to: { off: dir.multiplyScalar(len), target: this.controls.target.clone(), up: new THREE.Vector3(0, 0, 1), zoom: this.perspCam.zoom },
      dur: 0.6,
    });
  }

  /** Turn (animated) to look at the model from along `dir` (world, pointing from the model to the camera), framed:
   *  what a click on the view cube's face, edge or corner does. Model mode only. */
  viewFromDir(dir: { x: number; y: number; z: number }) {
    if (this.lastData?.mode === "sketch") return;
    const d = new THREE.Vector3(dir.x, dir.y, dir.z);
    if (d.lengthSq() < 1e-12) return;
    d.normalize();
    const box = new THREE.Box3().setFromObject(this.solidsGroup);
    const center = box.isEmpty() ? this.controls.target.clone() : box.getCenter(new THREE.Vector3());
    const radius = box.isEmpty() ? Math.max(20, this.camOff().length() / 3) : Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
    const pc = this.perspCam;
    const dist = (radius * 1.3) / Math.tan(((pc.fov * Math.PI) / 180) / 2);
    // straight down or up: Y up on screen; otherwise Z up
    const up = Math.abs(d.z) > 0.999 ? new THREE.Vector3(0, d.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
    this.beginTween({
      from: { off: this.camOff(), target: this.controls.target.clone(), up: this.camera.up.clone(), zoom: pc.zoom },
      to: { off: d.multiplyScalar(dist), target: center, up, zoom: pc.zoom },
    });
  }

  /** Zoom-to-fit a set of sketch (u,v) points, keeping the current view direction. */
  frameSketchPoints(plane: WorkPlane, pts: { x: number; y: number }[]) {
    if (!pts.length) return;
    this.frameWorld(pts.map((p) => this.worldPt(plane, p.x, p.y)));
  }

  /** Turn (animated) to look straight at a face: the camera moves onto the face's
   *  normal through `point`, keeping its distance; the up vector is kept unless it
   *  is (nearly) parallel to the normal. Model mode only. */
  lookAtFace(point: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }) {
    if (this.lastData?.mode === "sketch") return;
    const n = new THREE.Vector3(normal.x, normal.y, normal.z);
    if (n.lengthSq() < 1e-12) return;
    n.normalize();
    const target = new THREE.Vector3(point.x, point.y, point.z);
    const dist = Math.max(this.camOff().length(), 1);
    let up = this.camera.up.clone();
    if (Math.abs(up.dot(n)) > 0.95) up = Math.abs(n.z) > 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    this.beginTween({
      from: { off: this.camOff(), target: this.controls.target.clone(), up: this.camera.up.clone(), zoom: (this.camera as THREE.OrthographicCamera).zoom ?? 1 },
      to: { off: n.multiplyScalar(dist), target, up, zoom: (this.camera as THREE.OrthographicCamera).zoom ?? 1 },
    });
  }

  /** Turn (animated) to a standard view of the model, framed: iso, front,
   *  back, top, bottom, right, left. Model mode only (a sketch keeps its plane). */
  viewFrom(view: string) {
    if (this.lastData?.mode === "sketch") return;
    const DIRS: Record<string, [number, number, number]> = {
      iso: [1, -1, 0.8], front: [0, -1, 0], back: [0, 1, 0], top: [0, 0.0001, 1], bottom: [0, 0.0001, -1], right: [1, 0, 0], left: [-1, 0, 0],
    };
    const v = DIRS[view];
    if (!v) return;
    const box = new THREE.Box3().setFromObject(this.solidsGroup);
    const center = box.isEmpty() ? this.controls.target.clone() : box.getCenter(new THREE.Vector3());
    const radius = box.isEmpty() ? Math.max(20, this.camOff().length() / 3) : Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
    const pc = this.perspCam;
    const dist = (radius * 1.3) / this.fitTan(pc.fov);
    const up = this.camera.up.clone();
    this.beginTween({
      from: { off: this.camOff(), target: this.controls.target.clone(), up, zoom: pc.zoom },
      to: { off: new THREE.Vector3(...v).normalize().multiplyScalar(dist), target: center, up, zoom: pc.zoom },
    });
  }

  /** Zoom-to-fit all rendered solids (used by Frame in model mode). */
  frameModel() {
    const box = new THREE.Box3().setFromObject(this.solidsGroup);
    if (box.isEmpty()) return;
    const c = [box.min, box.max];
    const corners: THREE.Vector3[] = [];
    for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) {
      corners.push(new THREE.Vector3(c[x].x, c[y].y, c[z].z));
    }
    this.frameWorld(corners);
  }

  /** Reframe (animated) so the given world points fit, without rotating the view. */
  private frameWorld(pts: THREE.Vector3[]) {
    const box = new THREE.Box3().setFromPoints(pts);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
    const margin = 1.3;
    let dir = this.camOff().normalize();
    if (dir.lengthSq() < 1e-9) dir = new THREE.Vector3(0, 0, 1);
    const up = this.camera.up.clone();
    const from = { off: this.camOff(), target: this.controls.target.clone(), up, zoom: (this.camera as THREE.OrthographicCamera).zoom ?? 1 };
    const oc = this.camera as THREE.OrthographicCamera;
    if (oc.isOrthographicCamera) {
      const halfH = (oc.top - oc.bottom) / 2;
      const len = Math.max(50, this.camOff().length());
      this.beginTween({ from, to: { off: dir.clone().multiplyScalar(len), target: center, up, zoom: halfH / (radius * margin) } });
    } else {
      const pc = this.perspCam;
      const dist = (radius * margin) / this.fitTan(pc.fov);
      this.beginTween({ from, to: { off: dir.clone().multiplyScalar(dist), target: center, up, zoom: pc.zoom } });
    }
  }

  private beginTween(spec: {
    from: { off: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number };
    to: { off: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number };
    onDone?: () => void;
    dur?: number;
  }) {
    this.controls.enabled = false;
    // with reduced motion asked for, the app's own camera moves (a view, Frame) cut instead of gliding;
    // a script that names a duration (the tutorial video's shots) still gets it
    const dur = spec.dur ?? (prefersReducedMotion() ? 0.001 : 0.5);
    this.tween = { t: 0, dur, from: spec.from, to: spec.to, onDone: spec.onDone };
  }

  /** Turn and move (animated over `seconds`) to look along `-dir` at `center`, far enough that a sphere of
   *  `radius` fills the view with `margin` to spare. Model mode, perspective camera (the tutorial video's shots). */
  aim(dir: { x: number; y: number; z: number }, center: { x: number; y: number; z: number }, radius: number, seconds = 0.5, margin = 1.15) {
    if (this.lastData?.mode === "sketch") return;
    const d = new THREE.Vector3(dir.x, dir.y, dir.z);
    if (d.lengthSq() < 1e-12) return;
    const pc = this.perspCam;
    const dist = (Math.max(radius, 1) * margin) / Math.tan(((pc.fov * Math.PI) / 180) / 2);
    const up = Math.abs(d.clone().normalize().z) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    this.beginTween({
      from: { off: this.camOff(), target: this.controls.target.clone(), up: this.camera.up.clone(), zoom: pc.zoom },
      to: { off: d.normalize().multiplyScalar(dist), target: new THREE.Vector3(center.x, center.y, center.z), up, zoom: pc.zoom },
      dur: seconds,
    });
  }

  /** Like `aim`, but frames the drawn geometry itself (the parts as posed now; only bodies in `bodyIds` when given):
   *  its silhouette, projected vertex by vertex, fills `rect` (fractions of the window: left, top, right, bottom,
   *  y down) on its tighter side and is centred in it. Returns false when there is nothing to frame. */
  aimFit(dir: { x: number; y: number; z: number }, rect: [number, number, number, number], seconds = 0.5, bodyIds?: Set<string> | null): boolean {
    if (this.lastData?.mode === "sketch") return false;
    const d = new THREE.Vector3(dir.x, dir.y, dir.z);
    if (d.lengthSq() < 1e-12) return false;
    d.normalize();
    // the bodies' world-space vertices (a few tens of thousands are plenty for a silhouette)
    const animIds = new Map<THREE.Object3D, string>();
    for (const [id, { mesh }] of this.animMeshes) animIds.set(mesh, id);
    this.solidsGroup.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    this.solidsGroup.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.ghost) return;
      const id = (m.userData.bodyId as string | undefined) ?? animIds.get(m);
      if (bodyIds && (!id || !bodyIds.has(id))) return;
      meshes.push(m);
    });
    const total = meshes.reduce((n, m) => n + ((m.geometry.getAttribute("position") as THREE.BufferAttribute | undefined)?.count ?? 0), 0);
    if (!total) return false;
    const stride = Math.max(1, Math.ceil(total / 60000));
    const pts: THREE.Vector3[] = [];
    const box = new THREE.Box3();
    for (const m of meshes) {
      const pos = m.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i += stride) { const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); pts.push(p); box.expandByPoint(p); }
    }
    // the target rect in the canvas's NDC
    const cr = this.renderer.domElement.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
    const nx = (f: number) => ((f * W - cr.left) / cr.width) * 2 - 1, ny = (f: number) => -(((f * H - cr.top) / cr.height) * 2 - 1);
    const X0 = nx(rect[0]), X1 = nx(rect[2]), Y0 = ny(rect[3]), Y1 = ny(rect[1]);
    const CX = (X0 + X1) / 2, CY = (Y0 + Y1) / 2;
    // solve for the target and distance: zoom so the tighter side fits, then slide so the centre lands
    const cam = this.perspCam.clone();
    cam.aspect = cr.width / cr.height; cam.updateProjectionMatrix();
    const up = Math.abs(d.z) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const tanV = Math.tan(((cam.fov * Math.PI) / 180) / 2);
    const target = box.getCenter(new THREE.Vector3());
    let dist = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1) / tanV;
    const q = new THREE.Vector3(), right = new THREE.Vector3(), camUp = new THREE.Vector3();
    for (let it = 0; it < 24; it++) {
      cam.up.copy(up); cam.position.copy(target).addScaledVector(d, dist); cam.lookAt(target); cam.updateMatrixWorld(true);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) {
        q.copy(p).project(cam);
        if (q.z > 1 || q.z < -1) continue; // behind the camera or past the far plane
        x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
      }
      if (!(x0 < x1)) { dist *= 1.5; continue; }
      const s = Math.max((x1 - x0) / (X1 - X0), (y1 - y0) / (Y1 - Y0));
      // zooming scales the picture about the screen centre: put the centre at C·s now so it lands on C after
      right.setFromMatrixColumn(cam.matrixWorld, 0); camUp.setFromMatrixColumn(cam.matrixWorld, 1);
      const halfH = dist * tanV, halfW = halfH * cam.aspect;
      target.addScaledVector(right, ((x0 + x1) / 2 - CX * s) * halfW).addScaledVector(camUp, ((y0 + y1) / 2 - CY * s) * halfH);
      dist *= s;
      if (Math.abs(s - 1) < 1e-4 && Math.abs((x0 + x1) / 2 - CX) < 1e-4 && Math.abs((y0 + y1) / 2 - CY) < 1e-4) break;
    }
    const pc = this.perspCam;
    this.beginTween({
      from: { off: this.camOff(), target: this.controls.target.clone(), up: this.camera.up.clone(), zoom: pc.zoom },
      to: { off: d.clone().multiplyScalar(dist), target, up, zoom: pc.zoom },
      dur: seconds,
    });
    return true;
  }

  // ---- rendering the sketch ----

  /** The two-plate mould check's verdicts per body (by its position array), while the draft display is on. */
  private mouldVerdicts = new Map<Float32Array, Float32Array>();
  private mouldKey = "";

  /** Run (or reuse) the mould check for the bodies shown, when the draft display is on. */
  private refreshMould(data: ViewData) {
    const a = data.analysis;
    if (a?.mode !== "draft" || !data.solids?.length) { if (this.mouldVerdicts.size) { this.mouldVerdicts.clear(); this.mouldKey = ""; } return; }
    const list = data.solids.filter((s) => !s.variant && !s.reference);
    const key = `${a.pull.x},${a.pull.y},${a.pull.z}|${a.draftDeg}|${list.map((s) => s.id ?? "").join(",")}`;
    if (key === this.mouldKey && list.every((s) => this.mouldVerdicts.has(s.positions))) return;
    const flags = mouldFlags(list.map((s) => ({ positions: s.positions, indices: s.indices, normals: s.normals })), a.pull, a.draftDeg);
    this.mouldVerdicts = new Map(list.map((s, i) => [s.positions, flags[i]]));
    this.mouldKey = key;
  }

  update(data: ViewData) {
    this.lastData = data;
    this.refreshMould(data);
    this.planeGroup.visible = data.showPlanes && data.mode === "model";
    this.datumGroup.visible = data.showPlanes && data.mode === "model";
    if (data.gridSize) this.applyGrid(data.gridSize);
    this.grid.visible = data.showGrid;
    this.axes.visible = data.showAxes !== false;

    this.renderDatumPlanes(data.datumPlanes ?? []);
    this.clearGroup(this.sketchGroup);
    this.clearGroup(this.previewGroup);
    // posed parts (beginAnimation) are the view until endAnimation, which redraws from lastData
    if (!this.animating) this.clearGroup(this.solidsGroup);
    this.clearGroup(this.ghostGroup);
    this.clearGroup(this.regionGroup);
    this.clearGroup(this.previewSolidGroup);

    // Other sketches stay visible on their planes, dimmed (Fusion-style); posed with their components while animating.
    for (const g of data.ghostSketches ?? []) this.renderGhostSketch(g.sketch, g.plane);
    for (const g of data.sweepGuides ?? []) this.renderSweepGuide(g);
    if (this.animating) this.poseGhostSketches();

    // Extrude session: pickable, highlightable region fills.
    if (data.extrudeRegions) this.renderExtrudeRegions(data.extrudeRegions);
    if (data.extrudePreview) this.renderExtrudePreview(data.extrudePreview);

    // Section cut: a clip plane applied to every solid, with a filled cap on
    // the cut faces (Fusion-style). Only in model mode.
    this.clipPlane = data.mode === "model" && data.section ? sectionPlane(data.section) : null;

    // Solids render in model mode (and faded while sketching).
    if (!this.animating) {
      this.solidsGroup.visible = !!data.solids && data.solids.length > 0;
      this.updateSeq++;
      if (data.solids) data.solids.forEach((s, i) => this.renderSolid(s, data.mode === "sketch" || !!s.ghost, i));
      this.sweepGeometries();
    }

    if (data.sketch && data.plane) {
      this.renderSketch(data.sketch, data.plane, data);
      if (data.preview) this.renderPreview(data.preview, data.plane);
    }
    if (this.fades.size) this.applyFades(); // what was just redrawn keeps its fade
    this.invalidate();
  }

  /** The material for a surface-quality display mode, or null to draw normally. */
  private analysisMaterial(a: AnalysisView, s: SolidView, geo: THREE.BufferGeometry): THREE.Material | null {
    // The GLSL is shared with the lens's masked pass (viewport/analysisShaders.ts).
    if (a.mode === "zebra") {
      return new THREE.ShaderMaterial({
        uniforms: { stripes: { value: Math.max(2, a.stripes) } },
        vertexShader: WORLD_VERT,
        fragmentShader: zebraFrag(),
        side: THREE.DoubleSide,
      });
    }
    if (a.mode === "draft") {
      const p = new THREE.Vector3(a.pull.x, a.pull.y, a.pull.z).normalize();
      const verdict = this.mouldVerdicts.get(s.positions);
      if (verdict) geo.setAttribute("mould", new THREE.BufferAttribute(verdict, 1)); else if (geo.getAttribute("mould")) geo.deleteAttribute("mould");
      return new THREE.ShaderMaterial({
        uniforms: { pull: { value: p }, draft: { value: Math.sin((a.draftDeg * Math.PI) / 180) } },
        vertexShader: WORLD_VERT,
        fragmentShader: draftFrag(),
        side: THREE.DoubleSide,
      });
    }
    if (a.mode === "curvature" && s.curvature && s.curvature.length === (s.positions.length / 3) * 2) {
      geo.setAttribute("color", new THREE.BufferAttribute(curvatureColors(s.curvature, a.quantity), 3));
      return new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.6, side: THREE.DoubleSide });
    }
    return null;
  }

  // ---- display geometry, kept across view updates ----
  // The view is rebuilt from the store on every change (a hover, a selection, one
  // slider tick): a body whose mesh arrays are the same objects as last time keeps
  // its BufferGeometry, so its GPU buffers aren't re-uploaded. What an update
  // didn't use is disposed right after it.
  private geoCache = new Map<Float32Array, { geo: THREE.BufferGeometry; used: number }>();
  private updateSeq = 0;

  private solidGeometry(s: SolidView): THREE.BufferGeometry {
    let hit = this.geoCache.get(s.positions);
    if (!hit || hit.geo.getIndex()?.array !== s.indices) {
      const geo = solidGeometry(s); // the module builder: positions, normals, index, and paper's sheet UVs
      geo.userData.cached = true;
      hit?.geo.dispose();
      hit = { geo, used: 0 };
      this.geoCache.set(s.positions, hit);
    }
    hit.used = this.updateSeq;
    return hit.geo;
  }
  private edgeGeometry(edges: Float32Array): THREE.BufferGeometry {
    let hit = this.geoCache.get(edges);
    if (!hit) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(edges, 3));
      geo.userData.cached = true;
      hit = { geo, used: 0 };
      this.geoCache.set(edges, hit);
    }
    hit.used = this.updateSeq;
    return hit.geo;
  }
  /** Dispose the geometries the last update didn't use (their bodies are gone or re-meshed). */
  private sweepGeometries() {
    for (const [k, v] of this.geoCache) if (v.used !== this.updateSeq) { v.geo.dispose(); this.geoCache.delete(k); }
  }
  // The plain body and edge materials, by look: one of each, not one per body per update.
  private plainMaterial(color: number, faded: boolean): THREE.Material {
    const key = `p:${color}:${faded}`;
    let m = this.matCache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.5, side: THREE.DoubleSide, transparent: faded, opacity: faded ? 0.25 : 1 });
      m.userData.cached = true; this.matCache.set(key, m);
    }
    return m;
  }
  private edgeMaterial(faded: boolean): THREE.Material {
    const key = `e:${faded}`;
    let m = this.matCache.get(key);
    if (!m) {
      m = new THREE.LineBasicMaterial({ color: 0x20242e, transparent: faded, opacity: faded ? 0.3 : 1 });
      m.userData.cached = true; this.matCache.set(key, m);
    }
    return m;
  }

  private renderSolid(s: SolidView, faded: boolean, index: number) {
    const geo = this.solidGeometry(s);
    if (geo.getAttribute("color")) geo.deleteAttribute("color"); // a curvature display's colours, from an earlier update
    if (this.lastData?.analysis?.mode !== "draft" && geo.getAttribute("mould")) geo.deleteAttribute("mould"); // a mould check's verdicts, likewise
    // a texture wrapped round the part needs its wrap coordinates (cached per mesh); another material, none
    if (wrapsTexture(s.material)) { if (!geo.getAttribute("aWrap")) addWrapCoords(geo, s.positions, s.normals, s.material); }
    else if (geo.getAttribute("aWrap")) geo.deleteAttribute("aWrap");
    const clip = this.clipPlane ? [this.clipPlane] : null;
    // In section view each body gets its own colour so parts read apart; the
    // normal (un-sectioned) view keeps the assigned material, else a uniform tint.
    const color = clip ? bodyColor(index) : 0x7b86e0;
    let mat: THREE.Material;
    const analysis = this.lastData?.analysis;
    const analysisMat = !s.variant && !s.reference && !faded && !clip && analysis && analysis.mode !== "none" ? this.analysisMaterial(analysis, s, geo) : null; // a variant ghost or a reference part never carries analysis
    if (s.variant) {
      // A compared design variant: translucent in the kit's ghost accent, drawn without writing depth so the real part stays legible through it.
      mat = new THREE.MeshStandardMaterial({ color: COLORS().variant, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide, transparent: true, opacity: 0.28, depthWrite: false, clippingPlanes: clip ?? undefined });
    } else if (s.reference) {
      mat = referenceMaterial(s, faded, clip);
    } else if (analysisMat) {
      mat = analysisMat;
    } else if (s.material && !clip) {
      mat = this.materialFor(s);
      (mat as THREE.MeshStandardMaterial).transparent = faded;
      (mat as THREE.MeshStandardMaterial).opacity = faded ? 0.25 : 1;
    } else if (clip) {
      mat = new THREE.MeshStandardMaterial({
        color, metalness: 0.15, roughness: 0.5, side: THREE.DoubleSide,
        transparent: faded, opacity: faded ? 0.25 : 1, clippingPlanes: clip,
      });
    } else {
      mat = this.plainMaterial(color, faded);
    }
    const mesh = new THREE.Mesh(geo, mat);
    if (s.ghost || s.variant) mesh.userData.ghost = true; // drawn, but never picked
    if (s.reference) mesh.userData.reference = true; // see-through: a pick goes past it to a part behind
    if (s.id) mesh.userData.bodyId = s.id; // so a face pick names its body
    if (s.id) mesh.userData.fadeKey = s.id; // fadeBodies
    this.solidsGroup.add(mesh);
    if (analysis?.combs && s.combs?.length && !faded) {
      const cg = new THREE.BufferGeometry();
      cg.setAttribute("position", new THREE.BufferAttribute(s.combs, 3));
      this.solidsGroup.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0xff8a3d, depthTest: false, transparent: true, opacity: 0.85 })));
    }

    // Section cap for THIS body: a stencil pass marks where the clip plane cuts
    // its material (back faces increment, front decrement), then a coloured quad
    // fills those pixels and resets the stencil so the next body starts clean.
    if (clip && !s.variant && !s.reference) { // a variant ghost or reference part gets no section cap: it is see-through by design
      const base = 10 + index * 3;
      for (const [side, op] of [[THREE.BackSide, THREE.IncrementWrapStencilOp], [THREE.FrontSide, THREE.DecrementWrapStencilOp]] as const) {
        const sm = new THREE.MeshBasicMaterial({ depthWrite: false, depthTest: false, colorWrite: false, clippingPlanes: clip });
        sm.stencilWrite = true;
        sm.stencilFunc = THREE.AlwaysStencilFunc;
        sm.side = side;
        sm.stencilFail = op; sm.stencilZFail = op; sm.stencilZPass = op;
        const stencilMesh = new THREE.Mesh(geo, sm);
        stencilMesh.renderOrder = base;
        this.solidsGroup.add(stencilMesh);
      }
      this.addSectionCap(this.clipPlane!, s, tint(color), base + 1, index);
    }

    if (s.edges.length) {
      const egeo = this.edgeGeometry(s.edges);
      const eseg = new THREE.LineSegments(
        egeo,
        s.variant
          ? new THREE.LineDashedMaterial({ color: COLORS().variant, dashSize: 1.5, gapSize: 1, transparent: true, opacity: 0.85, clippingPlanes: clip ?? undefined }) // variant ghost: dashed accent edges
          : s.reference ? referenceEdgeMaterial(s, faded, clip)
          : s.material?.kind === "paper" && !clip
            ? paperEdgeMaterial(faded)
            : clip ? new THREE.LineBasicMaterial({ color: 0x20242e, transparent: faded, opacity: faded ? 0.3 : 1, clippingPlanes: clip })
            : this.edgeMaterial(faded)
      );
      if (s.variant) { eseg.computeLineDistances(); eseg.userData.ghost = true; } // dashes need distances; the lens skips ghosts
      if (s.reference) eseg.userData.reference = true; // the lens skips a reference part too
      eseg.userData.edges = true; // the body's B-rep edges (the lens redraws these)
      if (s.id) eseg.userData.fadeKey = s.id;
      this.solidsGroup.add(eseg);
    }
    if (s.paper && !clip && !s.reference && !s.variant) for (const o of paperOverlay(s.paper, this.lineResolution(), faded, this.materialFor(s), paperTint(s))) this.solidsGroup.add(o);

    for (const d of s.threadDecals ?? []) {
      const sleeve = this.renderThreadSleeve(d, color, faded);
      if (sleeve && s.id) sleeve.userData.fadeKey = s.id;
    }
  }

  /** Draw a cosmetic thread: a cylindrical sleeve on the body's surface shaded by
   *  a procedural thread normal map (so the solid itself stays a plain cylinder). */
  private renderThreadSleeve(d: ThreadDecal, color: number, faded: boolean): THREE.Mesh | undefined {
    const axis = new THREE.Vector3(d.axis.x, d.axis.y, d.axis.z);
    if (axis.lengthSq() < 1e-9) return;
    axis.normalize();
    const eps = 0.02;
    const r = d.internal ? Math.max(0.05, d.radius - eps) : d.radius + eps;
    const geo = new THREE.CylinderGeometry(r, r, d.length, 96, 1, true);
    geo.translate(0, d.length / 2, 0); // base at y=0

    const key = `${d.form}|${d.pitch}|${d.radius}|${d.length}|${d.starts ?? 1}|${d.leftHand ? "L" : "R"}|${d.internal ? "I" : "E"}`;
    let tex = this.threadTexCache.get(key);
    if (!tex) { tex = makeThreadNormalMap(d); this.threadTexCache.set(key, tex); }
    const k = Math.min(2.2, Math.max(0.7, ((tex.userData.depth as number) / d.pitch) * 4));
    const mat = new THREE.MeshStandardMaterial({
      color, metalness: 0.2, roughness: 0.55,
      normalMap: tex, normalScale: new THREE.Vector2(k, k),
      side: d.internal ? THREE.BackSide : THREE.FrontSide,
      transparent: faded, opacity: faded ? 0.25 : 1,
      clippingPlanes: this.clipPlane ? [this.clipPlane] : undefined,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    mesh.position.set(d.at.x, d.at.y, d.at.z);
    mesh.renderOrder = 1;
    this.solidsGroup.add(mesh);
    return mesh;
  }

  /** A filled quad over one body's cut, visible only where that body's stencil
   *  is non-zero. Sized to the body and coloured to match it, and cross-hatched as
   *  a drawing's section is (so the cut reads as solid material, not a surface):
   *  45° lines, the next body's at another angle (HATCH_ANGLES) so parts that touch read apart.
   *  Drawing it resets the stencil to 0 so the next body's cap is independent. */
  private addSectionCap(plane: THREE.Plane, s: SolidView, color: number, renderOrder: number, index: number) {
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const p = s.positions;
    for (let i = 0; i < p.length; i += 3) {
      lo.min(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
      hi.max(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
    }
    const ctr = lo.clone().add(hi).multiplyScalar(0.5);
    const size = lo.distanceTo(hi) * 1.2 || 200;
    const capMat = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.75, side: THREE.DoubleSide });
    hatch(capMat, Math.min(5, Math.max(0.5, lo.distanceTo(hi) / 45)), HATCH_ANGLES[index % HATCH_ANGLES.length]);
    capMat.stencilWrite = true;
    capMat.stencilRef = 0;
    capMat.stencilFunc = THREE.NotEqualStencilFunc;
    capMat.stencilFail = THREE.ReplaceStencilOp; capMat.stencilZFail = THREE.ReplaceStencilOp; capMat.stencilZPass = THREE.ReplaceStencilOp;
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(size, size), capMat);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal);
    cap.position.copy(ctr.clone().sub(plane.normal.clone().multiplyScalar(plane.distanceToPoint(ctr))));
    cap.renderOrder = renderOrder;
    this.solidsGroup.add(cap);
  }

  get currentData() {
    return this.lastData;
  }

  private clearGroup(g: THREE.Group) {
    const keep = (x: THREE.Material) => !!x.userData?.cached; // cached materials are reused across frames
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse((o) => { // nested groups too (a ghost sketch's group, an animated component's)
        const geo = (o as any).geometry as THREE.BufferGeometry | undefined;
        if (geo && !geo.userData?.cached) geo.dispose?.(); // cached geometries are reused across frames (see solidGeometry)
        const m = (o as any).material;
        if (Array.isArray(m)) m.forEach((x) => { if (!keep(x)) x.dispose(); });
        else if (m && !keep(m)) m.dispose?.();
        const orig = o.userData?.fadeOrig as THREE.Material | undefined; // a faded object's own material: what it's put back to
        if (orig && !keep(orig)) orig.dispose();
      });
    }
  }

  // Per-body / per-spec material cache so the procedural shaders aren't rebuilt
  // on every frame (e.g. during a slider drag). Wood keeps one material per body
  // and updates its grain-frame uniforms in place, so grain travels with a part.
  private matCache = new Map<string, THREE.Material>();
  /** While animating: each body's mesh and edge lines, by body id (for setAnimationMesh). */
  private animMeshes = new Map<string, { mesh: THREE.Mesh; lines: THREE.LineSegments; solid: SolidView; componentId: string; paper?: THREE.Object3D[]; ghost?: { mat: THREE.Material; edge: THREE.Material; mesh: THREE.MeshStandardMaterial; lines: THREE.LineBasicMaterial } }>();
  // ---- transform-driven animation (turntable / mechanism recording) ----

  /** Begin animation: build `bodies` into per-component groups (world-baked at the
   *  build pose), remembering each component's build-pose world so a later frame
   *  can MOVE the component by a delta matrix instead of rebuilding geometry. */
  beginAnimation(bodies: { solid: SolidView; componentId: string }[], buildWorld: Map<string, Rigid>, live = false) {
    this.endAnimation();
    this.animating = true;
    this.recording = !live; // live: the normal loop keeps rendering (and the camera keeps moving) while poses change
    this.invalidate();
    this.clearGroup(this.solidsGroup);
    this.animGroups.clear(); this.animBuildInv.clear(); this.animWood = []; this.animMeshes.clear(); this.animDeltas.clear();
    this.solidsGroup.visible = true;
    // every component's build-pose world, bodies or not: a component's sketches move with it too
    for (const [cid, W] of buildWorld) this.animBuildInv.set(cid, rigidMat(W).invert());
    for (const { solid, componentId } of bodies) {
      let g = this.animGroups.get(componentId);
      if (!g) {
        g = new THREE.Group(); g.matrixAutoUpdate = false;
        this.animGroups.set(componentId, g); this.solidsGroup.add(g);
        const W = buildWorld.get(componentId);
        this.animBuildInv.set(componentId, (W ? rigidMat(W) : new THREE.Matrix4()).invert());
      }
      const geo = solidGeometry(solid);
      addWrapCoords(geo, solid.positions, solid.normals, solid.material);
      const mat = solid.reference ? referenceMaterial(solid, false, null)
        : solid.material ? this.materialFor(solid) : new THREE.MeshStandardMaterial({ color: 0x7b86e0, metalness: 0.15, roughness: 0.5, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      g.add(mesh);
      const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(solid.edges, 3));
      const lines = new THREE.LineSegments(eg, solid.reference ? referenceEdgeMaterial(solid, false, null) : solid.material?.kind === "paper" ? paperEdgeMaterial(false) : new THREE.LineBasicMaterial({ color: 0x20242e }));
      g.add(lines);
      const paper = solid.paper && !solid.reference ? paperOverlay(solid.paper, this.lineResolution(), false, mat, paperTint(solid)) : [];
      for (const o of paper) g.add(o);
      if (solid.id) { this.animMeshes.set(solid.id, { mesh, lines, solid, componentId, paper }); mesh.userData.fadeKey = solid.id; lines.userData.fadeKey = solid.id; }
      if (solid.material?.kind === "wood" && solid.woodFrame) {
        this.animWood.push({ mat, axis: new THREE.Vector3(...solid.woodFrame.axis), pith: new THREE.Vector3(...solid.woodFrame.pith), cid: componentId });
      }
    }
    if (this.fades.size) this.applyFades(); // the posed parts keep their fades
  }

  /** Move every component to the given world pose (applied as a delta from its
   *  build pose), carrying the wood grain frame along so grain doesn't swim. */
  setAnimationPose(world: Map<string, Rigid>) {
    this.invalidate();
    const deltas = this.animDeltas;
    deltas.clear();
    for (const [cid, inv] of this.animBuildInv) {
      const Wr = world.get(cid);
      const W = Wr ? rigidMat(Wr) : new THREE.Matrix4();
      deltas.set(cid, W.multiply(inv)); // delta = Wp · inv(Wbuild)
    }
    for (const [cid, g] of this.animGroups) { g.matrix.copy(deltas.get(cid)!); g.updateMatrixWorld(true); }
    this.poseGhostSketches();
    for (const w of this.animWood) {
      const G = deltas.get(w.cid); if (!G) continue;
      const u = w.mat.userData.woodUniforms as { uAxis: { value: THREE.Vector3 }; uPith: { value: THREE.Vector3 } } | undefined;
      if (u) { u.uPith.value.copy(w.pith).applyMatrix4(G); u.uAxis.value.copy(w.axis).transformDirection(G); }
    }
  }

  /** Carry each component's dimmed sketches along with its posed bodies (they're drawn at the build pose). */
  private poseGhostSketches() {
    for (const g of this.ghostGroup.children) {
      const cid = g.userData.componentId as string | null | undefined;
      const G = cid != null ? this.animDeltas.get(cid) : undefined;
      if (G) g.matrix.copy(G); else g.matrix.identity();
      g.updateMatrixWorld(true);
    }
  }

  /** While animating: draw the bodies of `componentIds` see-through, in the reference-part look, `k` of the way
   *  there (0 as built, 1 the reference look), so the parts inside them show (the demo ghosts a cover to show the
   *  works behind it). Display only; the others go back to as built. */
  setAnimationGhost(componentIds: Iterable<string>, k: number) {
    const ids = new Set(componentIds);
    for (const a of this.animMeshes.values()) {
      const on = k > 0 && ids.has(a.componentId);
      if (!on) { this.unghost(a); continue; }
      if (!a.ghost) {
        a.ghost = { mat: a.mesh.material as THREE.Material, edge: a.lines.material as THREE.Material, mesh: referenceMaterial(a.solid, false, null), lines: referenceEdgeMaterial(a.solid, false, null) };
        a.mesh.material = a.ghost.mesh; a.lines.material = a.ghost.lines;
      }
      a.ghost.mesh.opacity = 1 + (0.22 - 1) * k; // referenceMaterial's own opacities at k = 1
      a.ghost.lines.opacity = 1 + (0.7 - 1) * k;
    }
    this.invalidate();
  }
  private unghost(a: { mesh: THREE.Mesh; lines: THREE.LineSegments; ghost?: { mat: THREE.Material; edge: THREE.Material; mesh: THREE.Material; lines: THREE.Material } }) {
    if (!a.ghost) return;
    a.mesh.material = a.ghost.mat; a.lines.material = a.ghost.edge;
    a.ghost.mesh.dispose(); a.ghost.lines.dispose();
    delete a.ghost;
  }

  /** Swap one animated body's geometry (its id, in its build-pose frame): a sheet folding in steps
   *  reshapes as it poses (sequenceMesh), where a joint only moves a part. */
  setAnimationMesh(id: string, m: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Float32Array; uvs?: Float32Array; paper?: PaperOverlay }) {
    const a = this.animMeshes.get(id);
    if (!a) return;
    a.mesh.geometry.dispose();
    a.mesh.geometry = solidGeometry(m);
    a.lines.geometry.dispose();
    const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(m.edges, 3));
    a.lines.geometry = eg;
    if (m.paper && a.paper?.length) {
      const [outline, shadow, bends, dark, light] = a.paper as [LineSegments2, THREE.Mesh, THREE.Mesh, LineSegments2, LineSegments2];
      outline.geometry.dispose(); outline.geometry = new LineSegmentsGeometry().setPositions(m.paper.outline);
      shadow.geometry.dispose(); shadow.geometry = shadowGeometry(m.paper);
      bends.geometry.dispose(); bends.geometry = bendGeometry(m.paper);
      dark.geometry.dispose(); dark.geometry = new LineSegmentsGeometry().setPositions(m.paper.marks.dark);
      light.geometry.dispose(); light.geometry = new LineSegmentsGeometry().setPositions(m.paper.marks.light);
    }
  }

  /** The canvas size, for screen-space line widths (LineMaterial). */
  private lineResolution(): THREE.Vector2 { return this.renderer.getSize(new THREE.Vector2()); }

  /** Set an exact output size (pixelRatio 1) for recording, so captured frames
   *  match the encoder dimensions. The ResizeObserver restores the view size later. */
  configureRecording(w: number, h: number) {
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.perspCam.aspect = w / h; this.perspCam.updateProjectionMatrix();
  }

  /** Snapshot what a recording changes — the live camera's pose and field of view,
   *  the canvas size and pixel ratio, overlay visibility — switch to the perspective
   *  camera with overlays hidden, and return a function that puts it all back, so a
   *  capture leaves the user's view as it was. */
  captureSession(): () => void {
    const cam = this.perspCam;
    const saved = { camera: this.camera, pos: cam.position.clone(), quat: cam.quaternion.clone(), up: cam.up.clone(), fov: cam.fov };
    const restoreOverlays = this.hideOverlays();
    this.camera = cam;
    return () => {
      restoreOverlays();
      cam.position.copy(saved.pos); cam.quaternion.copy(saved.quat); cam.up.copy(saved.up); cam.fov = saved.fov;
      this.camera = saved.camera;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // configureRecording forced 1
      this.onResize();
      this.invalidate();
    };
  }

  /** Render one frame now (recorder-driven; the RAF loop is paused while recording). */
  renderFrame() { if (this.fading) this.applyFades(); this.fitNear(); this.renderer.render(this.scene, this.camera); }

  /** Keep the perspective camera's near plane in step with how far it stands off: a fixed 0.1 mm near
   *  plane leaves the depth buffer a fraction of a millimetre to tell surfaces apart 700 mm away, so
   *  close layers (folded paper, a part on a plate) flicker through each other. A 200th of the distance
   *  to the orbit target keeps them apart at any zoom and clips only what's hard against the lens. */
  private fitNear() {
    if (this.camera !== this.perspCam) return;
    const near = Math.min(50, Math.max(0.1, this.perspCam.position.distanceTo(this.controls.target) / 200));
    if (Math.abs(near - this.perspCam.near) <= this.perspCam.near * 0.05) return;
    this.perspCam.near = near;
    this.perspCam.updateProjectionMatrix();
  }

  /** The canvas the recorder reads VideoFrames from. */
  get recordCanvas(): HTMLCanvasElement { return this.renderer.domElement; }

  /** Draw the motion study's poses as see-through ghosts of the parts they move (the reference-part look: each
   *  body's own colour, translucent, not writing depth, its outline a deeper shade), over the live model, which
   *  stays as built. `poses` place components (only those a pose moves); `strength` fades the wake. It is called
   *  every frame while a study runs: each body's geometry is made once and shared by every pose, and each (trail
   *  slot, body)'s meshes are kept and only moved and faded, those not in this frame hidden. clearMotionGhosts
   *  frees them. */
  setMotionGhosts(bodies: { solid: SolidView; componentId: string }[], buildWorld: Map<string, Rigid>, poses: { world: Map<string, Rigid>; strength: number }[]) {
    const clip = this.clipPlane ? [this.clipPlane] : null; // cut where the model is cut
    const shown = new Set<string>();
    poses.forEach((pose, slot) => {
      bodies.forEach(({ solid, componentId }, i) => {
        const W = pose.world.get(componentId);
        if (!W) return;
        const key = solid.id ?? `#${i}`;
        let g = this.motionGeo.get(key);
        if (!g || g.src !== solid.positions) {
          if (g) { g.geo.dispose(); g.edges.dispose(); }
          const geo = solidGeometry(solid); geo.userData.cached = true;
          const edges = new THREE.BufferGeometry(); edges.setAttribute("position", new THREE.BufferAttribute(solid.edges, 3)); edges.userData.cached = true;
          g = { src: solid.positions, geo, edges };
          this.motionGeo.set(key, g);
        }
        const at = `${slot}|${key}`;
        let p = this.motionPool.get(at);
        if (!p) {
          p = { mesh: new THREE.Mesh(g.geo, referenceMaterial(solid, false, clip)), lines: new THREE.LineSegments(g.edges, referenceEdgeMaterial(solid, false, clip)) };
          for (const o of [p.mesh, p.lines]) {
            o.matrixAutoUpdate = false;
            o.userData.ghost = true; o.userData.motionGhost = true; // drawn, never picked; the lens passes it by
            o.renderOrder = 1; // over the solid parts, as the see-through parts are
            this.motionGroup.add(o);
          }
          this.motionPool.set(at, p);
        }
        const B = buildWorld.get(componentId);
        const delta = rigidMat(W).multiply((B ? rigidMat(B) : new THREE.Matrix4()).invert()); // posed = W · inv(Wbuild) · built
        p.mesh.geometry = g.geo; p.lines.geometry = g.edges;
        (p.mesh.material as THREE.MeshStandardMaterial).opacity = 0.3 * pose.strength;
        (p.lines.material as THREE.LineBasicMaterial).opacity = 0.8 * pose.strength;
        for (const o of [p.mesh, p.lines]) {
          (o.material as THREE.Material).clippingPlanes = clip;
          o.matrix.copy(delta); o.matrixWorldNeedsUpdate = true; o.visible = true;
        }
        shown.add(at);
      });
    });
    for (const [at, p] of this.motionPool) if (!shown.has(at)) { p.mesh.visible = false; p.lines.visible = false; }
    this.invalidate();
  }

  /** Take the motion ghosts away (the study ended, was stopped, or the ghosts were switched off). */
  clearMotionGhosts() {
    if (!this.motionGroup.children.length && !this.motionGeo.size) return;
    this.clearGroup(this.motionGroup);
    this.motionPool.clear();
    for (const g of this.motionGeo.values()) { g.geo.dispose(); g.edges.dispose(); }
    this.motionGeo.clear();
    this.invalidate();
  }

  /** How many ghost meshes the motion study is showing (for tests and the demo). */
  get motionGhostCount(): number { return this.motionGroup.children.filter((o) => (o as THREE.Mesh).isMesh && o.visible).length; }

  /** End animation and restore the normal solids view. */
  /** Fade bodies (by body id) and sketches (by sketch id) to `opacity` (0 hides, 1 is as normal) over `ms`, eased:
   *  display only, so nothing re-evaluates. Posed parts (beginAnimation) fade as they move; what update() redraws
   *  keeps its fade until fadeBodies sets it back to 1 or clearFades. A body faded to 0 is not pickable. */
  async fadeBodies(ids: string[], opacity: number, ms = 0): Promise<void> {
    if (opacity < 1) await this.warmFades(ids);
    this.fades.set(ids, opacity, ms, performance.now());
    this.applyFades();
  }
  /** Compile the see-through look of these bodies and sketches off the frame (the first transparent draw of a
   *  material would otherwise compile its shaders in the middle of a frame: a visible stall as a fade starts).
   *  fadeBodies does this itself; calling it ahead (while loading) takes even that wait out of the fade. */
  async warmFades(ids: string[]): Promise<void> {
    const want = new Set(ids), proxies = new THREE.Group(), warm = this.fadeWarm;
    const walk = (o: THREE.Object3D, key: string | undefined) => {
      key = (o.userData.fadeKey as string | undefined) ?? key;
      const m = (o as THREE.Mesh).material;
      if (key != null && want.has(key) && m && !Array.isArray(m) && !o.userData.fadeOrig && !warm.of.has(m.uuid)) {
        warm.of.add(m.uuid);
        const c = fadeMaterial(m);
        warm.mats.push(c);
        // a stand-in of the same kind on the same geometry, so the compiled program is the one the object will use
        const Kind = o.constructor as new (g: THREE.BufferGeometry, m: THREE.Material) => THREE.Object3D;
        proxies.add(new Kind((o as THREE.Mesh).geometry, c));
      }
      for (const ch of o.children) walk(ch, key);
    };
    walk(this.solidsGroup, undefined); walk(this.ghostGroup, undefined);
    if (!proxies.children.length) return;
    try { await this.renderer.compileAsync(proxies, this.camera, this.scene); } catch { /* compiled on first draw instead */ }
  }
  /** Put every faded body and sketch back at once (a new document: its ids mean other things). */
  clearFades() {
    for (const m of this.fadeWarm.mats) m.dispose();
    this.fadeWarm = { of: new Set(), mats: [] };
    if (!this.fades.size && !this.fading) return;
    this.fades.clear();
    this.applyFades();
  }
  private applyFades() {
    const now = performance.now();
    this.fades.apply([this.solidsGroup, this.ghostGroup], now);
    this.fading = this.fades.running(now);
    this.invalidate();
  }

  endAnimation() {
    if (!this.animating) return;
    this.animating = false;
    this.recording = false;
    for (const a of this.animMeshes.values()) this.unghost(a); // the materials the bodies were built with go with them
    this.clearGroup(this.solidsGroup);
    this.animGroups.clear(); this.animBuildInv.clear(); this.animWood = []; this.animMeshes.clear(); this.animDeltas.clear();
    if (this.lastData) this.update(this.lastData);
    this.invalidate();
  }

  private materialFor(s: SolidView): THREE.Material {
    const spec = s.material!;
    if (spec.kind === "wood") {
      const key = "w:" + (s.id ?? JSON.stringify(spec));
      let m = this.matCache.get(key);
      if (!m) { m = createMaterial(spec, s.woodFrame); m.userData.cached = true; this.matCache.set(key, m); }
      const u = m.userData.woodUniforms as { uAxis: { value: THREE.Vector3 }; uPith: { value: THREE.Vector3 } } | undefined;
      if (u && s.woodFrame) { u.uAxis.value.set(...s.woodFrame.axis); u.uPith.value.set(...s.woodFrame.pith); }
      return m;
    }
    const key = spec.kind + ":" + JSON.stringify(spec);
    let m = this.matCache.get(key);
    if (!m) { m = createMaterial(spec); m.userData.cached = true; this.matCache.set(key, m); }
    return m;
  }

  private worldPt(plane: WorkPlane, u: number, v: number) {
    const w = to3d(plane, u, v);
    return new THREE.Vector3(w.x, w.y, w.z);
  }

  private colorFor(id: string, data: ViewData, base: number, construction?: boolean) {
    if (data.selection.has(id)) return COLORS().selected;
    if (data.hover === id) return COLORS().hover;
    if (construction) return COLORS().construction;
    return base;
  }

  /** Draw a non-active sketch dimmed on its plane — curves only, no points,
   *  fills, dimensions or badges, and not pickable (it lives in its own group). */
  private renderGhostSketch(sk: Sketch, plane: WorkPlane) {
    const getPt = (id: string) => sk.entities[id] as SketchPoint | undefined;
    const color = COLORS().ghost;
    // one group per sketch, tagged with its component, so an animation moves it with that component's bodies
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.userData.componentId = sk.componentId ?? null;
    group.userData.fadeKey = sk.id; // fadeBodies
    this.ghostGroup.add(group);
    // Every plain curve of the sketch goes into one LineSegments (one draw call per
    // sketch, not one per curve); construction curves keep a dashed line each, since
    // a dash pattern runs along a polyline, not from segment to segment.
    const plain: THREE.Vector3[] = [];
    const strip = (pts: THREE.Vector3[]) => { for (let i = 0; i + 1 < pts.length; i++) plain.push(pts[i], pts[i + 1]); };
    const dashedLine = (pts: THREE.Vector3[]) => {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.6, transparent: true, opacity: 0.65 }));
      line.computeLineDistances();
      group.add(line);
    };
    const curve = (pts: THREE.Vector3[], construction?: boolean) => { if (construction) dashedLine(pts); else strip(pts); };
    for (const e of Object.values(sk.entities)) {
      if (e.kind === "line") {
        const a = getPt(e.p1), b = getPt(e.p2);
        if (!a || !b) continue;
        curve([this.worldPt(plane, a.x, a.y), this.worldPt(plane, b.x, b.y)], e.construction);
      } else if (e.kind === "circle") {
        const ctr = getPt(e.center); if (!ctr) continue;
        strip(this.arcPoints(plane, ctr.x, ctr.y, e.r, 0, Math.PI * 2, true));
      } else if (e.kind === "arc") {
        const ctr = getPt(e.center), a = getPt(e.p1), b = getPt(e.p2);
        if (!ctr || !a || !b) continue;
        const a1 = Math.atan2(a.y - ctr.y, a.x - ctr.x), a2 = Math.atan2(b.y - ctr.y, b.x - ctr.x);
        strip(this.arcPoints(plane, ctr.x, ctr.y, e.r, a1, a2, e.ccw));
      } else if (e.kind === "ellipse") {
        const ctr = getPt(e.center); if (!ctr) continue;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 72; i++) {
          const t = (i / 72) * Math.PI * 2;
          const ex = e.rx * Math.cos(t), ey = e.ry * Math.sin(t);
          const u = ctr.x + ex * Math.cos(e.rotation) - ey * Math.sin(e.rotation);
          const v = ctr.y + ex * Math.sin(e.rotation) + ey * Math.cos(e.rotation);
          pts.push(this.worldPt(plane, u, v));
        }
        curve(pts, e.construction);
      } else if (e.kind === "spline") {
        const through = e.points.map((id) => getPt(id)).filter((p) => !!p).map((p) => ({ x: p!.x, y: p!.y }));
        if (through.length < 2) continue;
        curve(sampleSpline(through, 10).map((p) => this.worldPt(plane, p.x, p.y)), e.construction);
      }
    }
    if (plain.length) group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(plain), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.65 })));
  }

  /** A 3D sweep's spine and its sections on it (its path sketch's ghost: faded, hidden and posed with that sketch). */
  private renderSweepGuide(g: SweepGuide) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.userData.componentId = g.componentId ?? null;
    group.userData.fadeKey = g.sketchId; // fadeBodies: the path sketch's
    this.ghostGroup.add(group);
    // screen-space thick lines (a plain line is one pixel wide, lost on a curved part): the spine bolder than the sections
    const color = COLORS().sweepGuide;
    const fat = (polylines: Vec3[][], linewidth: number, opacity: number) => {
      const pos: number[] = [];
      for (const pl of polylines) for (let i = 0; i + 1 < pl.length; i++) pos.push(pl[i].x, pl[i].y, pl[i].z, pl[i + 1].x, pl[i + 1].y, pl[i + 1].z);
      if (!pos.length) return;
      const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), new LineMaterial({ color, linewidth, transparent: true, opacity }));
      lines.renderOrder = 2; // over the see-through bodies they run through
      group.add(lines);
    };
    fat([g.spine], 2.5, 0.95);
    fat(g.sections.flat(), 1.6, 0.85);
  }

  /** Translucent extruded-prism preview of a pending extrude (built in JS, no kernel). */
  private renderExtrudePreview(data: NonNullable<ViewData["extrudePreview"]>) {
    const { plane, distance, symmetric, operation } = data;
    if (Math.abs(distance) < 1e-6) return;
    const d0 = symmetric ? -distance / 2 : 0;
    const d1 = symmetric ? distance / 2 : distance;
    const n = plane.normal;
    const at = (u: number, v: number, depth: number) => {
      const w = this.worldPt(plane, u, v);
      return new THREE.Vector3(w.x + n.x * depth, w.y + n.y * depth, w.z + n.z * depth);
    };
    const color = operation === "cut" ? COLORS().extrudeCut : COLORS().extrudeJoin;
    for (const region of data.regions) {
      try {
        const loops = [region.outer, ...region.holes];
        const contour = region.outer.map((p) => new THREE.Vector2(p.x, p.y));
        const holeContours = region.holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)));
        const capFaces = THREE.ShapeUtils.triangulateShape(contour, holeContours);
        const capVerts = [...contour, ...holeContours.flat()];
        const positions: number[] = [];
        const indices: number[] = [];
        const push = (p: THREE.Vector3) => { positions.push(p.x, p.y, p.z); return positions.length / 3 - 1; };
        // bottom + top caps
        const bottomIdx = capVerts.map((v) => push(at(v.x, v.y, d0)));
        const topIdx = capVerts.map((v) => push(at(v.x, v.y, d1)));
        for (const f of capFaces) { indices.push(bottomIdx[f[0]], bottomIdx[f[2]], bottomIdx[f[1]]); indices.push(topIdx[f[0]], topIdx[f[1]], topIdx[f[2]]); }
        // side walls, loop by loop
        for (const loop of loops) {
          const b = loop.map((p) => push(at(p.x, p.y, d0)));
          const t = loop.map((p) => push(at(p.x, p.y, d1)));
          for (let i = 0; i < loop.length; i++) {
            const j = (i + 1) % loop.length;
            indices.push(b[i], b[j], t[j]);
            indices.push(b[i], t[j], t[i]);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(indices);
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
        mesh.renderOrder = 2;
        this.previewSolidGroup.add(mesh);
        // crisp outline on the top cap
        const edgePts: THREE.Vector3[] = [];
        for (const loop of loops) for (let i = 0; i < loop.length; i++) { edgePts.push(at(loop[i].x, loop[i].y, d1), at(loop[(i + 1) % loop.length].x, loop[(i + 1) % loop.length].y, d1)); }
        const eseg = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(edgePts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
        eseg.renderOrder = 3;
        this.previewSolidGroup.add(eseg);
      } catch {
        /* skip a region whose preview fails to triangulate */
      }
    }
  }

  /** Filled, pickable region overlays for the extrude session. */
  private renderExtrudeRegions(data: NonNullable<ViewData["extrudeRegions"]>) {
    for (let i = 0; i < data.regions.length; i++) {
      const reg = data.regions[i];
      try {
        const contour = reg.outer.map((p) => new THREE.Vector2(p.x, p.y));
        const holeContours = reg.holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)));
        const faces = THREE.ShapeUtils.triangulateShape(contour, holeContours);
        const all = [...contour, ...holeContours.flat()];
        const positions: number[] = [];
        for (const v of all) { const w = this.worldPt(data.plane, v.x, v.y); positions.push(w.x, w.y, w.z); }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(faces.flat());
        const mat = new THREE.MeshBasicMaterial({
          color: reg.selected ? COLORS().regionSelected : COLORS().regionIdle,
          transparent: true,
          opacity: reg.selected ? 0.42 : 0.2,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 3;
        mesh.userData = { kind: "region", interior: reg.interior };
        this.regionGroup.add(mesh);
      } catch {
        /* triangulation failed for this region — skip its fill */
      }
    }
  }

  /** Curvature combs on a sketch's splines, arcs and circles, in its plane:
   *  teeth point away from the centre of curvature, the longest a sixth of the
   *  sketch's size, joined tip to tip. */
  private renderSketchCombs(sk: Sketch, plane: WorkPlane) {
    const pt = (id: string) => sk.entities[id] as SketchPoint | undefined;
    const rows: { p: { x: number; y: number }; tooth: { x: number; y: number } }[][] = [];
    for (const e of Object.values(sk.entities)) {
      if (e.construction) continue;
      if (e.kind === "spline") {
        const through = e.points.map(pt).filter((p): p is SketchPoint => !!p);
        if (through.length >= 2) rows.push(splineCurvatureComb(through, 12));
      } else if (e.kind === "arc" || e.kind === "circle") {
        const c = pt(e.center);
        if (!c || !(e.r > 0)) continue;
        let a0 = 0, sweep = Math.PI * 2;
        if (e.kind === "arc") {
          const a = pt(e.p1), b = pt(e.p2);
          if (!a || !b) continue;
          a0 = Math.atan2(a.y - c.y, a.x - c.x);
          const a1 = Math.atan2(b.y - c.y, b.x - c.x);
          sweep = e.ccw ? ((a1 - a0 + 4 * Math.PI) % (2 * Math.PI)) : -((a0 - a1 + 4 * Math.PI) % (2 * Math.PI));
        }
        const row = [];
        for (let i = 0; i <= 24; i++) {
          const t = a0 + (sweep * i) / 24, d = { x: Math.cos(t), y: Math.sin(t) };
          row.push({ p: { x: c.x + d.x * e.r, y: c.y + d.y * e.r }, tooth: { x: d.x / e.r, y: d.y / e.r } });
        }
        rows.push(row);
      }
    }
    let maxK = 0, lo = { x: Infinity, y: Infinity }, hi = { x: -Infinity, y: -Infinity };
    for (const row of rows) for (const r of row) {
      maxK = Math.max(maxK, Math.hypot(r.tooth.x, r.tooth.y));
      lo = { x: Math.min(lo.x, r.p.x), y: Math.min(lo.y, r.p.y) }; hi = { x: Math.max(hi.x, r.p.x), y: Math.max(hi.y, r.p.y) };
    }
    if (!(maxK > 1e-9)) return;
    const scale = (Math.hypot(hi.x - lo.x, hi.y - lo.y) / 6 || 1) / maxK;
    const pts: THREE.Vector3[] = [];
    for (const row of rows) {
      const tips = row.map((r) => this.worldPt(plane, r.p.x + r.tooth.x * scale, r.p.y + r.tooth.y * scale));
      row.forEach((r, i) => {
        pts.push(this.worldPt(plane, r.p.x, r.p.y), tips[i]);
        if (i > 0) pts.push(tips[i - 1], tips[i]);
      });
    }
    const comb = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.85 }));
    comb.userData = { decor: true };
    this.sketchGroup.add(comb);
  }

  private renderSketch(sk: Sketch, plane: WorkPlane, data: ViewData) {
    const pts = sk.entities;
    const getPt = (id: string) => pts[id] as SketchPoint;

    // Fusion-style state color: blue = under-constrained, light = fully
    // constrained, red = conflicting.
    const baseColor =
      data.constraintState === "full"
        ? COLORS().geometry
        : data.constraintState === "conflict"
          ? COLORS().bad
          : COLORS().underConstrained;

    // shade closed profiles (what's extrudable) behind the curves
    this.renderProfileFill(sk, plane);

    // curves
    for (const e of Object.values(sk.entities)) {
      if (e.kind === "line") {
        const l = e as SketchLine;
        const a = getPt(l.p1);
        const b = getPt(l.p2);
        if (!a || !b) continue;
        const geo = new THREE.BufferGeometry().setFromPoints([
          this.worldPt(plane, a.x, a.y),
          this.worldPt(plane, b.x, b.y),
        ]);
        const color = this.colorFor(l.id, data, baseColor, l.construction);
        const mat = l.construction
          ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.6 })
          : new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(geo, mat);
        if (l.construction) line.computeLineDistances();
        line.userData = { id: l.id, kind: "line" };
        this.sketchGroup.add(line);
      } else if (e.kind === "circle") {
        const c = e as SketchCircle;
        const ctr = getPt(c.center);
        if (!ctr) continue;
        const line = this.makeArcLine(plane, ctr.x, ctr.y, c.r, 0, Math.PI * 2, true,
          this.colorFor(c.id, data, baseColor, c.construction));
        line.userData = { id: c.id, kind: "circle" };
        this.sketchGroup.add(line);
      } else if (e.kind === "arc") {
        const ar = e as SketchArc;
        const ctr = getPt(ar.center);
        const a = getPt(ar.p1);
        const b = getPt(ar.p2);
        if (!ctr || !a || !b) continue;
        const a1 = Math.atan2(a.y - ctr.y, a.x - ctr.x);
        const a2 = Math.atan2(b.y - ctr.y, b.x - ctr.x);
        const line = this.makeArcLine(plane, ctr.x, ctr.y, ar.r, a1, a2, ar.ccw,
          this.colorFor(ar.id, data, baseColor, ar.construction));
        line.userData = { id: ar.id, kind: "arc" };
        this.sketchGroup.add(line);
      } else if (e.kind === "ellipse") {
        const el = e as SketchEllipse;
        const ctr = getPt(el.center);
        if (!ctr) continue;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 72; i++) {
          const t = (i / 72) * Math.PI * 2;
          const ex = el.rx * Math.cos(t), ey = el.ry * Math.sin(t);
          const u = ctr.x + ex * Math.cos(el.rotation) - ey * Math.sin(el.rotation);
          const v = ctr.y + ex * Math.sin(el.rotation) + ey * Math.cos(el.rotation);
          pts.push(this.worldPt(plane, u, v));
        }
        const color = this.colorFor(el.id, data, baseColor, el.construction);
        const mat = el.construction
          ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.6 })
          : new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
        if (el.construction) line.computeLineDistances();
        line.userData = { id: el.id, kind: "ellipse" };
        this.sketchGroup.add(line);
      } else if (e.kind === "spline") {
        const through = e.points.map((id) => getPt(id)).filter((p) => !!p).map((p) => ({ x: p!.x, y: p!.y }));
        if (through.length < 2) continue;
        const pts = sampleSpline(through, 10).map((p) => this.worldPt(plane, p.x, p.y));
        const color = this.colorFor(e.id, data, baseColor, e.construction);
        const mat = e.construction
          ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.6 })
          : new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
        if (e.construction) line.computeLineDistances();
        line.userData = { id: e.id, kind: "spline" };
        this.sketchGroup.add(line);
      }
    }

    if (data.analysis?.combs) this.renderSketchCombs(sk, plane);

    // points (skip purely implicit endpoints unless hovered/selected? show all real ones)
    for (const e of Object.values(sk.entities)) {
      if (e.kind !== "point") continue;
      const pt = e as SketchPoint;
      const isOrigin = pt.id === sk.originPointId;
      const color = data.selection.has(pt.id)
        ? COLORS().selected
        : data.hover === pt.id
          ? COLORS().hover
          : isOrigin
            ? COLORS().origin
            : pt.fixed
              ? COLORS().point
              : baseColor;
      // Pixel-sized so markers stay constant on screen (the sketch layer
      // re-renders on zoom), rather than ballooning with the geometry.
      const geo = new THREE.SphereGeometry(this.pixelToWorld(isOrigin ? 5 : 4), 10, 10);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
      const w = this.worldPt(plane, pt.x, pt.y);
      mesh.position.copy(w);
      mesh.userData = { id: pt.id, kind: "point" };
      this.sketchGroup.add(mesh);
    }

    // dimension labels (always) + geometric constraint glyphs (toggleable)
    for (const c of Object.values(sk.constraints)) {
      if (isDimension(c)) {
        this.renderDimension(sk, plane, c as DimensionConstraint);
      } else if (data.showConstraints) {
        const badge = this.constraintBadge(sk, plane, c as unknown as Record<string, string>);
        if (badge) {
          const sprite = this.makeTextSprite(badge.glyph, COLORS().badgeText, 18);
          sprite.position.copy(badge.pos);
          this.sketchGroup.add(sprite);
        }
      }
    }
  }

  /** Shade the sketch's closed profile(s) so you can see what's extrudable. */
  private renderProfileFill(sk: Sketch, plane: WorkPlane) {
    let profile;
    try {
      profile = extractProfiles(sk);
    } catch {
      return;
    }
    if (!profile) return;
    try {
      const outer = this.loopToUV(profile.outer);
      if (outer.length < 3) return;
      const holes = profile.holes.map((h) => this.loopToUV(h)).filter((h) => h.length >= 3);
      const contour = outer.map((p) => new THREE.Vector2(p.x, p.y));
      const holeContours = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)));
      const faces = THREE.ShapeUtils.triangulateShape(contour, holeContours);
      const all = [...contour];
      holeContours.forEach((h) => all.push(...h));
      const positions: number[] = [];
      for (const v of all) {
        const w = this.worldPt(plane, v.x, v.y);
        positions.push(w.x, w.y, w.z);
      }
      const indices: number[] = [];
      faces.forEach((f) => indices.push(f[0], f[1], f[2]));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      const mat = new THREE.MeshBasicMaterial({
        color: COLORS().profileFill,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = -1;
      this.sketchGroup.add(mesh);
    } catch {
      /* triangulation failed for this profile — skip the fill */
    }
  }

  private loopToUV(loop: Loop): { x: number; y: number }[] {
    if (loop.circle) {
      const { center, r } = loop.circle;
      const out: { x: number; y: number }[] = [];
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        out.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
      }
      return out;
    }
    if (loop.ellipse) {
      const { center, rx, ry, rotation } = loop.ellipse;
      const out: { x: number; y: number }[] = [];
      for (let i = 0; i < 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
        out.push({ x: center.x + ex * Math.cos(rotation) - ey * Math.sin(rotation), y: center.y + ex * Math.sin(rotation) + ey * Math.cos(rotation) });
      }
      return out;
    }
    const out = [{ x: loop.start.x, y: loop.start.y }];
    let cur = loop.start;
    for (const seg of loop.segments) {
      if (seg.kind === "line") out.push({ x: seg.to.x, y: seg.to.y });
      else if (seg.kind === "spline") out.push(...sampleSpline(seg.through, 6).slice(1));
      else out.push(...this.sampleArcPoints(cur, seg.via, seg.to));
      cur = seg.to;
    }
    if (out.length > 1) out.pop(); // drop the duplicated closing point
    return out;
  }

  private sampleArcPoints(from: { x: number; y: number }, via: { x: number; y: number }, to: { x: number; y: number }, n = 14) {
    const c = circleFrom3(from, via, to);
    if (!c) return [{ x: to.x, y: to.y }];
    const norm = (a: number) => { while (a < 0) a += Math.PI * 2; while (a >= Math.PI * 2) a -= Math.PI * 2; return a; };
    const a0 = Math.atan2(from.y - c.y, from.x - c.x);
    const am = norm(Math.atan2(via.y - c.y, via.x - c.x) - a0);
    const a1span = norm(Math.atan2(to.y - c.y, to.x - c.x) - a0);
    const ccw = am <= a1span;
    const span = ccw ? a1span : -(Math.PI * 2 - a1span);
    const out: { x: number; y: number }[] = [];
    for (let i = 1; i <= n; i++) {
      const a = a0 + span * (i / n);
      out.push({ x: c.x + c.r * Math.cos(a), y: c.y + c.r * Math.sin(a) });
    }
    return out;
  }

  private static CONSTRAINT_GLYPH: Record<string, string> = {
    horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", collinear: "┈",
    equal: "=", coincident: "●", pointOnLine: "⊢", pointOnCircle: "◠",
    concentric: "◎", tangent: "◯", symmetric: "⇔", fix: "⚓", midpoint: "▷◁",
  };

  /** Anchor + glyph for a geometric constraint, offset slightly off the geometry. */
  private constraintBadge(sk: Sketch, plane: WorkPlane, c: Record<string, string>): { glyph: string; pos: THREE.Vector3 } | null {
    const glyph = SceneManager.CONSTRAINT_GLYPH[c.type];
    if (!glyph) return null;
    const P = (id: string) => sk.entities[id] as SketchPoint;
    const off = this.pixelToWorld(11);
    const at = (u: number, v: number) => this.worldPt(plane, u + off, v + off);
    try {
      if (c.type === "fix" || c.type === "pointOnLine" || c.type === "pointOnCircle" || c.type === "midpoint") {
        const p = P(c.point);
        return { glyph, pos: at(p.x, p.y) };
      }
      if (c.a && c.b) {
        const a = P(c.a), b = P(c.b);
        return { glyph, pos: at((a.x + b.x) / 2, (a.y + b.y) / 2) };
      }
      if (c.l1 && c.l2) {
        const l = sk.entities[c.l1] as SketchLine;
        const a = P(l.p1), b = P(l.p2);
        return { glyph, pos: at((a.x + b.x) / 2, (a.y + b.y) / 2) };
      }
      if (c.e1) {
        const e = sk.entities[c.e1];
        if (e.kind === "line") { const a = P(e.p1), b = P(e.p2); return { glyph, pos: at((a.x + b.x) / 2, (a.y + b.y) / 2) }; }
        const ctr = P((e as SketchCircle).center); return { glyph, pos: at(ctr.x, ctr.y) };
      }
      if (c.c1) { const ctr = P((sk.entities[c.c1] as SketchCircle).center); return { glyph, pos: at(ctr.x, ctr.y) }; }
    } catch {
      return null;
    }
    return null;
  }

  /** Render a dimension's full annotation: extension lines, dimension line,
   *  arrowheads and value, offset by the dimension's stored label position. */
  private renderDimension(sk: Sketch, plane: WorkPlane, c: DimensionConstraint) {
    const layout = this.dimLayout(sk, c);
    if (!layout) return;
    const color = COLORS().dimension;
    if (layout.lines.length) {
      const pts: THREE.Vector3[] = [];
      for (const [u1, v1, u2, v2] of layout.lines) pts.push(this.worldPt(plane, u1, v1), this.worldPt(plane, u2, v2));
      const seg = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
      seg.userData = { id: c.id, kind: "dimension" };
      seg.renderOrder = 4;
      this.sketchGroup.add(seg);
    }
    const labelPos = this.worldPt(plane, layout.text.x, layout.text.y);
    const sprite = this.makeTextSprite(this.dimensionLabel(c.type, c.value), COLORS().dimensionText);
    sprite.position.copy(labelPos);
    sprite.userData = { id: c.id, kind: "dimension", dimLabel: true };
    this.sketchGroup.add(sprite);
    // A larger invisible sprite makes the label a reliable grab target (the
    // visible label alone is small and competes with nearby geometry).
    const hit = new THREE.Sprite(new THREE.SpriteMaterial({ opacity: 0, transparent: true, depthWrite: false, depthTest: false }));
    hit.scale.set(sprite.scale.x * 1.5 + this.pixelToWorld(14), sprite.scale.y * 1.6, 1);
    hit.position.copy(labelPos);
    hit.userData = { id: c.id, kind: "dimension", dimLabel: true };
    hit.renderOrder = 999;
    this.sketchGroup.add(hit);
  }

  /** Mean of a sketch's point entities (used to push dimensions outward). */
  private sketchCentroid(sk: Sketch): { x: number; y: number } {
    let sx = 0, sy = 0, n = 0;
    for (const e of Object.values(sk.entities)) {
      if (e.kind === "point") { sx += (e as SketchPoint).x; sy += (e as SketchPoint).y; n++; }
    }
    return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
  }

  /** Compute a dimension's annotation geometry in sketch (u,v) space. */
  private dimLayout(sk: Sketch, c: DimensionConstraint): { lines: number[][]; text: { x: number; y: number } } | null {
    const P = (id?: string) => (id ? (sk.entities[id] as SketchPoint) : undefined);
    const px = (p: number) => this.pixelToWorld(p);
    const arrow = px(7), gap = px(4), ext = px(7);
    const lines: number[][] = [];
    const pushArrow = (tx: number, ty: number, pointAng: number) => {
      for (const s of [0.4, -0.4]) {
        const a = pointAng + Math.PI + s;
        lines.push([tx, ty, tx + Math.cos(a) * arrow, ty + Math.sin(a) * arrow]);
      }
    };
    try {
      if ((c.type === "distance" || c.type === "distanceX" || c.type === "distanceY") && c.a && c.b) {
        const A = P(c.a)!, B = P(c.b)!;
        let du: number, dv: number;
        if (c.type === "distanceX") { du = 1; dv = 0; }
        else if (c.type === "distanceY") { du = 0; dv = 1; }
        else { du = B.x - A.x; dv = B.y - A.y; const L = Math.hypot(du, dv) || 1; du /= L; dv /= L; }
        let pu = -dv, pv = du;
        const midx = (A.x + B.x) / 2, midy = (A.y + B.y) / 2;
        // Default: offset the dimension line outward (away from the sketch
        // centroid), so it clears the geometry like Fusion rather than sitting
        // on top of it. A dragged dimension (c.label set) overrides this.
        if (!c.label) {
          const ctr = this.sketchCentroid(sk);
          if ((ctr.x - midx) * pu + (ctr.y - midy) * pv > 0) { pu = -pu; pv = -pv; }
        }
        const lab = c.label ?? { x: midx + pu * px(28), y: midy + pv * px(28) };
        const off = (lab.x - A.x) * pu + (lab.y - A.y) * pv;
        const A2x = A.x + pu * off, A2y = A.y + pv * off;
        const B2x = B.x + pu * off, B2y = B.y + pv * off;
        const sgn = off >= 0 ? 1 : -1;
        lines.push([A.x + pu * gap * sgn, A.y + pv * gap * sgn, A2x + pu * ext * sgn, A2y + pv * ext * sgn]);
        lines.push([B.x + pu * gap * sgn, B.y + pv * gap * sgn, B2x + pu * ext * sgn, B2y + pv * ext * sgn]);
        lines.push([A2x, A2y, B2x, B2y]);
        const ang = Math.atan2(B2y - A2y, B2x - A2x);
        pushArrow(A2x, A2y, ang + Math.PI);
        pushArrow(B2x, B2y, ang);
        return { lines, text: { x: (A2x + B2x) / 2 + pu * px(5), y: (A2y + B2y) / 2 + pv * px(5) } };
      }
      if ((c.type === "radius" || c.type === "diameter") && c.circle) {
        const e = sk.entities[c.circle] as SketchCircle | SketchArc;
        const C = P(e.center)!;
        const lab = c.label ?? { x: C.x + e.r * 0.7, y: C.y + e.r * 0.7 };
        let du = lab.x - C.x, dv = lab.y - C.y; const L = Math.hypot(du, dv) || 1; du /= L; dv /= L;
        const ex = C.x + du * e.r, ey = C.y + dv * e.r;
        if (c.type === "radius") {
          lines.push([C.x, C.y, ex, ey]);
          pushArrow(ex, ey, Math.atan2(dv, du));
          return { lines, text: { x: C.x + du * e.r * 0.55, y: C.y + dv * e.r * 0.55 } };
        }
        const x0 = C.x - du * e.r, y0 = C.y - dv * e.r;
        lines.push([x0, y0, ex, ey]);
        pushArrow(ex, ey, Math.atan2(dv, du));
        pushArrow(x0, y0, Math.atan2(-dv, -du));
        return { lines, text: { x: C.x + du * e.r * 0.5, y: C.y + dv * e.r * 0.5 } };
      }
      if (c.type === "pointLineDistance" && c.point && c.line) {
        const Pp = P(c.point)!; const l = sk.entities[c.line] as SketchLine;
        const A = P(l.p1)!, B = P(l.p2)!;
        let du = B.x - A.x, dv = B.y - A.y; const L = Math.hypot(du, dv) || 1; du /= L; dv /= L;
        const t = (Pp.x - A.x) * du + (Pp.y - A.y) * dv;
        const Fx = A.x + du * t, Fy = A.y + dv * t;
        lines.push([Fx, Fy, Pp.x, Pp.y]);
        const ang = Math.atan2(Pp.y - Fy, Pp.x - Fx);
        pushArrow(Pp.x, Pp.y, ang);
        pushArrow(Fx, Fy, ang + Math.PI);
        return { lines, text: { x: (Fx + Pp.x) / 2, y: (Fy + Pp.y) / 2 } };
      }
      if (c.type === "angle" && c.l1 && c.l2) {
        const l1 = sk.entities[c.l1] as SketchLine, l2 = sk.entities[c.l2] as SketchLine;
        const A1 = P(l1.p1)!, B1 = P(l1.p2)!, A2 = P(l2.p1)!, B2 = P(l2.p2)!;
        let d1x = B1.x - A1.x, d1y = B1.y - A1.y;
        let d2x = B2.x - A2.x, d2y = B2.y - A2.y;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-9) return null;
        const tt = ((A2.x - A1.x) * d2y - (A2.y - A1.y) * d2x) / denom;
        const Vx = A1.x + d1x * tt, Vy = A1.y + d1y * tt;
        const lab = c.label ?? { x: Vx + px(30), y: Vy + px(30) };
        if ((lab.x - Vx) * d1x + (lab.y - Vy) * d1y < 0) { d1x = -d1x; d1y = -d1y; }
        if ((lab.x - Vx) * d2x + (lab.y - Vy) * d2y < 0) { d2x = -d2x; d2y = -d2y; }
        const n1 = Math.hypot(d1x, d1y) || 1, n2 = Math.hypot(d2x, d2y) || 1;
        const a1 = Math.atan2(d1y, d1x), a2 = Math.atan2(d2y, d2x);
        const R = Math.max(px(18), Math.min(Math.hypot(lab.x - Vx, lab.y - Vy), px(140)));
        let span = a2 - a1; while (span <= -Math.PI) span += 2 * Math.PI; while (span > Math.PI) span -= 2 * Math.PI;
        let prev: [number, number] | null = null;
        for (let i = 0; i <= 24; i++) {
          const a = a1 + span * (i / 24);
          const pu = Vx + Math.cos(a) * R, pv = Vy + Math.sin(a) * R;
          if (prev) lines.push([prev[0], prev[1], pu, pv]);
          prev = [pu, pv];
        }
        lines.push([Vx, Vy, Vx + (d1x / n1) * R, Vy + (d1y / n1) * R]);
        lines.push([Vx, Vy, Vx + (d2x / n2) * R, Vy + (d2y / n2) * R]);
        pushArrow(Vx + Math.cos(a1) * R, Vy + Math.sin(a1) * R, a1 + (span > 0 ? Math.PI / 2 : -Math.PI / 2));
        pushArrow(Vx + Math.cos(a2) * R, Vy + Math.sin(a2) * R, a2 + (span > 0 ? -Math.PI / 2 : Math.PI / 2));
        const mid = a1 + span / 2;
        return { lines, text: { x: Vx + Math.cos(mid) * (R + px(9)), y: Vy + Math.sin(mid) * (R + px(9)) } };
      }
    } catch {
      return null;
    }
    return null;
  }

  private dimensionLabel(type: string, value: number): string {
    if (type === "angle") return `${((value * 180) / Math.PI).toFixed(1)}°`;
    if (type === "diameter") return `⌀${value.toFixed(2)}`;
    if (type === "radius") return `R${value.toFixed(2)}`;
    return value.toFixed(2);
  }

  private makeArcLine(
    plane: WorkPlane,
    cu: number,
    cv: number,
    r: number,
    a1: number,
    a2: number,
    ccw: boolean,
    color: number
  ): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints(this.arcPoints(plane, cu, cv, r, a1, a2, ccw));
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  }

  /** The polyline of an arc on a plane (a full circle when a1 = 0, a2 = 2π). */
  private arcPoints(plane: WorkPlane, cu: number, cv: number, r: number, a1: number, a2: number, ccw: boolean): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    let start = a1;
    let end = a2;
    if (ccw) {
      if (end <= start) end += Math.PI * 2;
    } else {
      if (end >= start) end -= Math.PI * 2;
    }
    const segs = Math.max(16, Math.ceil((Math.abs(end - start) / (Math.PI * 2)) * 96));
    for (let i = 0; i <= segs; i++) {
      const t = start + ((end - start) * i) / segs;
      pts.push(this.worldPt(plane, cu + r * Math.cos(t), cv + r * Math.sin(t)));
    }
    return pts;
  }

  private renderPreview(preview: PreviewGeom, plane: WorkPlane) {
    const pv = COLORS().preview;
    const mat = new THREE.LineDashedMaterial({ color: pv, dashSize: 2, gapSize: 1.5 });
    (preview.segments ?? []).forEach((s) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        this.worldPt(plane, s.u1, s.v1),
        this.worldPt(plane, s.u2, s.v2),
      ]);
      const line = new THREE.Line(geo, mat.clone());
      line.computeLineDistances();
      this.previewGroup.add(line);
    });
    (preview.circles ?? []).forEach((c) => {
      const line = this.makeArcLine(plane, c.cu, c.cv, c.r, 0, Math.PI * 2, true, pv);
      this.previewGroup.add(line);
    });
    (preview.arcs ?? []).forEach((a) => {
      const line = this.makeArcLine(plane, a.cu, a.cv, a.r, a.a1, a.a2, a.ccw, pv);
      this.previewGroup.add(line);
    });
    (preview.ellipses ?? []).forEach((e) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 72; i++) {
        const t = (i / 72) * Math.PI * 2;
        const ex = e.rx * Math.cos(t), ey = e.ry * Math.sin(t);
        pts.push(this.worldPt(plane, e.cu + ex * Math.cos(e.rotation) - ey * Math.sin(e.rotation), e.cv + ex * Math.sin(e.rotation) + ey * Math.cos(e.rotation)));
      }
      this.previewGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: pv })));
    });
    if (preview.snap) {
      // A flat ring on the sketch plane reads as a snap marker, not a floating sphere.
      const r = this.pixelToWorld(6);
      const ring = this.makeArcLine(plane, preview.snap.u, preview.snap.v, r, 0, Math.PI * 2, true, COLORS().origin);
      this.previewGroup.add(ring);
    }
    if (preview.markers && preview.markers.length) {
      const anchor = preview.snap ?? preview.cursor ?? null;
      if (anchor) {
        const off = this.pixelToWorld(14);
        const sprite = this.makeTextSprite(preview.markers.join(" "), `#${COLORS().origin.toString(16).padStart(6, "0")}`, 18);
        sprite.position.copy(this.worldPt(plane, anchor.u + off, anchor.v + off));
        this.previewGroup.add(sprite);
      }
    }
  }

  private makeTextSprite(text: string, color: string, pxHeight = 22): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const font = 48;
    ctx.font = `${font}px -apple-system, system-ui, sans-serif`;
    const w = Math.ceil(ctx.measureText(text).width) + 20;
    canvas.width = w;
    canvas.height = font + 20;
    ctx.font = `${font}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = COLORS().labelBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, 10, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    // An exact label shows the canvas's sRGB colours as drawn; otherwise they
    // are read as linear and tone-mapped, which lifts them (the dark theme's
    // look, kept as it was; dark ink on a light plate would wash out).
    const exact = COLORS().exactLabels;
    if (exact) tex.colorSpace = THREE.SRGBColorSpace;
    // sizeAttenuation must stay ON: three.js only compensates disabled
    // attenuation for perspective cameras, so under the orthographic sketch
    // camera a non-attenuated sprite collapses to nothing. We instead size the
    // sprite in world units from the target pixel height, which pixelToWorld
    // derives correctly for whichever camera is active.
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      transparent: true,
      sizeAttenuation: true,
      toneMapped: !exact,
    });
    const sprite = new THREE.Sprite(mat);
    const h = this.pixelToWorld(pxHeight);
    sprite.scale.set(h * (canvas.width / canvas.height), h, 1);
    sprite.renderOrder = 999;
    return sprite;
  }
}

/** Circle through 3 points; null if (nearly) collinear. */
function circleFrom3(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x: ux, y: uy, r: Math.hypot(a.x - ux, a.y - uy) };
}

/** A body's triangles as a three.js geometry: positions, normals, indices and, for paper folded in
 *  steps, each vertex's point on the flat sheet (the paper shader's sheetUV: x, y and 1 = set). */
function solidGeometry(s: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; uvs?: Float32Array }): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(s.positions, 3));
  if (s.normals.length === s.positions.length) geo.setAttribute("normal", new THREE.BufferAttribute(s.normals, 3));
  else geo.computeVertexNormals();
  geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
  if (s.uvs && s.uvs.length * 3 === s.positions.length * 2) {
    const n = s.uvs.length / 2, a = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { a[3 * i] = s.uvs[2 * i]; a[3 * i + 1] = s.uvs[2 * i + 1]; a[3 * i + 2] = 1; }
    geo.setAttribute("sheetUV", new THREE.BufferAttribute(a, 3));
  }
  return geo;
}

/** A see-through reference part (SolidView.reference): its own colour, translucent, not writing depth, so the
 *  parts behind it stay legible while it still reads as the thing being held. */
function referenceMaterial(s: SolidView, faded: boolean, clip: THREE.Plane[] | null, opacity = faded ? 0.12 : 0.22): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: referenceColor(s), metalness: 0.05, roughness: 0.6, side: THREE.DoubleSide,
    transparent: true, opacity, depthWrite: false, clippingPlanes: clip ?? undefined,
  });
}
/** Its outline, in a deeper shade of its colour: what keeps a translucent part's shape readable. */
function referenceEdgeMaterial(s: SolidView, faded: boolean, clip: THREE.Plane[] | null, opacity = faded ? 0.3 : 0.7): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: referenceColor(s).multiplyScalar(0.6), transparent: true, opacity, depthWrite: false, clippingPlanes: clip ?? undefined });
}
const referenceColor = (s: SolidView) => new THREE.Color(s.material?.color ?? COLORS().ghost);

/** Folded paper's readability (core/sheetSequence.ts PaperOverlay), all display only: its raw cut edges as a fine
 *  line in a deeper shade of its own colour, drawn a little toward the eye so the layer a flap lies on doesn't hide
 *  it; the soft contact shadow a flap casts on the layer beneath along its edge (a translucent strip fading away from
 *  the edge, not writing depth); the bends, rounded strips over the creases shaded with the paper's own material;
 *  and the crease marks, a soft dark line along a valley lying flat, a faint light one along a flat mountain and
 *  along the crest of every sharp fold. */
function paperOverlay(p: PaperOverlay, resolution: THREE.Vector2, faded: boolean, material: THREE.Material, tint: THREE.Color): THREE.Object3D[] {
  const line = (positions: Float32Array, color: THREE.Color | number, width: number, opacity: number, order: number) => {
    const lm = new LineMaterial({ color: color instanceof THREE.Color ? color.getHex() : color, linewidth: width, transparent: true, opacity: faded ? opacity * 0.3 : opacity, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    lm.resolution.copy(resolution);
    const l = new LineSegments2(new LineSegmentsGeometry().setPositions(positions), lm);
    l.renderOrder = order;
    return l;
  };
  const outline = line(p.outline, tint, 1.1, 0.55, 3);
  const sm = new THREE.MeshBasicMaterial({ color: 0x000000, vertexColors: true, transparent: true, depthWrite: false, opacity: faded ? 0.3 : 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide });
  const shadow = new THREE.Mesh(shadowGeometry(p), sm);
  shadow.renderOrder = 1;
  // the paper's own material (a clone would lose its shader: a plain white one), the strip drawn after the facets
  const bends = new THREE.Mesh(bendGeometry(p), material);
  bends.renderOrder = 2;
  const dark = line(p.marks.dark, 0x000000, 1.0, 0.18, 3), light = line(p.marks.light, 0xffffff, 0.9, 0.09, 3);
  const out: THREE.Object3D[] = [outline, shadow, bends, dark, light];
  for (const o of out) { o.userData.paper = true; o.raycast = () => {}; }
  return out;
}
/** A deeper shade of the paper's own colour, for its edges. */
function paperTint(s: SolidView): THREE.Color {
  return new THREE.Color(s.material?.color ?? "#f2efe8").multiplyScalar(0.45);
}
function bendGeometry(p: PaperOverlay): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p.bends.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(p.bends.normals, 3));
  g.setAttribute("sheetUV", new THREE.BufferAttribute(p.bends.uvs, 3));
  g.setIndex(new THREE.BufferAttribute(p.bends.indices, 1));
  return g;
}
function shadowGeometry(p: PaperOverlay): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p.shadow.positions, 3));
  g.setAttribute("color", new THREE.BufferAttribute(p.shadow.colors, 4));
  g.setIndex(new THREE.BufferAttribute(p.shadow.indices, 1));
  return g;
}

/** Paper's edges and creases: a soft grey line, a crease rather than a drawn outline. */
function paperEdgeMaterial(faded: boolean): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: 0x55534f, transparent: true, opacity: faded ? 0.2 : 0.5 });
}


/** Section hatching on a cap material: lines `spacing` mm apart across the cap's own plane (they stay put on the
 *  cut as the view turns), at `angleDeg`, darkening the fill; antialiased over a pixel. */
function hatch(mat: THREE.MeshStandardMaterial, spacing: number, angleDeg: number) {
  const a = (angleDeg * Math.PI) / 180;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHatch = { value: new THREE.Vector3(spacing, -Math.sin(a), Math.cos(a)) }; // spacing, then across the lines
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vHatchPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHatchPos = position.xy;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec2 vHatchPos;\nuniform vec3 uHatch;")
      .replace("#include <map_fragment>", `#include <map_fragment>
      {
        float t = dot(vHatchPos, uHatch.yz) / uHatch.x;      // in spacings, across the lines
        float d = abs(fract(t + 0.5) - 0.5) * uHatch.x;    // mm to the nearest line
        float px = fwidth(t) * uHatch.x;                   // a pixel, in mm
        float hw = max(0.09 * uHatch.x, 0.5 * px);         // the line's half width: at least a pixel wide
        float line = 1.0 - smoothstep(hw - 0.5 * px, hw + 0.5 * px, d);
        diffuseColor.rgb *= 1.0 - 0.55 * line;
      }`);
  };
  mat.customProgramCacheKey = () => "section-hatch";
}

