// Pointer interaction controller. Translates pointer events into command
// dispatches (draw tools) and selection/drag. Dragging a point runs a transient
// solve for live preview and commits a single moveGeometry command on release.

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as THREE from "three";
import { SceneManager, PreviewGeom, ViewData } from "./SceneManager";
import { GeoRef, useStore } from "../model/store";
import { SketchPoint } from "../sketch/types";

interface Snap {
  u: number;
  v: number;
  ref?: string; // existing point id when snapped to one
  kind: string;
}

type Stage =
  | { kind: "idle" }
  | { kind: "line"; from: GeoRef; fromUV: { u: number; v: number } }
  | { kind: "rect"; from: { u: number; v: number } }
  | { kind: "circle"; center: GeoRef; centerUV: { u: number; v: number } }
  | { kind: "arc"; center?: GeoRef; centerUV?: { u: number; v: number }; start?: GeoRef; startUV?: { u: number; v: number } };

export class Interactions {
  private scene: SceneManager;
  private dom: HTMLElement;
  private stage: Stage = { kind: "idle" };
  private preview: PreviewGeom | null = null;
  private cursorUV: { u: number; v: number } | null = null;
  private base: ViewData | null = null;

  private downPt: { x: number; y: number } | null = null;
  private dragging = false;
  private moved = false;

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

  configureControls(controls: OrbitControls, mode: "model" | "sketch") {
    if (mode === "sketch") {
      controls.mouseButtons = { LEFT: null as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
      controls.touches = { ONE: null as any, TWO: THREE.TOUCH.DOLLY_PAN };
    } else {
      controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }
  }

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
    this.scene.update({ ...this.base, preview: this.preview ? { ...this.preview, cursor: this.cursorUV } : null });
  }

  private st() {
    return useStore.getState();
  }

  // ---- snapping ----
  private snap(clientX: number, clientY: number): Snap | null {
    const st = this.st();
    if (!st.activeSketchId) return null;
    const sk = st.session.doc.sketches[st.activeSketchId];
    const uv = this.scene.pointerToUV(clientX, clientY, sk.planeId);
    if (!uv) return null;
    const thr = this.scene.pixelToWorld(10);

    let best: Snap | null = null;
    let bestD = thr;
    for (const e of Object.values(sk.entities)) {
      if (e.kind !== "point") continue;
      const p = e as SketchPoint;
      const d = Math.hypot(p.x - uv.u, p.y - uv.v);
      if (d < bestD) {
        bestD = d;
        best = { u: p.x, v: p.y, ref: p.id, kind: p.id === sk.originPointId ? "origin" : "point" };
      }
    }
    if (best) return best;

    const g = 5;
    const gu = Math.round(uv.u / g) * g;
    const gv = Math.round(uv.v / g) * g;
    if (Math.hypot(gu - uv.u, gv - uv.v) < this.scene.pixelToWorld(6)) return { u: gu, v: gv, kind: "grid" };
    return { u: uv.u, v: uv.v, kind: "free" };
  }

  private ref(snap: Snap): GeoRef {
    return snap.ref ? { ref: snap.ref } : { x: snap.u, y: snap.v };
  }

  // ---- events ----
  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.downPt = { x: e.clientX, y: e.clientY };
    this.moved = false;
    const st = this.st();
    if (st.mode !== "sketch") return;

    if (st.tool === "select" && this.base) {
      const pick = this.scene.pick(e.clientX, e.clientY, this.base);
      if (pick.type === "entity" && pick.id) {
        const sk = st.session.doc.sketches[st.activeSketchId!];
        const ent = sk.entities[pick.id];
        if (ent && ent.kind === "point" && !(ent as SketchPoint).fixed) {
          this.dragging = true;
          st.beginDrag(pick.id);
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }
      }
    }
  };

  private onMove = (e: PointerEvent) => {
    const st = this.st();
    if (st.mode !== "sketch") return;
    if (this.downPt) {
      const d = Math.hypot(e.clientX - this.downPt.x, e.clientY - this.downPt.y);
      if (d > 3) this.moved = true;
    }
    const snap = this.snap(e.clientX, e.clientY);
    if (!snap) return;
    this.cursorUV = { u: snap.u, v: snap.v };

    if (this.dragging) {
      // use raw uv (don't snap to the dragged point itself)
      const uv = this.scene.pointerToUV(e.clientX, e.clientY, st.session.doc.sketches[st.activeSketchId!].planeId);
      if (uv) st.dragTo(uv.u, uv.v);
      return;
    }

    if (st.tool === "select" && this.base) {
      const pick = this.scene.pick(e.clientX, e.clientY, this.base);
      const id = pick.type === "entity" ? pick.id ?? null : null;
      if (id !== st.hover) st.setHover(id);
    }

    this.updatePreview(snap);
  };

  private onUp = (e: PointerEvent) => {
    const st = this.st();
    if (st.mode === "model") {
      if (!this.moved && this.downPt && this.base) {
        const pick = this.scene.pick(e.clientX, e.clientY, this.base);
        if (pick.type === "plane" && pick.id) st.startSketch(pick.id);
      }
      this.downPt = null;
      return;
    }
    if (this.dragging) {
      this.dragging = false;
      this.downPt = null;
      st.endDrag();
      return;
    }
    if (this.downPt && !this.moved && e.button === 0) {
      const snap = this.snap(e.clientX, e.clientY);
      if (snap) void this.onClick(snap, e);
    }
    this.downPt = null;
  };

  private async onClick(snap: Snap, e: PointerEvent) {
    const st = this.st();
    switch (st.tool) {
      case "select":
        this.handleSelectClick(e);
        break;
      case "point":
        await st.placePoint(snap.u, snap.v);
        break;
      case "line":
        await this.handleLineClick(snap);
        break;
      case "rectangle":
        await this.handleRectClick(snap);
        break;
      case "circle":
        await this.handleCircleClick(snap);
        break;
      case "arc":
        await this.handleArcClick(snap);
        break;
    }
  }

  private handleSelectClick(e: PointerEvent) {
    const st = this.st();
    if (!this.base) return;
    const pick = this.scene.pick(e.clientX, e.clientY, this.base);
    if (pick.type === "entity" && pick.id) {
      if (e.shiftKey) st.toggleSelect(pick.id);
      else st.select([pick.id]);
    } else if (!e.shiftKey) {
      st.clearSelection();
    }
  }

  private async handleLineClick(snap: Snap) {
    const st = this.st();
    if (this.stage.kind !== "line") {
      this.stage = { kind: "line", from: this.ref(snap), fromUV: { u: snap.u, v: snap.v } };
      return;
    }
    const from = this.stage.from;
    const fromUV = this.stage.fromUV;
    const adj = this.axisSnap(fromUV, snap);
    const end = snap.ref ? ({ ref: snap.ref } as GeoRef) : ({ x: adj.u, y: adj.v } as GeoRef);
    const r = await st.placeLine(from, end);
    if (r.ok && r.createdIds.length >= 3) {
      const startId = r.createdIds[1];
      const endId = r.createdIds[2];
      await this.autoAxis(startId, endId);
      this.stage = { kind: "line", from: { ref: endId }, fromUV: { u: adj.u, v: adj.v } };
    } else {
      this.stage = { kind: "idle" };
    }
    this.setPreview(null);
  }

  private async handleRectClick(snap: Snap) {
    const st = this.st();
    if (this.stage.kind !== "rect") {
      this.stage = { kind: "rect", from: { u: snap.u, v: snap.v } };
      return;
    }
    const a = this.stage.from;
    await st.placeRectangle({ x: a.u, y: a.v }, { x: snap.u, y: snap.v });
    this.stage = { kind: "idle" };
    this.setPreview(null);
  }

  private async handleCircleClick(snap: Snap) {
    const st = this.st();
    if (this.stage.kind !== "circle") {
      this.stage = { kind: "circle", center: this.ref(snap), centerUV: { u: snap.u, v: snap.v } };
      return;
    }
    const c = this.stage.centerUV;
    const radius = Math.hypot(snap.u - c.u, snap.v - c.v);
    if (radius > 1e-3) await st.placeCircle(this.stage.center, radius);
    this.stage = { kind: "idle" };
    this.setPreview(null);
  }

  private async handleArcClick(snap: Snap) {
    const st = this.st();
    if (this.stage.kind !== "arc") {
      this.stage = { kind: "arc", center: this.ref(snap), centerUV: { u: snap.u, v: snap.v } };
      return;
    }
    if (!this.stage.start) {
      this.stage = { ...this.stage, start: this.ref(snap), startUV: { u: snap.u, v: snap.v } };
      return;
    }
    const c = this.stage.centerUV!;
    const s = this.stage.startUV!;
    const a1 = Math.atan2(s.v - c.v, s.u - c.u);
    const a2 = Math.atan2(snap.v - c.v, snap.u - c.u);
    let sweep = a2 - a1;
    while (sweep < 0) sweep += Math.PI * 2;
    await st.placeArc(this.stage.center!, this.stage.start!, this.ref(snap), sweep <= Math.PI);
    this.stage = { kind: "idle" };
    this.setPreview(null);
  }

  private axisSnap(from: { u: number; v: number }, snap: Snap): { u: number; v: number } {
    if (snap.ref) return { u: snap.u, v: snap.v };
    const tol = this.scene.pixelToWorld(8);
    return {
      u: Math.abs(snap.u - from.u) < tol ? from.u : snap.u,
      v: Math.abs(snap.v - from.v) < tol ? from.v : snap.v,
    };
  }

  private async autoAxis(startId: string, endId: string) {
    const st = this.st();
    const sk = st.session.doc.sketches[st.activeSketchId!];
    const a = sk.entities[startId] as SketchPoint;
    const b = sk.entities[endId] as SketchPoint;
    if (!a || !b) return;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const tol = len * 0.04;
    // rejectOnConflict so an auto-constraint that would over-constrain is skipped
    if (dy < tol && dx > dy) await st.dispatch("sketch.addConstraint", { sketch: sk.id, type: "horizontal", a: startId, b: endId }, { rejectOnConflict: true });
    else if (dx < tol && dy > dx) await st.dispatch("sketch.addConstraint", { sketch: sk.id, type: "vertical", a: startId, b: endId }, { rejectOnConflict: true });
  }

  private setPreview(p: PreviewGeom | null) {
    this.preview = p;
    this.render();
  }

  private updatePreview(snap: Snap) {
    const preview: PreviewGeom = { snap: snap.kind !== "free" ? { u: snap.u, v: snap.v, kind: snap.kind } : null };
    if (this.stage.kind === "line") {
      const adj = this.axisSnap(this.stage.fromUV, snap);
      preview.segments = [{ u1: this.stage.fromUV.u, v1: this.stage.fromUV.v, u2: adj.u, v2: adj.v }];
    } else if (this.stage.kind === "rect") {
      const a = this.stage.from;
      preview.segments = [
        { u1: a.u, v1: a.v, u2: snap.u, v2: a.v },
        { u1: snap.u, v1: a.v, u2: snap.u, v2: snap.v },
        { u1: snap.u, v1: snap.v, u2: a.u, v2: snap.v },
        { u1: a.u, v1: snap.v, u2: a.u, v2: a.v },
      ];
    } else if (this.stage.kind === "circle") {
      const c = this.stage.centerUV;
      preview.circles = [{ cu: c.u, cv: c.v, r: Math.hypot(snap.u - c.u, snap.v - c.v) }];
    } else if (this.stage.kind === "arc") {
      if (this.stage.centerUV && !this.stage.startUV) {
        const c = this.stage.centerUV;
        preview.circles = [{ cu: c.u, cv: c.v, r: Math.hypot(snap.u - c.u, snap.v - c.v) }];
      } else if (this.stage.centerUV && this.stage.startUV) {
        const c = this.stage.centerUV;
        const s = this.stage.startUV;
        const r = Math.hypot(s.u - c.u, s.v - c.v);
        preview.arcs = [{ cu: c.u, cv: c.v, r, a1: Math.atan2(s.v - c.v, s.u - c.u), a2: Math.atan2(snap.v - c.v, snap.u - c.u), ccw: true }];
      }
    }
    this.setPreview(preview);
  }

  private onDblClick = () => {
    if (this.stage.kind === "line") {
      this.stage = { kind: "idle" };
      this.setPreview(null);
    }
  };

  private onContext = (e: MouseEvent) => {
    if (this.st().mode === "sketch" && this.stage.kind !== "idle") {
      e.preventDefault();
      this.stage = { kind: "idle" };
      this.setPreview(null);
    }
  };

  private onKey = (e: KeyboardEvent) => {
    const st = this.st();
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Escape") {
      if (this.stage.kind !== "idle") { this.stage = { kind: "idle" }; this.setPreview(null); }
      else if (st.tool !== "select") st.setTool("select");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) st.redo(); else st.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); st.redo(); return; }
    if (st.mode !== "sketch") return;
    const map: Record<string, any> = { l: "line", r: "rectangle", c: "circle", a: "arc", p: "point", s: "select" };
    if (map[e.key.toLowerCase()]) st.setTool(map[e.key.toLowerCase()]);
    if ((e.key === "Delete" || e.key === "Backspace") && st.selection.length) st.deleteSelected();
  };
}
