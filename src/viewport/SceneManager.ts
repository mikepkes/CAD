import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PLANES, WorkPlane, planeById, to3d } from "../geometry/plane";
import { Sketch, SketchArc, SketchCircle, SketchLine, SketchPoint } from "../sketch/types";
import { isDimension } from "../sketch/types";

export interface PreviewGeom {
  segments?: { u1: number; v1: number; u2: number; v2: number }[];
  circles?: { cu: number; cv: number; r: number }[];
  arcs?: { cu: number; cv: number; r: number; a1: number; a2: number; ccw: boolean }[];
  snap?: { u: number; v: number; kind: string } | null;
  cursor?: { u: number; v: number } | null;
}

export interface SolidView {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edges: Float32Array;
}

export interface ViewData {
  mode: "model" | "sketch";
  planeId: string | null;
  sketch: Sketch | null;
  selection: Set<string>;
  hover: string | null;
  preview: PreviewGeom | null;
  showPlanes: boolean;
  showGrid: boolean;
  showConstraints: boolean;
  solids?: SolidView[];
}

export interface PickResult {
  type: "plane" | "entity" | "empty";
  id?: string;
  entityKind?: string;
  world?: THREE.Vector3;
}

const COLORS = {
  bg: 0x1b1d23,
  grid: 0x2d3340,
  gridMajor: 0x3a4152,
  geometry: 0xdfe6f2,
  construction: 0x8a93a6,
  selected: 0xffb454,
  hover: 0x5ac8fa,
  point: 0xbcc6d8,
  origin: 0xffd166,
  dimension: 0x7bd88f,
  fullyConstrained: 0x8fe388,
};

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private planeMeshes = new Map<string, THREE.Mesh>();
  private planeGroup = new THREE.Group();
  private grid: THREE.GridHelper;
  private sketchGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private solidsGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private disposed = false;
  private container: HTMLElement;
  private lastData: ViewData | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = "none";

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.bg);

    this.camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      100000
    );
    this.camera.up.set(0, 0, 1); // Z up
    this.camera.position.set(140, -180, 140);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0, 0, 0);

    // lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(1, -1, 2);
    this.scene.add(dir);

    // grid on XY (world), rotated so it lies in XY with Z up
    this.grid = new THREE.GridHelper(400, 40, COLORS.gridMajor, COLORS.grid);
    this.grid.rotation.x = Math.PI / 2;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(this.grid);

    this.buildAxes();
    this.buildPlanes();
    this.scene.add(this.planeGroup);
    this.scene.add(this.sketchGroup);
    this.scene.add(this.previewGroup);
    this.scene.add(this.solidsGroup);

    window.addEventListener("resize", this.onResize);
    this.animate();
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

  private onResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private animate = () => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
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
  pointerToUV(clientX: number, clientY: number, planeId: string): { u: number; v: number } | null {
    const p = planeById(planeId);
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
      for (const h of hits) {
        const id = h.object.userData?.id as string | undefined;
        if (id) return { type: "entity", id, entityKind: h.object.userData?.kind, world: h.point };
      }
      return { type: "empty", world: hits[0]?.point };
    } else {
      const meshes = [...this.planeMeshes.values()];
      const hits = this.raycaster.intersectObjects(meshes, false);
      if (hits.length) {
        return { type: "plane", id: hits[0].object.userData.planeId, world: hits[0].point };
      }
      return { type: "empty" };
    }
  }

  /** Public: approximate world/uv distance covered by `px` screen pixels. */
  pixelToWorld(px: number): number {
    return this.worldThreshold(px);
  }

  /** Approximate world-space size of `px` screen pixels at the target depth. */
  private worldThreshold(px: number): number {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const worldPerPixel = (2 * Math.tan(vFov / 2) * dist) / this.container.clientHeight;
    return px * worldPerPixel;
  }

  /** Smoothly orient the camera to look straight at a plane. */
  focusPlane(planeId: string) {
    const p = planeById(planeId);
    const target = new THREE.Vector3(p.origin.x, p.origin.y, p.origin.z);
    const normal = new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z);
    const dist = 180;
    const eye = target.clone().add(normal.multiplyScalar(dist));
    this.controls.target.copy(target);
    this.camera.position.copy(eye);
    this.camera.up.set(p.v.x, p.v.y, p.v.z);
    this.camera.lookAt(target);
    this.controls.update();
  }

  // ---- rendering the sketch ----

  update(data: ViewData) {
    this.lastData = data;
    this.planeGroup.visible = data.showPlanes && data.mode === "model";
    this.grid.visible = data.showGrid;

    this.clearGroup(this.sketchGroup);
    this.clearGroup(this.previewGroup);
    this.clearGroup(this.solidsGroup);

    // Solids render in model mode (and faded while sketching).
    this.solidsGroup.visible = !!data.solids && data.solids.length > 0;
    if (data.solids) for (const s of data.solids) this.renderSolid(s, data.mode === "sketch");

    if (data.sketch && data.planeId) {
      this.renderSketch(data.sketch, planeById(data.planeId), data);
      if (data.preview) this.renderPreview(data.preview, planeById(data.planeId));
    }
  }

  private renderSolid(s: SolidView, faded: boolean) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(s.positions, 3));
    if (s.normals.length === s.positions.length) geo.setAttribute("normal", new THREE.BufferAttribute(s.normals, 3));
    else geo.computeVertexNormals();
    geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
    const mat = new THREE.MeshStandardMaterial({
      color: 0x7b86e0,
      metalness: 0.15,
      roughness: 0.5,
      side: THREE.DoubleSide,
      transparent: faded,
      opacity: faded ? 0.25 : 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    this.solidsGroup.add(mesh);

    if (s.edges.length) {
      const egeo = new THREE.BufferGeometry();
      egeo.setAttribute("position", new THREE.BufferAttribute(s.edges, 3));
      const eseg = new THREE.LineSegments(
        egeo,
        new THREE.LineBasicMaterial({ color: 0x20242e, transparent: faded, opacity: faded ? 0.3 : 1 })
      );
      this.solidsGroup.add(eseg);
    }
  }

  get currentData() {
    return this.lastData;
  }

  private clearGroup(g: THREE.Group) {
    for (const child of [...g.children]) {
      g.remove(child);
      (child as any).geometry?.dispose?.();
      const m = (child as any).material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose?.();
    }
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

  private renderSketch(sk: Sketch, plane: WorkPlane, data: ViewData) {
    const pts = sk.entities;
    const getPt = (id: string) => pts[id] as SketchPoint;

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
        const color = this.colorFor(l.id, data, COLORS.geometry, l.construction);
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
          this.colorFor(c.id, data, COLORS.geometry, c.construction));
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
          this.colorFor(ar.id, data, COLORS.geometry, ar.construction));
        line.userData = { id: ar.id, kind: "arc" };
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
            : COLORS.point;
      const geo = new THREE.SphereGeometry(isOrigin ? 1.8 : 1.3, 10, 10);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
      const w = this.worldPt(plane, pt.x, pt.y);
      mesh.position.copy(w);
      mesh.userData = { id: pt.id, kind: "point" };
      this.sketchGroup.add(mesh);
    }

    // dimension labels (always) + geometric constraint glyphs (toggleable)
    for (const c of Object.values(sk.constraints)) {
      if (isDimension(c)) {
        const label = this.dimensionLabel(c.type, c.value);
        const pos = this.dimensionAnchor(sk, plane, c);
        if (pos) {
          const sprite = this.makeTextSprite(label, "#7bd88f");
          sprite.position.copy(pos);
          this.sketchGroup.add(sprite);
        }
      } else if (data.showConstraints) {
        const badge = this.constraintBadge(sk, plane, c as unknown as Record<string, string>);
        if (badge) {
          const sprite = this.makeTextSprite(badge.glyph, "#9ab0e8", 0.03);
          sprite.position.copy(badge.pos);
          this.sketchGroup.add(sprite);
        }
      }
    }
  }

  private static CONSTRAINT_GLYPH: Record<string, string> = {
    horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥",
    equal: "=", coincident: "●", pointOnLine: "⊢", pointOnCircle: "◠",
    concentric: "◎", tangent: "◯", symmetric: "⇔", fix: "⚓",
  };

  /** Anchor + glyph for a geometric constraint, offset slightly off the geometry. */
  private constraintBadge(sk: Sketch, plane: WorkPlane, c: Record<string, string>): { glyph: string; pos: THREE.Vector3 } | null {
    const glyph = SceneManager.CONSTRAINT_GLYPH[c.type];
    if (!glyph) return null;
    const P = (id: string) => sk.entities[id] as SketchPoint;
    const off = this.pixelToWorld(11);
    const at = (u: number, v: number) => this.worldPt(plane, u + off, v + off);
    try {
      if (c.type === "fix" || c.type === "pointOnLine" || c.type === "pointOnCircle") {
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

  private dimensionAnchor(sk: Sketch, plane: WorkPlane, c: any): THREE.Vector3 | null {
    const P = (id: string) => sk.entities[id] as SketchPoint;
    const mid = (a: SketchPoint, b: SketchPoint) => this.worldPt(plane, (a.x + b.x) / 2, (a.y + b.y) / 2);
    try {
      if (c.a && c.b) return mid(P(c.a), P(c.b));
      if (c.circle) {
        const e = sk.entities[c.circle] as SketchCircle;
        const ctr = P(e.center);
        return this.worldPt(plane, ctr.x + e.r, ctr.y);
      }
      if (c.line && c.point) {
        const p = P(c.point);
        return this.worldPt(plane, p.x, p.y);
      }
      if (c.l1 && c.l2) {
        const l = sk.entities[c.l1] as SketchLine;
        return mid(P(l.p1), P(l.p2));
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
    if (preview.snap) {
      // A flat ring on the sketch plane reads as a snap marker, not a floating sphere.
      const r = this.pixelToWorld(6);
      const ring = this.makeArcLine(plane, preview.snap.u, preview.snap.v, r, 0, Math.PI * 2, true, 0xffd166);
      this.previewGroup.add(ring);
    }
  }

  private makeTextSprite(text: string, color: string, heightFrac = 0.04): THREE.Sprite {
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
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      transparent: true,
      sizeAttenuation: false,
    });
    const sprite = new THREE.Sprite(mat);
    // With sizeAttenuation disabled, scale is a fraction of viewport height.
    const h = heightFrac;
    sprite.scale.set(h * (canvas.width / canvas.height), h, 1);
    sprite.renderOrder = 999;
    return sprite;
  }
}
