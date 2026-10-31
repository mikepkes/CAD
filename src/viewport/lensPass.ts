// The Lens's 3D side: after the normal frame, the solids are drawn again with
// an analysis material, masked to a circle or to the right of a wipe line.
// SceneManager only stores the spec and calls render(); every decision about
// what to draw lives here. The mask is a scissor box (cheap, robust) plus a
// per-fragment `discard` outside the circle, so no stencil state is needed.
//
// Depth: the pass does not clear; the analysis surface is drawn with
// LessEqual depth and a tiny negative polygon offset so it replaces the base
// surface exactly where the same triangles already are. X-ray first "erases"
// the lens (colour → background, depth → far) and then draws every body as
// faint glass with all its edges, so holes and inner cavities read through.

import * as THREE from "three";
import { COLOR_VERT, WORLD_VERT, curvatureColors, curvatureFrag, draftFrag, zebraFrag, type ShaderMask } from "./analysisShaders";

export { curvatureColors };

export type LensMode = "zebra" | "draft" | "curvature" | "xray" | "overhang";
export type LensShape = "lens" | "wipe";

export interface LensSpec {
  mode: LensMode;
  shape: LensShape;
  /** Circle centre and radius in viewport-local CSS pixels (y down). */
  x: number;
  y: number;
  r: number;
  /** The wipe line's x in CSS pixels; the analysis shows to its right. */
  wipeX: number;
  /** Build direction in world space (overhang). */
  up: { x: number; y: number; z: number };
  /** Analysis parameters, shared with the whole-view display (store.analysis). */
  stripes: number;
  draftDeg: number;
  pull: { x: number; y: number; z: number };
  quantity: "mean" | "gaussian" | "max" | "min";
}

/** What the pass needs to know about a body beyond its mesh (curvature per vertex). */
export interface LensSolidInfo {
  id?: string;
  positions: Float32Array;
  curvature?: Float32Array;
}

/** Overhang thresholds; lens.ts mirrors them for the legend and its tests. */
export const OVERHANG_RED_SIN = Math.sin((45 * Math.PI) / 180);
export const OVERHANG_AMBER_SIN = Math.sin((2 * Math.PI) / 180);
/** Colours the overhang shader uses; kit.css --k-an-overhang-{bed,steep,mild,neutral} mirror them for the legend. */
export const OVERHANG_COLORS = { bed: 0x56c2e6, steep: 0xf08a7a, mild: 0xf0a44b, neutral: 0x9aa3ad };

// ---- GLSL ----
// Shared mask: every fragment outside the lens is dropped.
const MASK_PARS = `
  uniform vec2 uLensCenter; uniform float uLensRadius; uniform float uShape;
  void lensMask() {
    if (uShape < 0.5) { if (distance(gl_FragCoord.xy, uLensCenter) > uLensRadius) discard; }
    else if (gl_FragCoord.x < uLensCenter.x) discard;
  }`;

/** The mask as the shared analysis shaders take it. */
const MASK: ShaderMask = { pars: MASK_PARS, call: "lensMask();" };
const ZEBRA_FRAG = zebraFrag(MASK);
const DRAFT_FRAG = draftFrag(MASK);
const CURVATURE_FRAG = curvatureFrag(MASK);

const OVERHANG_FRAG = `
  uniform vec3 uUp; uniform float uBed; uniform float uBedTol; uniform float uRedSin; uniform float uAmberSin;
  uniform vec3 cBed; uniform vec3 cSteep; uniform vec3 cMild; uniform vec3 cNeutral;
  varying vec3 vN; varying vec3 vW;
  #include <clipping_planes_pars_fragment>
  ${MASK_PARS}
  void main() {
    #include <clipping_planes_fragment>
    lensMask();
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
    float d = dot(N, uUp);
    float h = dot(vW, uUp) - uBed;
    vec3 c = cNeutral;
    if (d < -0.95 && h < uBedTol) c = cBed;
    else if (d < -uRedSin) c = cSteep;
    else if (d < -uAmberSin) c = cMild;
    float shade = 0.45 + 0.55 * abs(dot(N, normalize(cameraPosition - vW)));
    gl_FragColor = vec4(c * shade, 1.0);
  }`;

const GLASS_FRAG = `
  varying vec3 vN; varying vec3 vW;
  #include <clipping_planes_pars_fragment>
  ${MASK_PARS}
  void main() {
    #include <clipping_planes_fragment>
    lensMask();
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
    float f = 1.0 - abs(dot(N, normalize(cameraPosition - vW)));
    gl_FragColor = vec4(vec3(0.55, 0.68, 0.9), 0.08 + 0.3 * f * f);
  }`;

const LINE_VERT = `
  #include <clipping_planes_pars_vertex>
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }`;

const LINE_FRAG = `
  uniform vec3 uColor; uniform float uAlpha;
  #include <clipping_planes_pars_fragment>
  ${MASK_PARS}
  void main() {
    #include <clipping_planes_fragment>
    lensMask();
    gl_FragColor = vec4(uColor, uAlpha);
  }`;

// The erase quad: covers the viewport, writes the background colour and a far
// depth, masked like everything else. Drawn only for x-ray.
const ERASE_VERT = `void main() { gl_Position = vec4(position.xy, 0.9999, 1.0); }`;
const ERASE_FRAG = `
  uniform vec3 uBg;
  ${MASK_PARS}
  void main() { lensMask(); gl_FragColor = vec4(uBg, 1.0); }`;

type Mask = { center: THREE.Vector2; radius: number; shape: number };

/** A colour uploaded as its sRGB bytes (no working-space conversion), so the
 *  shader paints exactly the hex the legend swatch shows. */
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

function maskUniforms(m: Mask) {
  return { uLensCenter: { value: m.center }, uLensRadius: { value: m.radius }, uShape: { value: m.shape } };
}

/** The centre is shared by reference; the scalars are copied in each frame. */
function syncMask(mat: THREE.ShaderMaterial, m: Mask) {
  mat.uniforms.uLensRadius.value = m.radius;
  mat.uniforms.uShape.value = m.shape;
}

const SURFACE_OPTS = {
  side: THREE.DoubleSide, depthFunc: THREE.LessEqualDepth, depthWrite: true, clipping: true,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
};

export class LensPass {
  private spec: LensSpec | null = null;
  private group = new THREE.Group();
  private mask: Mask = { center: new THREE.Vector2(), radius: 0, shape: 0 };
  private surface: THREE.ShaderMaterial | null = null;
  private surfaceKey = "";
  private glass: THREE.ShaderMaterial | null = null;
  private line: THREE.ShaderMaterial | null = null;
  private erase: THREE.Mesh | null = null;
  /** Wrapper meshes / lines reusing the base geometry, keyed by the base object. */
  private wrappers = new WeakMap<THREE.Object3D, THREE.Object3D>();
  /** Curvature colour attributes, keyed by the base geometry (rebuilt when SceneManager rebuilds). */
  private colors = new WeakMap<THREE.BufferGeometry, { quantity: string; attr: THREE.BufferAttribute }>();
  private bgColor = new THREE.Color();
  private rgb = { r: 0, g: 0, b: 0 };

  setSpec(spec: LensSpec | null) { this.spec = spec; }
  get active(): boolean { return this.spec != null; }

  /** Draw the lens over the frame just rendered. `solids` are the bodies the scene currently shows. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, solidsGroup: THREE.Group, solids: LensSolidInfo[] | undefined) {
    const spec = this.spec;
    if (!spec || !solidsGroup.visible) return;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x <= 0 || size.y <= 0) return;
    const pr = renderer.getPixelRatio();

    // Scissor box in CSS px, y from the bottom (three multiplies by the pixel ratio).
    let sx: number, sy: number, sw: number, sh: number;
    if (spec.shape === "lens") {
      sx = Math.max(0, spec.x - spec.r); sy = Math.max(0, size.y - (spec.y + spec.r));
      sw = Math.min(size.x, spec.x + spec.r) - sx; sh = Math.min(size.y, size.y - (spec.y - spec.r)) - sy;
      this.mask.center.set(spec.x * pr, (size.y - spec.y) * pr); this.mask.radius = spec.r * pr; this.mask.shape = 0;
    } else {
      sx = Math.max(0, Math.min(size.x, spec.wipeX)); sy = 0; sw = size.x - sx; sh = size.y;
      this.mask.center.set(spec.wipeX * pr, 0); this.mask.radius = 0; this.mask.shape = 1;
    }
    if (sw <= 0 || sh <= 0) return;

    const bodies = collect(solidsGroup);
    if (!bodies.meshes.length) return;

    const prevAutoClear = renderer.autoClear;
    const prevScissorTest = renderer.getScissorTest();
    const prevScissor = renderer.getScissor(new THREE.Vector4());
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(sx, sy, sw, sh);
    try {
      this.group.clear();
      if (spec.mode === "xray") this.renderXray(renderer, scene, camera, bodies);
      else this.renderSurface(renderer, camera, spec, bodies.meshes, solids);
    } finally {
      this.group.clear();
      renderer.setScissor(prevScissor);
      renderer.setScissorTest(prevScissorTest);
      renderer.autoClear = prevAutoClear;
    }
  }

  private renderSurface(renderer: THREE.WebGLRenderer, camera: THREE.Camera, spec: LensSpec, meshes: THREE.Mesh[], solids: LensSolidInfo[] | undefined) {
    const mat = this.surfaceMaterial(spec);
    syncMask(mat, this.mask);
    if (spec.mode === "overhang") {
      const up = new THREE.Vector3(spec.up.x, spec.up.y, spec.up.z).normalize();
      const { bed, extent } = bedLevel(meshes, up);
      mat.uniforms.uUp.value.copy(up);
      mat.uniforms.uBed.value = bed;
      mat.uniforms.uBedTol.value = Math.max(0.01, extent * 1e-4);
    }
    const byId = new Map<string, LensSolidInfo>();
    for (const s of solids ?? []) if (s.id) byId.set(s.id, s);
    for (const m of meshes) {
      const geo = m.geometry as THREE.BufferGeometry;
      if (spec.mode === "curvature") {
        const info = byId.get(String(m.userData.bodyId));
        if (!info?.curvature || info.curvature.length !== (info.positions.length / 3) * 2) continue;
        let c = this.colors.get(geo);
        if (!c || c.quantity !== spec.quantity) {
          c = { quantity: spec.quantity, attr: new THREE.BufferAttribute(curvatureColors(info.curvature, spec.quantity), 3) };
          this.colors.set(geo, c);
        }
        if (geo.getAttribute("color") !== c.attr) geo.setAttribute("color", c.attr);
      }
      this.group.add(this.wrap(m, mat));
    }
    if (!this.group.children.length) return;
    mat.clippingPlanes = clipOf(meshes[0]);
    renderer.render(this.group, camera);
  }

  private renderXray(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, bodies: { meshes: THREE.Mesh[]; edges: THREE.LineSegments[] }) {
    // 1. erase the lens area to the background, far depth
    const erase = this.eraseQuad();
    syncMask(erase.material as THREE.ShaderMaterial, this.mask);
    const bg = scene.background instanceof THREE.Color ? scene.background : this.bgColor.set(0x000000);
    bg.getRGB(this.rgb, renderer.outputColorSpace);
    (erase.material as THREE.ShaderMaterial).uniforms.uBg.value.set(this.rgb.r, this.rgb.g, this.rgb.b);
    renderer.render(erase, camera);
    // 2. the bodies as glass, then every edge on top (depth test off so hidden ones show)
    const glass = this.glassMaterial();
    syncMask(glass, this.mask);
    glass.clippingPlanes = clipOf(bodies.meshes[0]);
    for (const m of bodies.meshes) this.group.add(this.wrap(m, glass));
    const line = this.lineMaterial();
    syncMask(line, this.mask);
    line.clippingPlanes = glass.clippingPlanes;
    for (const e of bodies.edges) this.group.add(this.wrap(e, line));
    renderer.render(this.group, camera);
  }

  /** A mesh / line sharing the base object's geometry and world matrix, with the lens material. */
  private wrap(src: THREE.Object3D, mat: THREE.Material): THREE.Object3D {
    let w = this.wrappers.get(src);
    const geo = (src as THREE.Mesh).geometry;
    if (!w || (w as THREE.Mesh).geometry !== geo) {
      w = (src as THREE.LineSegments).isLineSegments ? new THREE.LineSegments(geo, mat) : new THREE.Mesh(geo, mat);
      w.matrixAutoUpdate = false;
      w.frustumCulled = false;
      this.wrappers.set(src, w);
    }
    (w as THREE.Mesh).material = mat;
    w.matrix.copy(src.matrixWorld);
    w.matrixWorldNeedsUpdate = true;
    return w;
  }

  private surfaceMaterial(spec: LensSpec): THREE.ShaderMaterial {
    const key = spec.mode === "zebra" ? `zebra` : spec.mode === "draft" ? `draft` : spec.mode === "curvature" ? "curvature" : "overhang";
    if (this.surface && this.surfaceKey === key) {
      const u = this.surface.uniforms;
      if (spec.mode === "zebra") u.stripes.value = Math.max(2, spec.stripes);
      if (spec.mode === "draft") { u.pull.value.set(spec.pull.x, spec.pull.y, spec.pull.z).normalize(); u.draft.value = Math.sin((spec.draftDeg * Math.PI) / 180); }
      return this.surface;
    }
    this.surface?.dispose();
    this.surfaceKey = key;
    const mask = maskUniforms(this.mask);
    if (spec.mode === "zebra") {
      this.surface = new THREE.ShaderMaterial({ ...SURFACE_OPTS, uniforms: { ...mask, stripes: { value: Math.max(2, spec.stripes) } }, vertexShader: WORLD_VERT, fragmentShader: ZEBRA_FRAG });
    } else if (spec.mode === "draft") {
      this.surface = new THREE.ShaderMaterial({ ...SURFACE_OPTS, uniforms: { ...mask, pull: { value: new THREE.Vector3(spec.pull.x, spec.pull.y, spec.pull.z).normalize() }, draft: { value: Math.sin((spec.draftDeg * Math.PI) / 180) } }, vertexShader: WORLD_VERT, fragmentShader: DRAFT_FRAG });
    } else if (spec.mode === "curvature") {
      this.surface = new THREE.ShaderMaterial({ ...SURFACE_OPTS, uniforms: { ...mask }, vertexShader: COLOR_VERT, fragmentShader: CURVATURE_FRAG, vertexColors: true });
    } else {
      const c = OVERHANG_COLORS;
      this.surface = new THREE.ShaderMaterial({
        ...SURFACE_OPTS,
        uniforms: {
          ...mask, uUp: { value: new THREE.Vector3(0, 0, 1) }, uBed: { value: 0 }, uBedTol: { value: 0.01 },
          uRedSin: { value: OVERHANG_RED_SIN }, uAmberSin: { value: OVERHANG_AMBER_SIN },
          cBed: { value: srgb(c.bed) }, cSteep: { value: srgb(c.steep) }, cMild: { value: srgb(c.mild) }, cNeutral: { value: srgb(c.neutral) },
        },
        vertexShader: WORLD_VERT, fragmentShader: OVERHANG_FRAG,
      });
    }
    return this.surface;
  }

  private glassMaterial(): THREE.ShaderMaterial {
    if (!this.glass) {
      this.glass = new THREE.ShaderMaterial({
        uniforms: maskUniforms(this.mask), vertexShader: WORLD_VERT, fragmentShader: GLASS_FRAG,
        side: THREE.DoubleSide, transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, clipping: true,
      });
    }
    return this.glass;
  }

  private lineMaterial(): THREE.ShaderMaterial {
    if (!this.line) {
      this.line = new THREE.ShaderMaterial({
        uniforms: { ...maskUniforms(this.mask), uColor: { value: srgb(0xeceae6) }, uAlpha: { value: 0.75 } },
        vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
        transparent: true, depthTest: false, depthWrite: false, clipping: true,
      });
    }
    return this.line;
  }

  private eraseQuad(): THREE.Mesh {
    if (!this.erase) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...maskUniforms(this.mask), uBg: { value: new THREE.Color(0) } },
        vertexShader: ERASE_VERT, fragmentShader: ERASE_FRAG,
        depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true, side: THREE.DoubleSide,
      });
      this.erase = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      this.erase.frustumCulled = false;
    }
    return this.erase;
  }

  dispose() {
    this.surface?.dispose(); this.glass?.dispose(); this.line?.dispose();
    if (this.erase) { this.erase.geometry.dispose(); (this.erase.material as THREE.Material).dispose(); }
    this.surface = this.glass = this.line = null; this.erase = null;
  }
}

/** The body meshes and edge lines SceneManager drew (skipping ghosts, stencil helpers, caps, combs). */
function collect(group: THREE.Group): { meshes: THREE.Mesh[]; edges: THREE.LineSegments[] } {
  const meshes: THREE.Mesh[] = [], edges: THREE.LineSegments[] = [];
  group.traverse((o) => {
    if (o.userData.ghost) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && m.userData.bodyId != null && (m.material as THREE.Material).colorWrite !== false) meshes.push(m);
    const l = o as THREE.LineSegments;
    // SceneManager tags body edges (userData.edges); untagged depth-tested lines are kept for older callers, combs/decor never.
    if (l.isLineSegments && !l.userData.combs && !l.userData.decor && (l.userData.edges === true || (l.userData.edges == null && (l.material as THREE.LineBasicMaterial).depthTest !== false))) edges.push(l);
  });
  return { meshes, edges };
}

function clipOf(m: THREE.Mesh | undefined): THREE.Plane[] | null {
  const mat = m?.material as (THREE.Material & { clippingPlanes?: THREE.Plane[] | null }) | undefined;
  return mat?.clippingPlanes ?? null;
}

/** The lowest world height along `up` across the bodies (the print bed), and their overall extent. */
function bedLevel(meshes: THREE.Mesh[], up: THREE.Vector3): { bed: number; extent: number } {
  let lo = Infinity, hi = -Infinity;
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox!;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(m.matrixWorld);
      const h = v.dot(up);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  return Number.isFinite(lo) ? { bed: lo, extent: hi - lo } : { bed: 0, extent: 1 };
}
