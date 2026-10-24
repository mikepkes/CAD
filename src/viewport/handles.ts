// Reusable 3D drag handles (manipulators).
//
// A handle is a 1-D arrow at an anchor pointing along an axis; dragging it maps
// pointer motion onto that axis and reports a signed value (world units) through
// onChange / onCommit. Nothing here knows about extrude — any feature can set a
// handle (extrude distance, offset, revolve angle via a linear proxy, …) by
// giving an anchor, an axis and callbacks. The owner sets handles imperatively
// so the callbacks keep working; the manager renders the arrows and does the
// drag math against a host that can build a pick ray and a pixel→world scale.

import * as THREE from "three";

export interface DragHandleSpec {
  id: string;
  /** Base of the arrow, in world space. */
  anchor: { x: number; y: number; z: number };
  /** Axis the handle slides along, in world space (need not be unit length). */
  dir: { x: number; y: number; z: number };
  /** Current signed value (distance from anchor along a unit `dir`). */
  value: number;
  color?: number;
  min?: number;
  max?: number;
  /** Fired continuously while dragging. */
  onChange?: (value: number) => void;
  /** Fired once on release. */
  onCommit?: (value: number) => void;
}

export interface HandleHost {
  /** A pick ray (world origin + unit dir) through a client point. */
  rayFrom(clientX: number, clientY: number): { origin: THREE.Vector3; dir: THREE.Vector3 };
  /** Approximate world size of `px` screen pixels (for screen-ish arrowheads). */
  pixelToWorld(px: number): number;
}

const V = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);

export class HandleManager {
  readonly group = new THREE.Group();
  private specs = new Map<string, DragHandleSpec>();
  private ray = new THREE.Raycaster();
  private dragState: { id: string; startValue: number; startT: number } | null = null;
  private hovered: string | null = null;

  constructor(private host: HandleHost) {}

  /** Replace the active handle set. An in-progress drag on a kept id survives. */
  set(specs: DragHandleSpec[]) {
    const dragId = this.dragState?.id;
    this.specs = new Map(specs.map((s) => [s.id, s]));
    if (dragId && !this.specs.has(dragId)) this.dragState = null;
    this.rebuild();
  }
  clear() {
    this.specs.clear();
    this.dragState = null;
    this.hovered = null;
    this.rebuild();
  }
  get active() { return this.specs.size > 0; }
  get dragging() { return this.dragState !== null; }

  private rebuild() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry?.dispose?.();
      const m = (c as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
    }
    for (const s of this.specs.values()) this.buildArrow(s);
  }

  private buildArrow(s: DragHandleSpec) {
    const base = V(s.anchor);
    const axis = V(s.dir).normalize();
    const sign = s.value < 0 ? -1 : 1;
    const tip = base.clone().addScaledVector(axis, s.value);
    const color = s.color ?? 0x5bbf84;
    const hot = this.hovered === s.id || this.dragState?.id === s.id;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: hot ? 1 : 0.85, depthTest: false });
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: hot ? 1 : 0.85, depthTest: false });

    const shaft = new THREE.Line(new THREE.BufferGeometry().setFromPoints([base, tip]), lineMat);
    shaft.renderOrder = 998;
    shaft.userData = { handleId: s.id };
    this.group.add(shaft);

    const coneLen = this.host.pixelToWorld(hot ? 20 : 16);
    const coneR = this.host.pixelToWorld(hot ? 7 : 6);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(coneR, coneLen, 14), mat);
    cone.renderOrder = 999;
    // Cone's local +Y points to its tip; aim it along sign*axis.
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().multiplyScalar(sign));
    cone.position.copy(tip).addScaledVector(axis, (sign * coneLen) / 2);
    cone.userData = { handleId: s.id };
    this.group.add(cone);

    // A little grab sphere at the tip widens the hit target.
    const grab = new THREE.Mesh(new THREE.SphereGeometry(coneR * 1.1, 10, 10), mat.clone());
    grab.position.copy(tip);
    grab.renderOrder = 999;
    grab.userData = { handleId: s.id };
    this.group.add(grab);
  }

  /** Handle id under a client point, or null. */
  hitTest(clientX: number, clientY: number): string | null {
    if (!this.specs.size) return null;
    const { origin, dir } = this.host.rayFrom(clientX, clientY);
    this.ray.set(origin, dir);
    this.ray.params.Line = { threshold: this.host.pixelToWorld(7) };
    const hits = this.ray.intersectObjects(this.group.children, false);
    for (const h of hits) {
      const id = h.object.userData?.handleId as string | undefined;
      if (id) return id;
    }
    return null;
  }

  setHover(id: string | null) {
    if (this.hovered === id || this.dragState) return;
    this.hovered = id;
    this.rebuild();
  }

  beginDrag(id: string, clientX: number, clientY: number): boolean {
    const s = this.specs.get(id);
    if (!s) return false;
    this.dragState = { id, startValue: s.value, startT: this.axisT(s, clientX, clientY) };
    this.rebuild();
    return true;
  }

  drag(clientX: number, clientY: number) {
    if (!this.dragState) return;
    const s = this.specs.get(this.dragState.id);
    if (!s) return;
    const t = this.axisT(s, clientX, clientY);
    let v = this.dragState.startValue + (t - this.dragState.startT);
    if (s.min != null) v = Math.max(s.min, v);
    if (s.max != null) v = Math.min(s.max, v);
    s.value = v;
    this.rebuild();
    s.onChange?.(v);
  }

  endDrag() {
    if (!this.dragState) return;
    const s = this.specs.get(this.dragState.id);
    this.dragState = null;
    this.rebuild();
    s?.onCommit?.(s.value);
  }

  /** Parameter `t` (world units from anchor along unit axis) of the pointer ray's
   *  closest approach to the handle axis — the core of 1-D gizmo dragging. */
  private axisT(s: DragHandleSpec, clientX: number, clientY: number): number {
    const { origin, dir: rayDir } = this.host.rayFrom(clientX, clientY);
    const axis = V(s.dir).normalize();
    const w0 = V(s.anchor).sub(origin);
    const b = axis.dot(rayDir);
    const d = axis.dot(w0);
    const e = rayDir.dot(w0);
    const denom = 1 - b * b; // a=c=1 for unit axis & unit ray dir
    if (Math.abs(denom) < 1e-6) return s.value; // ray ∥ axis
    return (b * e - d) / denom;
  }
}
