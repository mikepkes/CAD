import * as THREE from "three";
import { sampleSpline } from "../core/geometry/spline";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PLANES, WorkPlane, to3d } from "../geometry/plane";
import { DimensionConstraint, Sketch, SketchArc, SketchCircle, SketchEllipse, SketchLine, SketchPoint } from "../sketch/types";
import { isDimension } from "../sketch/types";
import { extractProfiles, Loop } from "../core/geometry/profile";
import { HandleManager } from "./handles";
import { makeThreadNormalMap } from "./threadTexture";
import { createMaterial, MaterialSpec, WoodFrame } from "./material";
import type { ThreadDecal } from "../core/document";

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
  gridSize?: number;
  showConstraints: boolean;
  /** Overall constrained state of the active sketch, for Fusion-style coloring. */
  constraintState: "under" | "full" | "conflict";
  solids?: SolidView[];
  /** Datum/reference planes to show in the scene (resolved frames), pickable for Create Sketch. */
  datumPlanes?: { id: string; name: string; plane: WorkPlane }[];
  /** Other sketches to show dimmed on their planes (every sketch but the active one). */
  ghostSketches?: { sketch: Sketch; plane: WorkPlane }[];
  /** Pickable region fills for the active extrude session (click to choose a region). */
  extrudeRegions?: { plane: WorkPlane; regions: { interior: { x: number; y: number }; outer: { x: number; y: number }[]; holes: { x: number; y: number }[][]; selected: boolean }[] };
  /** Live translucent preview of the pending extrude. */
  extrudePreview?: { plane: WorkPlane; regions: { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][] }[]; distance: number; symmetric: boolean; operation: "new" | "join" | "cut" | "intersect" };
  /** Active section (cross-section) cut: clips the solids on a base plane at an offset. */
  section?: { plane: "XY" | "XZ" | "YZ"; offset: number; flip: boolean } | null;
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
}

const COLORS = {
  bg: 0x1b1d23,
  grid: 0x2d3340,
  gridMajor: 0x3a4152,
  ghost: 0x5b6472,
  geometry: 0xdfe6f2,
  underConstrained: 0x5a8cff, // Fusion-style blue for under-constrained geometry
  profileFill: 0x4f8cff,
  construction: 0x8a93a6,
  selected: 0xffb454,
  hover: 0x5ac8fa,
  point: 0xbcc6d8,
  origin: 0xffd166,
  dimension: 0x7bd88f,
  fullyConstrained: 0x8fe388,
  bad: 0xff6b6b,
  sectionCap: 0xc7ccd6, // steel fill on cut faces (Fusion-style)
};

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
  private regionGroup = new THREE.Group();
  private previewSolidGroup = new THREE.Group();
  private planeGroup = new THREE.Group();
  private grid: THREE.GridHelper;
  private gridSize = 10;
  private sketchGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private solidsGroup = new THREE.Group();
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

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true });
    this.renderer.localClippingEnabled = true; // per-material section clipping
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = "none";
    // Trackpad-aware navigation: two-finger scroll pans, pinch zooms (handled
    // in capture phase so we can suppress OrbitControls' wheel-dolly for pans).
    this.renderer.domElement.addEventListener("wheel", this.onWheel, { passive: false, capture: true });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.bg);

    const aspect = container.clientWidth / container.clientHeight;
    this.perspCam = new THREE.PerspectiveCamera(45, aspect, 0.1, 100000);
    this.perspCam.up.set(0, 0, 1); // Z up
    this.perspCam.position.set(140, -180, 140);
    this.orthoCam = new THREE.OrthographicCamera(-100 * aspect, 100 * aspect, 100, -100, -100000, 100000);
    this.orthoCam.up.set(0, 0, 1);
    this.orthoCam.position.set(140, -180, 140);
    this.camera = this.perspCam;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true; // pinch / wheel zoom toward the cursor
    this.controls.target.set(0, 0, 0);

    // lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(1, -1, 2);
    this.scene.add(dir);

    // grid on XY (world), rotated so it lies in XY with Z up
    this.grid = this.makeGrid(this.gridSize);
    this.scene.add(this.grid);

    this.buildAxes();
    this.buildPlanes();
    this.scene.add(this.ghostGroup);
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

  private makeGrid(size: number): THREE.GridHelper {
    const divisions = 40;
    const grid = new THREE.GridHelper(size * divisions, divisions, COLORS.gridMajor, COLORS.grid);
    grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default; lay it in XY (Z up)
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.gridSize = size;
    return grid;
  }

  /** Rebuild the grid at a new cell size (mm). */
  private applyGrid(size: number) {
    if (Math.abs(size - this.gridSize) < 1e-9) return;
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
    const axes = new THREE.Group();
    axes.add(mk(new THREE.Vector3(1, 0, 0), 0xff5555));
    axes.add(mk(new THREE.Vector3(0, 1, 0), 0x55ff77));
    axes.add(mk(new THREE.Vector3(0, 0, 1), 0x5588ff));
    this.scene.add(axes);
  }

  private buildPlanes() {
    const size = 120;
    for (const p of PLANES) {
      const geo = new THREE.PlaneGeometry(size, size);
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(p.color),
        transparent: true,
        opacity: 0.08,
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
        new THREE.LineBasicMaterial({ color: new THREE.Color(p.color), transparent: true, opacity: 0.5 })
      );
      this.orientToPlane(line, p, size / 2);
      this.planeGroup.add(line);
    }
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
      const color = new THREE.Color(0xc9a227); // datum amber, distinct from origin planes
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
    this.renderer.setSize(w, h);
  };

  private animate = () => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    const dt = this.clock.getDelta();
    if (this.tween) this.stepTween(dt);
    else this.controls.update();
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
    this.renderer.render(this.scene, this.camera);
  };

  /** Rebuild only the sketch + preview groups (cheap; leaves solids alone). */
  private rerenderSketchLayer() {
    const d = this.lastData;
    if (!d || !d.sketch || !d.plane) return;
    this.clearGroup(this.sketchGroup);
    this.clearGroup(this.previewGroup);
    this.renderSketch(d.sketch, d.plane, d);
    if (d.preview) this.renderPreview(d.preview, d.plane);
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
    for (const t of this.threadTexCache.values()) t.dispose();
    this.threadTexCache.clear();
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
      const solidMeshes = this.solidsGroup.children.filter((c) => (c as THREE.Mesh).isMesh);
      const faceHits = this.raycaster.intersectObjects(solidMeshes, false);
      const planeHits = this.raycaster.intersectObjects(
        [...this.planeMeshes.values(), ...this.datumMeshes.values()],
        false
      );
      const fh = faceHits[0], ph = planeHits[0];
      if (fh && fh.face && (!ph || fh.distance <= ph.distance)) {
        const n = fh.face.normal.clone().transformDirection(fh.object.matrixWorld).normalize();
        return { type: "face", world: fh.point, normal: { x: n.x, y: n.y, z: n.z } };
      }
      if (ph) return { type: "plane", id: ph.object.userData.planeId, world: ph.point };
      return { type: "empty" };
    }
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
  renderView(opts: { view?: string; width?: number; height?: number; hideSketches?: boolean } = {}): { base64: string; width: number; height: number; view: string } {
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
    const view = opts.view && DIRS[opts.view] ? opts.view : "iso";
    const dir = new THREE.Vector3(...DIRS[view]).normalize();
    const cam = new THREE.PerspectiveCamera(45, width / height, 0.1, 1e6);
    cam.up.set(0, 0, 1);
    if (view === "top" || view === "bottom") cam.up.set(0, 1, 0);
    const dist = (radius / Math.sin(((45 * Math.PI) / 180) / 2)) * 1.15;
    cam.position.copy(center).addScaledVector(dir, dist);
    cam.lookAt(center);
    cam.updateProjectionMatrix();

    const rt = new THREE.WebGLRenderTarget(width, height);
    // Hide the big origin-plane overlays for a clean capture (keep grid + axes).
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
    rt.dispose();

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

  /** Animate back to a perspective 3D view (on finishing a sketch). */
  exitSketchView() {
    if ((this.camera as THREE.OrthographicCamera).isOrthographicCamera) {
      this.matchPerspectiveToOrtho();
      this.setActiveCamera(this.perspCam);
    }
    // keep the current orientation; just a gentle settle (no reframe)
    this.tween = null;
    this.controls.enabled = true;
    this.controls.update();
  }

  /** Zoom-to-fit a set of sketch (u,v) points, keeping the current view direction. */
  frameSketchPoints(plane: WorkPlane, pts: { x: number; y: number }[]) {
    if (!pts.length) return;
    this.frameWorld(pts.map((p) => this.worldPt(plane, p.x, p.y)));
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
      const dist = (radius * margin) / Math.tan(((pc.fov * Math.PI) / 180) / 2);
      this.beginTween({ from, to: { off: dir.clone().multiplyScalar(dist), target: center, up, zoom: pc.zoom } });
    }
  }

  private beginTween(spec: {
    from: { off: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number };
    to: { off: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number };
    onDone?: () => void;
  }) {
    this.controls.enabled = false;
    this.tween = { t: 0, dur: 0.5, from: spec.from, to: spec.to, onDone: spec.onDone };
  }

  // ---- rendering the sketch ----

  update(data: ViewData) {
    this.lastData = data;
    this.planeGroup.visible = data.showPlanes && data.mode === "model";
    this.datumGroup.visible = data.showPlanes && data.mode === "model";
    if (data.gridSize) this.applyGrid(data.gridSize);
    this.grid.visible = data.showGrid;

    this.renderDatumPlanes(data.datumPlanes ?? []);
    this.clearGroup(this.sketchGroup);
    this.clearGroup(this.previewGroup);
    this.clearGroup(this.solidsGroup);
    this.clearGroup(this.ghostGroup);
    this.clearGroup(this.regionGroup);
    this.clearGroup(this.previewSolidGroup);

    // Other sketches stay visible on their planes, dimmed (Fusion-style).
    for (const g of data.ghostSketches ?? []) this.renderGhostSketch(g.sketch, g.plane);

    // Extrude session: pickable, highlightable region fills.
    if (data.extrudeRegions) this.renderExtrudeRegions(data.extrudeRegions);
    if (data.extrudePreview) this.renderExtrudePreview(data.extrudePreview);

    // Section cut: a clip plane applied to every solid, with a filled cap on
    // the cut faces (Fusion-style). Only in model mode.
    this.clipPlane = data.mode === "model" && data.section ? sectionPlane(data.section) : null;

    // Solids render in model mode (and faded while sketching).
    this.solidsGroup.visible = !!data.solids && data.solids.length > 0;
    if (data.solids) data.solids.forEach((s, i) => this.renderSolid(s, data.mode === "sketch", i));

    if (data.sketch && data.plane) {
      this.renderSketch(data.sketch, data.plane, data);
      if (data.preview) this.renderPreview(data.preview, data.plane);
    }
  }

  private renderSolid(s: SolidView, faded: boolean, index: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(s.positions, 3));
    if (s.normals.length === s.positions.length) geo.setAttribute("normal", new THREE.BufferAttribute(s.normals, 3));
    else geo.computeVertexNormals();
    geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
    const clip = this.clipPlane ? [this.clipPlane] : null;
    // In section view each body gets its own colour so parts read apart; the
    // normal (un-sectioned) view keeps the assigned material, else a uniform tint.
    const color = clip ? bodyColor(index) : 0x7b86e0;
    let mat: THREE.Material;
    if (s.material && !clip) {
      mat = this.materialFor(s);
      (mat as THREE.MeshStandardMaterial).transparent = faded;
      (mat as THREE.MeshStandardMaterial).opacity = faded ? 0.25 : 1;
    } else {
      mat = new THREE.MeshStandardMaterial({
        color, metalness: 0.15, roughness: 0.5, side: THREE.DoubleSide,
        transparent: faded, opacity: faded ? 0.25 : 1, clippingPlanes: clip ?? undefined,
      });
    }
    const mesh = new THREE.Mesh(geo, mat);
    this.solidsGroup.add(mesh);

    // Section cap for THIS body: a stencil pass marks where the clip plane cuts
    // its material (back faces increment, front decrement), then a coloured quad
    // fills those pixels and resets the stencil so the next body starts clean.
    if (clip) {
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
      this.addSectionCap(this.clipPlane!, s, tint(color), base + 1);
    }

    if (s.edges.length) {
      const egeo = new THREE.BufferGeometry();
      egeo.setAttribute("position", new THREE.BufferAttribute(s.edges, 3));
      const eseg = new THREE.LineSegments(
        egeo,
        new THREE.LineBasicMaterial({ color: 0x20242e, transparent: faded, opacity: faded ? 0.3 : 1, clippingPlanes: clip ?? undefined })
      );
      this.solidsGroup.add(eseg);
    }

    for (const d of s.threadDecals ?? []) this.renderThreadSleeve(d, color, faded);
  }

  /** Draw a cosmetic thread: a cylindrical sleeve on the body's surface shaded by
   *  a procedural thread normal map (so the solid itself stays a plain cylinder). */
  private renderThreadSleeve(d: ThreadDecal, color: number, faded: boolean) {
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
  }

  /** A filled quad over one body's cut, visible only where that body's stencil
   *  is non-zero. Sized to the body and coloured to match it; drawing it resets
   *  the stencil to 0 so the next body's cap is independent. */
  private addSectionCap(plane: THREE.Plane, s: SolidView, color: number, renderOrder: number) {
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const p = s.positions;
    for (let i = 0; i < p.length; i += 3) {
      lo.min(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
      hi.max(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
    }
    const ctr = lo.clone().add(hi).multiplyScalar(0.5);
    const size = lo.distanceTo(hi) * 1.2 || 200;
    const capMat = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.75, side: THREE.DoubleSide });
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
    for (const child of [...g.children]) {
      g.remove(child);
      (child as any).geometry?.dispose?.();
      const m = (child as any).material;
      const keep = (x: THREE.Material) => !!x.userData?.cached; // cached materials are reused across frames
      if (Array.isArray(m)) m.forEach((x) => { if (!keep(x)) x.dispose(); });
      else if (m && !keep(m)) m.dispose?.();
    }
  }

  // Per-body / per-spec material cache so the procedural shaders aren't rebuilt
  // on every frame (e.g. during a slider drag). Wood keeps one material per body
  // and updates its grain-frame uniforms in place, so grain travels with a part.
  private matCache = new Map<string, THREE.Material>();
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
    if (data.selection.has(id)) return COLORS.selected;
    if (data.hover === id) return COLORS.hover;
    if (construction) return COLORS.construction;
    return base;
  }

  /** Draw a non-active sketch dimmed on its plane — curves only, no points,
   *  fills, dimensions or badges, and not pickable (it lives in its own group). */
  private renderGhostSketch(sk: Sketch, plane: WorkPlane) {
    const getPt = (id: string) => sk.entities[id] as SketchPoint | undefined;
    const color = COLORS.ghost;
    const add = (obj: THREE.Line) => { (obj.material as THREE.Material).transparent = true; (obj.material as THREE.Material).opacity = 0.65; this.ghostGroup.add(obj); };
    const dashed = (line: THREE.Line, construction?: boolean) => { if (construction) line.computeLineDistances(); };
    const lineMat = (construction?: boolean) =>
      construction ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.6 }) : new THREE.LineBasicMaterial({ color });
    for (const e of Object.values(sk.entities)) {
      if (e.kind === "line") {
        const a = getPt(e.p1), b = getPt(e.p2);
        if (!a || !b) continue;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.worldPt(plane, a.x, a.y), this.worldPt(plane, b.x, b.y)]), lineMat(e.construction));
        dashed(line, e.construction); add(line);
      } else if (e.kind === "circle") {
        const ctr = getPt(e.center); if (!ctr) continue;
        const line = this.makeArcLine(plane, ctr.x, ctr.y, e.r, 0, Math.PI * 2, true, color);
        add(line);
      } else if (e.kind === "arc") {
        const ctr = getPt(e.center), a = getPt(e.p1), b = getPt(e.p2);
        if (!ctr || !a || !b) continue;
        const a1 = Math.atan2(a.y - ctr.y, a.x - ctr.x), a2 = Math.atan2(b.y - ctr.y, b.x - ctr.x);
        add(this.makeArcLine(plane, ctr.x, ctr.y, e.r, a1, a2, e.ccw, color));
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
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(e.construction));
        dashed(line, e.construction); add(line);
      } else if (e.kind === "spline") {
        const through = e.points.map((id) => getPt(id)).filter((p) => !!p).map((p) => ({ x: p!.x, y: p!.y }));
        if (through.length < 2) continue;
        const pts = sampleSpline(through, 10).map((p) => this.worldPt(plane, p.x, p.y));
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(e.construction));
        dashed(line, e.construction); add(line);
      }
    }
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
    const color = operation === "cut" ? 0xe4564e : 0x5bbf84;
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
          color: reg.selected ? 0x5bbf84 : 0x4a7bd6,
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

  private renderSketch(sk: Sketch, plane: WorkPlane, data: ViewData) {
    const pts = sk.entities;
    const getPt = (id: string) => pts[id] as SketchPoint;

    // Fusion-style state color: blue = under-constrained, light = fully
    // constrained, red = conflicting.
    const baseColor =
      data.constraintState === "full"
        ? COLORS.geometry
        : data.constraintState === "conflict"
          ? COLORS.bad
          : COLORS.underConstrained;

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

    // points (skip purely implicit endpoints unless hovered/selected? show all real ones)
    for (const e of Object.values(sk.entities)) {
      if (e.kind !== "point") continue;
      const pt = e as SketchPoint;
      const isOrigin = pt.id === sk.originPointId;
      const color = data.selection.has(pt.id)
        ? COLORS.selected
        : data.hover === pt.id
          ? COLORS.hover
          : isOrigin
            ? COLORS.origin
            : pt.fixed
              ? COLORS.point
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
          const sprite = this.makeTextSprite(badge.glyph, "#9ab0e8", 18);
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
        color: COLORS.profileFill,
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
    const color = 0x5bbf84;
    if (layout.lines.length) {
      const pts: THREE.Vector3[] = [];
      for (const [u1, v1, u2, v2] of layout.lines) pts.push(this.worldPt(plane, u1, v1), this.worldPt(plane, u2, v2));
      const seg = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
      seg.userData = { id: c.id, kind: "dimension" };
      seg.renderOrder = 4;
      this.sketchGroup.add(seg);
    }
    const labelPos = this.worldPt(plane, layout.text.x, layout.text.y);
    const sprite = this.makeTextSprite(this.dimensionLabel(c.type, c.value), "#8fe3ad");
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
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  }

  private renderPreview(preview: PreviewGeom, plane: WorkPlane) {
    const mat = new THREE.LineDashedMaterial({ color: 0x9aa7bd, dashSize: 2, gapSize: 1.5 });
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
      const line = this.makeArcLine(plane, c.cu, c.cv, c.r, 0, Math.PI * 2, true, 0x9aa7bd);
      this.previewGroup.add(line);
    });
    (preview.arcs ?? []).forEach((a) => {
      const line = this.makeArcLine(plane, a.cu, a.cv, a.r, a.a1, a.a2, a.ccw, 0x9aa7bd);
      this.previewGroup.add(line);
    });
    (preview.ellipses ?? []).forEach((e) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 72; i++) {
        const t = (i / 72) * Math.PI * 2;
        const ex = e.rx * Math.cos(t), ey = e.ry * Math.sin(t);
        pts.push(this.worldPt(plane, e.cu + ex * Math.cos(e.rotation) - ey * Math.sin(e.rotation), e.cv + ex * Math.sin(e.rotation) + ey * Math.cos(e.rotation)));
      }
      this.previewGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9aa7bd })));
    });
    if (preview.snap) {
      // A flat ring on the sketch plane reads as a snap marker, not a floating sphere.
      const r = this.pixelToWorld(6);
      const ring = this.makeArcLine(plane, preview.snap.u, preview.snap.v, r, 0, Math.PI * 2, true, 0xffd166);
      this.previewGroup.add(ring);
    }
    if (preview.markers && preview.markers.length) {
      const anchor = preview.snap ?? preview.cursor ?? null;
      if (anchor) {
        const off = this.pixelToWorld(14);
        const sprite = this.makeTextSprite(preview.markers.join(" "), "#ffd166", 18);
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
    ctx.fillStyle = "rgba(20,22,28,0.85)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, 10, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
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
