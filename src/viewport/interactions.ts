// Pointer interaction controller. Translates pointer events into command
// dispatches (draw tools) and selection/drag. Dragging a point runs a transient
// solve for live preview and commits a single moveGeometry command on release.

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as THREE from "three";
import { SceneManager, PreviewGeom, ViewData } from "./SceneManager";
import { GeoRef, useStore } from "../model/store";
import { SketchPoint } from "../sketch/types";
import { availableOps } from "../model/selectionOps";
import { infer, InferResult } from "./snapping";

type Snap = InferResult;

type Stage =
  | { kind: "idle" }
  | { kind: "line"; from: GeoRef; fromUV: { u: number; v: number }; startInfer?: { onLine?: string; midpointOf?: string } }
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
  // Snap + constraint inference. `from` (the active segment start, when drawing
  // a line) lets infer() record H/V, parallel and perpendicular intent and keeps
  // the cursor from snapping onto its own start point.
  private snap(clientX: number, clientY: number): Snap | null {
    const st = this.st();
    if (!st.activeSketchId) return null;
    const sk = st.session.doc.sketches[st.activeSketchId];
    const uv = this.scene.pointerToUV(clientX, clientY, sk.planeId);
    if (!uv) return null;
    let from: { u: number; v: number; id?: string } | undefined;
    if (this.stage.kind === "line") {
      const f = this.stage.from;
      from = { u: this.stage.fromUV.u, v: this.stage.fromUV.v, id: "ref" in f ? f.ref : undefined };
    }
    return infer(sk, { x: uv.u, y: uv.v }, (p) => this.scene.pixelToWorld(p), from);
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

    if (st.tool === "select" || st.tool === "dimension") {
      if (this.base) {
        const pick = this.scene.pick(e.clientX, e.clientY, this.base);
        const id = pick.type === "entity" ? pick.id ?? null : null;
        if (id !== st.hover) st.setHover(id);
      }
      // No snap ghost while selecting/dimensioning — only while drawing.
      if (this.preview) this.setPreview(null);
      return;
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
      case "dimension":
        this.handleDimensionClick(e);
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

  // Modal Dimension tool: click geometry to accumulate a selection; as soon as
  // the set is dimensionable, open the inline value editor (Fusion-style).
  private handleDimensionClick(e: PointerEvent) {
    const st = this.st();
    if (!this.base || !st.activeSketchId) return;
    const sk = st.session.doc.sketches[st.activeSketchId];
    if (!sk) return;
    const pick = this.scene.pick(e.clientX, e.clientY, this.base);
    if (pick.type !== "entity" || !pick.id) { st.clearSelection(); return; }
    const sel = st.selection.includes(pick.id) ? st.selection : [...st.selection, pick.id];
    const dims = availableOps(sk, sel).dimensions;
    if (dims.length) {
      // Prefer diameter on a circle (Fusion's default); otherwise the first.
      const chosen = dims.find((d) => d.id === "diameter") ?? dims[0];
      st.beginInlineEdit({
        mode: "new",
        params: chosen.command.params,
        value: String(chosen.command.params.expression ?? ""),
        screen: { x: e.clientX, y: e.clientY },
      });
      st.clearSelection();
    } else {
      st.select(sel);
    }
  }

  private async handleLineClick(snap: Snap) {
    const st = this.st();
    if (this.stage.kind !== "line") {
      // Remember start-on-line / start-at-midpoint intent; the start point is
      // only created on the next click (placeLine), so we apply it then.
      this.stage = {
        kind: "line",
        from: this.ref(snap),
        fromUV: { u: snap.u, v: snap.v },
        startInfer: snap.ref ? undefined : { onLine: snap.onLine, midpointOf: snap.midpointOf },
      };
      return;
    }
    const from = this.stage.from;
    const fromUV = this.stage.fromUV;
    const startInfer = this.stage.startInfer;
    // infer() has already repositioned snap.u/v for axis/parallel/perp intent,
    // so the committed geometry is exactly what the preview showed.
    if (!snap.ref && Math.hypot(snap.u - fromUV.u, snap.v - fromUV.v) < this.scene.pixelToWorld(4)) return;
    const end: GeoRef = snap.ref ? { ref: snap.ref } : { x: snap.u, y: snap.v };
    const r = await st.placeLine(from, end);
    if (r.ok && r.createdIds.length >= 3) {
      const lineId = r.createdIds[0];
      const startId = r.createdIds[1];
      const endId = r.createdIds[2];
      const sid = st.activeSketchId!;
      const add = (params: Record<string, unknown>) =>
        st.dispatch("sketch.addConstraint", { sketch: sid, ...params }, { rejectOnConflict: true });
      // Direction intent on the segment itself.
      if (snap.axis === "horizontal") await add({ type: "horizontal", a: startId, b: endId });
      else if (snap.axis === "vertical") await add({ type: "vertical", a: startId, b: endId });
      else if (snap.parallelTo) await add({ type: "parallel", l1: lineId, l2: snap.parallelTo });
      else if (snap.perpendicularTo) await add({ type: "perpendicular", l1: lineId, l2: snap.perpendicularTo });
      // Start-point intent, deferred from the previous click.
      if (startInfer?.midpointOf) await add({ type: "midpoint", point: startId, line: startInfer.midpointOf });
      else if (startInfer?.onLine) await add({ type: "pointOnLine", point: startId, line: startInfer.onLine });
      // End-point intent (coincident is implicit in placeLine's ref reuse).
      await this.applyPointInference(snap, endId);
      this.stage = { kind: "line", from: { ref: endId }, fromUV: { u: snap.u, v: snap.v } };
    } else {
      this.stage = { kind: "idle" };
    }
    this.setPreview(null);
  }

  /** Apply on-line / midpoint inference for a just-placed endpoint. */
  private async applyPointInference(snap: Snap, pointId?: string) {
    if (!pointId) return;
    const st = this.st();
    const sid = st.activeSketchId!;
    const add = (params: Record<string, unknown>) =>
      st.dispatch("sketch.addConstraint", { sketch: sid, ...params }, { rejectOnConflict: true });
    if (snap.midpointOf) await add({ type: "midpoint", point: pointId, line: snap.midpointOf });
    else if (snap.onLine) await add({ type: "pointOnLine", point: pointId, line: snap.onLine });
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

  private setPreview(p: PreviewGeom | null) {
    this.preview = p;
    this.render();
  }

  private updatePreview(snap: Snap) {
    const preview: PreviewGeom = {
      snap: snap.kind !== "free" ? { u: snap.u, v: snap.v, kind: snap.kind } : null,
      markers: snap.markers.length ? snap.markers : undefined,
    };
    if (this.stage.kind === "line") {
      preview.segments = [{ u1: this.stage.fromUV.u, v1: this.stage.fromUV.v, u2: snap.u, v2: snap.v }];
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

  private onDblClick = (e: MouseEvent) => {
    if (this.stage.kind === "line") {
      this.stage = { kind: "idle" };
      this.setPreview(null);
      return;
    }
    const st = this.st();
    if (st.mode !== "sketch" || !this.base || !st.activeSketchId) return;
    // Double-click a dimension label to edit its value/expression in place.
    const pick = this.scene.pick(e.clientX, e.clientY, this.base);
    if (pick.type === "entity" && pick.id && pick.entityKind === "dimension") {
      const sk = st.session.doc.sketches[st.activeSketchId];
      const c = sk?.constraints[pick.id] as { expr?: string } | undefined;
      if (c && typeof c.expr === "string") {
        st.beginInlineEdit({ mode: "edit", cid: pick.id, value: c.expr, screen: { x: e.clientX, y: e.clientY } });
      }
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
    const map: Record<string, any> = { l: "line", r: "rectangle", c: "circle", a: "arc", p: "point", s: "select", d: "dimension" };
    if (map[e.key.toLowerCase()]) st.setTool(map[e.key.toLowerCase()]);
    if ((e.key === "Delete" || e.key === "Backspace") && st.selection.length) st.deleteSelected();
  };
}
