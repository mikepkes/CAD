// Pointer interaction controller: translates pointer events into sketch tool
// actions (draw line/rect/circle/arc, select, drag) and manages preview geom.

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as THREE from "three";
import { SceneManager, PreviewGeom, ViewData } from "./SceneManager";
import { useStore } from "../model/store";
import { SketchPoint } from "../sketch/types";

interface Snap {
  u: number;
  v: number;
  pointId?: string;
  kind: string;
}

type ToolStage =
  | { kind: "idle" }
  | { kind: "line"; from: string } // chaining from a point id
  | { kind: "rect"; from: Snap }
  | { kind: "circle"; center: string }
  | { kind: "arc"; center?: string; start?: string };

export class Interactions {
  private scene: SceneManager;
  private dom: HTMLElement;
  private stage: ToolStage = { kind: "idle" };
  private preview: PreviewGeom | null = null;
  private cursorUV: { u: number; v: number } | null = null;

  private downPt: { x: number; y: number } | null = null;
  private dragging: { pointId: string } | null = null;
  private moved = false;
  private base: ViewData | null = null;

  constructor(scene: SceneManager, dom: HTMLElement) {
    this.scene = scene;
    this.dom = dom;
    dom.addEventListener("pointerdown", this.onDown);
    dom.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    dom.addEventListener("dblclick", this.onDblClick);
    dom.addEventListener("contextmenu", this.onContext);
    window.addEventListener("keydown", this.onKey);
  }

  dispose() {
    this.dom.removeEventListener("pointerdown", this.onDown);
    this.dom.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.dom.removeEventListener("dblclick", this.onDblClick);
    this.dom.removeEventListener("contextmenu", this.onContext);
    window.removeEventListener("keydown", this.onKey);
  }

  /** Reconfigure orbit controls for the current mode. */
  configureControls(controls: OrbitControls, mode: "model" | "sketch") {
    if (mode === "sketch") {
      controls.mouseButtons = {
        LEFT: null as any,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE,
      };
      controls.touches = { ONE: null as any, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
      controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }
  }

  private viewData(): ViewData | null {
    return this.base;
  }

  /** Store the store-derived view data and re-render (preserving preview). */
  setBase(data: ViewData) {
    this.base = data;
    if (data.mode !== "sketch") {
      this.stage = { kind: "idle" };
      this.preview = null;
    }
    this.render();
  }

  private render() {
    if (!this.base) return;
    this.scene.update({
      ...this.base,
      preview: this.preview ? { ...this.preview, cursor: this.cursorUV } : null,
    });
  }

  private state() {
    return useStore.getState();
  }

  // ---- snapping ----
  private snap(clientX: number, clientY: number): Snap | null {
    const st = this.state();
    if (!st.activeSketchId) return null;
    const sk = st.sketches[st.activeSketchId];
    const uv = this.scene.pointerToUV(clientX, clientY, sk.planeId);
    if (!uv) return null;
    const thr = this.scene.pixelToWorld(10);

    // snap to existing points
    let best: Snap | null = null;
    let bestD = thr;
    for (const e of Object.values(sk.entities)) {
      if (e.kind !== "point") continue;
      const p = e as SketchPoint;
      const d = Math.hypot(p.x - uv.u, p.y - uv.v);
      if (d < bestD) {
        bestD = d;
        best = { u: p.x, v: p.y, pointId: p.id, kind: p.id === sk.originPointId ? "origin" : "point" };
      }
    }
    if (best) return best;

    // snap to grid (5 units) when close
    const g = 5;
    const gu = Math.round(uv.u / g) * g;
    const gv = Math.round(uv.v / g) * g;
    if (Math.hypot(gu - uv.u, gv - uv.v) < this.scene.pixelToWorld(6)) {
      return { u: gu, v: gv, kind: "grid" };
    }
    return { u: uv.u, v: uv.v, kind: "free" };
  }

  /** Get an existing point id for a snap, or create a new point. */
  private resolvePoint(snap: Snap): string {
    const st = this.state();
    if (snap.pointId) return snap.pointId;
    return st.createPoint(st.activeSketchId!, snap.u, snap.v);
  }

  private setPreview(p: PreviewGeom | null) {
    this.preview = p;
    this.pushView();
  }

  /** Re-publish preview + cursor into the scene. */
  pushView() {
    this.render();
  }

  // ---- event handlers ----
  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // only primary; other buttons go to orbit
    this.downPt = { x: e.clientX, y: e.clientY };
    this.moved = false;
    const st = this.state();

    if (st.mode === "model") return; // plane picking handled on click (up)

    const data = this.viewData();
    if (!data) return;

    // select tool: maybe start dragging a point
    if (st.tool === "select") {
      const pick = this.scene.pick(e.clientX, e.clientY, data);
      if (pick.type === "entity" && pick.id) {
        const sk = st.sketches[st.activeSketchId!];
        const ent = sk.entities[pick.id];
        if (ent && ent.kind === "point" && !(ent as SketchPoint).fixed) {
          this.dragging = { pointId: pick.id };
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }
      }
      return;
    }
  };

  private onMove = (e: PointerEvent) => {
    const st = this.state();
    if (st.mode !== "sketch") return;
    if (this.downPt) {
      const dx = e.clientX - this.downPt.x;
      const dy = e.clientY - this.downPt.y;
      if (Math.hypot(dx, dy) > 3) this.moved = true;
    }

    const snap = this.snap(e.clientX, e.clientY);
    if (!snap) return;
    this.cursorUV = { u: snap.u, v: snap.v };

    // dragging a point
    if (this.dragging) {
      st.solveActive({ pointId: this.dragging.pointId, x: snap.u, y: snap.v });
      return;
    }

    // hover highlight (select tool)
    if (st.tool === "select" && this.base) {
      const pick = this.scene.pick(e.clientX, e.clientY, this.base);
      const id = pick.type === "entity" ? pick.id ?? null : null;
      if (id !== st.hover) st.setHover(id);
    }

    // tool previews
    this.updatePreview(snap);
  };

  private onUp = (e: PointerEvent) => {
    const st = this.state();

    if (st.mode === "model") {
      if (!this.moved && this.downPt) {
        const data = this.viewData();
        if (data) {
          const pick = this.scene.pick(e.clientX, e.clientY, data);
          if (pick.type === "plane" && pick.id) st.startSketch(pick.id);
        }
      }
      this.downPt = null;
      return;
    }

    if (this.dragging) {
      this.dragging = null;
      this.downPt = null;
      return;
    }

    // treat as a click only if the pointer didn't move much
    if (this.downPt && !this.moved && e.button === 0) {
      const snap = this.snap(e.clientX, e.clientY);
      if (snap) this.onClick(snap, e);
    }
    this.downPt = null;
  };

  private onClick(snap: Snap, e: PointerEvent) {
    const st = this.state();
    switch (st.tool) {
      case "select":
        this.handleSelectClick(e);
        break;
      case "point":
        this.resolvePoint(snap);
        st.solveActive();
        break;
      case "line":
        this.handleLineClick(snap);
        break;
      case "rectangle":
        this.handleRectClick(snap);
        break;
      case "circle":
        this.handleCircleClick(snap);
        break;
      case "arc":
        this.handleArcClick(snap);
        break;
    }
  }

  private handleSelectClick(e: PointerEvent) {
    const st = this.state();
    const data = this.viewData();
    if (!data) return;
    const pick = this.scene.pick(e.clientX, e.clientY, data);
    if (pick.type === "entity" && pick.id) {
      if (e.shiftKey) st.toggleSelect(pick.id);
      else st.select([pick.id]);
    } else {
      if (!e.shiftKey) st.clearSelection();
    }
  }

  private handleLineClick(snap: Snap) {
    const st = this.state();
    if (this.stage.kind !== "line") {
      const from = this.resolvePoint(snap);
      this.stage = { kind: "line", from };
      return;
    }
    const from = this.stage.from;
    // apply auto h/v snapping on the endpoint
    const fromPt = st.sketches[st.activeSketchId!].entities[from] as SketchPoint;
    const adjusted = this.applyAxisSnap(fromPt, snap);
    const to = this.resolvePoint(adjusted);
    if (to === from) return;
    const lineId = st.createLine(st.activeSketchId!, from, to);
    this.autoAxisConstraint(from, to);
    void lineId;
    st.solveActive();
    // continue chain from the new point
    this.stage = { kind: "line", from: to };
  }

  private handleRectClick(snap: Snap) {
    const st = this.state();
    if (this.stage.kind !== "rect") {
      this.stage = { kind: "rect", from: snap };
      return;
    }
    const a = this.stage.from;
    const sid = st.activeSketchId!;
    // four corners
    const p00 = st.createPoint(sid, a.u, a.v);
    const p10 = st.createPoint(sid, snap.u, a.v);
    const p11 = st.createPoint(sid, snap.u, snap.v);
    const p01 = st.createPoint(sid, a.u, snap.v);
    const l1 = st.createLine(sid, p00, p10);
    const l2 = st.createLine(sid, p10, p11);
    const l3 = st.createLine(sid, p11, p01);
    const l4 = st.createLine(sid, p01, p00);
    st.addGeometric({ type: "horizontal", a: p00, b: p10 });
    st.addGeometric({ type: "horizontal", a: p01, b: p11 });
    st.addGeometric({ type: "vertical", a: p00, b: p01 });
    st.addGeometric({ type: "vertical", a: p10, b: p11 });
    void [l1, l2, l3, l4];
    this.stage = { kind: "idle" };
    this.setPreview(null);
    st.solveActive();
  }

  private handleCircleClick(snap: Snap) {
    const st = this.state();
    if (this.stage.kind !== "circle") {
      const center = this.resolvePoint(snap);
      this.stage = { kind: "circle", center };
      return;
    }
    const sid = st.activeSketchId!;
    const c = st.sketches[sid].entities[this.stage.center] as SketchPoint;
    const r = Math.hypot(snap.u - c.x, snap.v - c.y);
    if (r > 1e-3) st.createCircle(sid, this.stage.center, r);
    this.stage = { kind: "idle" };
    this.setPreview(null);
    st.solveActive();
  }

  private handleArcClick(snap: Snap) {
    const st = this.state();
    const sid = st.activeSketchId!;
    if (this.stage.kind !== "arc") {
      const center = this.resolvePoint(snap);
      this.stage = { kind: "arc", center };
      return;
    }
    if (!this.stage.start) {
      const start = this.resolvePoint(snap);
      this.stage = { kind: "arc", center: this.stage.center, start };
      return;
    }
    // third click = end point
    const center = this.stage.center!;
    const start = this.stage.start!;
    const c = st.sketches[sid].entities[center] as SketchPoint;
    const r = Math.hypot(
      (st.sketches[sid].entities[start] as SketchPoint).x - c.x,
      (st.sketches[sid].entities[start] as SketchPoint).y - c.y
    );
    // project end click onto radius so the end point sits on the arc
    const ang = Math.atan2(snap.v - c.y, snap.u - c.x);
    const end = st.createPoint(sid, c.x + r * Math.cos(ang), c.y + r * Math.sin(ang));
    const s = st.sketches[sid].entities[start] as SketchPoint;
    const a1 = Math.atan2(s.y - c.y, s.x - c.x);
    let ccw = ang - a1;
    while (ccw < 0) ccw += Math.PI * 2;
    st.createArc(sid, center, start, end, ccw <= Math.PI);
    this.stage = { kind: "idle" };
    this.setPreview(null);
    st.solveActive();
  }

  /** Snap an endpoint onto the horizontal/vertical axis of `from` when close. */
  private applyAxisSnap(from: SketchPoint, snap: Snap): Snap {
    if (snap.pointId) return snap; // don't override an explicit point snap
    const tol = this.scene.pixelToWorld(8);
    let u = snap.u;
    let v = snap.v;
    if (Math.abs(snap.u - from.x) < tol) u = from.x;
    if (Math.abs(snap.v - from.y) < tol) v = from.y;
    return { ...snap, u, v };
  }

  private autoAxisConstraint(from: string, to: string) {
    const st = this.state();
    const sk = st.sketches[st.activeSketchId!];
    const a = sk.entities[from] as SketchPoint;
    const b = sk.entities[to] as SketchPoint;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const tol = len * 0.04;
    if (dy < tol && dx > dy) st.addGeometric({ type: "horizontal", a: from, b: to });
    else if (dx < tol && dy > dx) st.addGeometric({ type: "vertical", a: from, b: to });
  }

  private updatePreview(snap: Snap) {
    const preview: PreviewGeom = { snap: snap.kind !== "free" ? snap : null };
    const st = this.state();
    const sk = st.activeSketchId ? st.sketches[st.activeSketchId] : null;
    if (!sk) return;

    if (this.stage.kind === "line") {
      const f = sk.entities[this.stage.from] as SketchPoint;
      const adj = this.applyAxisSnap(f, snap);
      preview.segments = [{ u1: f.x, v1: f.y, u2: adj.u, v2: adj.v }];
    } else if (this.stage.kind === "rect") {
      const a = this.stage.from;
      preview.segments = [
        { u1: a.u, v1: a.v, u2: snap.u, v2: a.v },
        { u1: snap.u, v1: a.v, u2: snap.u, v2: snap.v },
        { u1: snap.u, v1: snap.v, u2: a.u, v2: snap.v },
        { u1: a.u, v1: snap.v, u2: a.u, v2: a.v },
      ];
    } else if (this.stage.kind === "circle") {
      const c = sk.entities[this.stage.center] as SketchPoint;
      preview.circles = [{ cu: c.x, cv: c.y, r: Math.hypot(snap.u - c.x, snap.v - c.y) }];
    } else if (this.stage.kind === "arc") {
      if (this.stage.center && !this.stage.start) {
        const c = sk.entities[this.stage.center] as SketchPoint;
        preview.circles = [{ cu: c.x, cv: c.y, r: Math.hypot(snap.u - c.x, snap.v - c.y) }];
      } else if (this.stage.center && this.stage.start) {
        const c = sk.entities[this.stage.center] as SketchPoint;
        const s = sk.entities[this.stage.start] as SketchPoint;
        const r = Math.hypot(s.x - c.x, s.y - c.y);
        const a1 = Math.atan2(s.y - c.y, s.x - c.x);
        const a2 = Math.atan2(snap.v - c.y, snap.u - c.x);
        preview.arcs = [{ cu: c.x, cv: c.y, r, a1, a2, ccw: true }];
      }
    }
    this.setPreview(preview);
  }

  private onDblClick = () => {
    // end a line chain
    if (this.stage.kind === "line") {
      this.stage = { kind: "idle" };
      this.setPreview(null);
    }
  };

  private onContext = (e: MouseEvent) => {
    if (this.state().mode === "sketch" && this.stage.kind !== "idle") {
      e.preventDefault();
      this.stage = { kind: "idle" };
      this.setPreview(null);
    }
  };

  private onKey = (e: KeyboardEvent) => {
    const st = this.state();
    if (e.key === "Escape") {
      if (this.stage.kind !== "idle") {
        this.stage = { kind: "idle" };
        this.setPreview(null);
      } else if (st.tool !== "select") {
        st.setTool("select");
      }
      return;
    }
    if (st.mode !== "sketch") return;
    // ignore when typing in inputs
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const map: Record<string, any> = { l: "line", r: "rectangle", c: "circle", a: "arc", p: "point", s: "select" };
    if (map[e.key.toLowerCase()]) st.setTool(map[e.key.toLowerCase()]);
    if ((e.key === "Delete" || e.key === "Backspace") && st.selection.length) {
      st.deleteEntities(st.selection);
    }
  };

  resetStage() {
    this.stage = { kind: "idle" };
    this.setPreview(null);
  }
}
