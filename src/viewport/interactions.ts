// Pointer interaction controller. Translates pointer events into command
// dispatches (draw tools) and selection/drag. Dragging a point runs a transient
// solve for live preview and commits a single moveGeometry command on release.

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as THREE from "three";
import { SceneManager, PreviewGeom, ViewData } from "./SceneManager";
import { GeoRef, useStore } from "../model/store";
import { Sketch, SketchArc, SketchCircle, SketchPoint } from "../sketch/types";
import { resolveSketchPlane } from "../geometry/plane";
import { availableOps } from "../model/selectionOps";
import { infer, InferResult } from "./snapping";

type Snap = InferResult;

type Stage =
  | { kind: "idle" }
  | { kind: "line"; from: GeoRef; fromUV: { u: number; v: number }; startInfer?: { onLine?: string; midpointOf?: string } }
  | { kind: "rect"; from: { u: number; v: number } }
  | { kind: "circle"; center: GeoRef; centerUV: { u: number; v: number } }
  | { kind: "arc"; center?: GeoRef; centerUV?: { u: number; v: number }; start?: GeoRef; startUV?: { u: number; v: number } }
  | { kind: "polygon"; centerUV: { u: number; v: number } }
  | { kind: "pts"; pts: { u: number; v: number }[] }; // generic multi-click for tool variants

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
  private boxStart: { x: number; y: number } | null = null;
  private boxDiv: HTMLDivElement | null = null;

  constructor(scene: SceneManager, dom: HTMLElement) {
    this.scene = scene;
    this.dom = dom;
    dom.addEventListener("pointerdown", this.onDown);
    dom.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    dom.addEventListener("dblclick", this.onDblClick);
    dom.addEventListener("contextmenu", this.onContext);
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("chisel:lookAt", this.onLookAt as EventListener);
  }

  dispose() {
    this.dom.removeEventListener("pointerdown", this.onDown);
    this.dom.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.dom.removeEventListener("dblclick", this.onDblClick);
    this.dom.removeEventListener("contextmenu", this.onContext);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("chisel:lookAt", this.onLookAt as EventListener);
  }

  private onLookAt = () => {
    const st = this.st();
    if (st.mode === "sketch" && st.activeSketchId) {
      const sk = st.session.doc.sketches[st.activeSketchId];
      if (sk) this.scene.focusPlane(resolveSketchPlane(sk));
    }
  };

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
    const uv = this.scene.pointerToUV(clientX, clientY, resolveSketchPlane(sk));
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

  // ---- box (rubber-band) selection ----
  private updateBox(x: number, y: number) {
    if (!this.boxStart) return;
    if (!this.boxDiv) {
      const div = document.createElement("div");
      div.className = "box-select";
      (this.dom.parentElement ?? document.body).appendChild(div);
      this.boxDiv = div;
    }
    const x0 = Math.min(this.boxStart.x, x), y0 = Math.min(this.boxStart.y, y);
    const w = Math.abs(x - this.boxStart.x), h = Math.abs(y - this.boxStart.y);
    // Left→right = window (solid); right→left = crossing (dashed), per Fusion.
    const crossing = x < this.boxStart.x;
    const s = this.boxDiv.style;
    s.left = `${x0}px`; s.top = `${y0}px`; s.width = `${w}px`; s.height = `${h}px`;
    this.boxDiv.classList.toggle("crossing", crossing);
  }

  private clearBox() {
    this.boxStart = null;
    if (this.boxDiv) { this.boxDiv.remove(); this.boxDiv = null; }
  }

  private commitBoxSelect(start: { x: number; y: number }, end: { x: number; y: number }, additive: boolean) {
    const st = this.st();
    if (!st.activeSketchId) return;
    const sk = st.session.doc.sketches[st.activeSketchId];
    if (!sk) return;
    const crossing = end.x < start.x;
    const box = {
      x0: Math.min(start.x, end.x), y0: Math.min(start.y, end.y),
      x1: Math.max(start.x, end.x), y1: Math.max(start.y, end.y),
    };
    const ids = this.entitiesInBox(sk, box, crossing);
    if (ids.length || !additive) st.select(ids, additive);
  }

  private entitiesInBox(
    sk: Sketch,
    box: { x0: number; y0: number; x1: number; y1: number },
    crossing: boolean
  ): string[] {
    const plane = resolveSketchPlane(sk);
    const P = (id: string) => sk.entities[id] as SketchPoint;
    const toS = (u: number, v: number) => this.scene.uvToScreen(plane, u, v);
    const inRect = (p: { x: number; y: number }) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1;

    // Rule for a list of screen samples: window = all inside; crossing = any inside.
    const matchSamples = (pts: { x: number; y: number }[]) =>
      crossing ? pts.some(inRect) : pts.every(inRect);

    const curves: string[] = [];
    const referenced = new Set<string>();
    for (const e of Object.values(sk.entities) as any[]) {
      if (e.kind === "line") {
        const a = toS(P(e.p1).x, P(e.p1).y), b = toS(P(e.p2).x, P(e.p2).y);
        const hit = crossing ? (inRect(a) || inRect(b) || segIntersectsRect(a, b, box)) : (inRect(a) && inRect(b));
        if (hit) { curves.push(e.id); referenced.add(e.p1); referenced.add(e.p2); }
      } else if (e.kind === "circle" || e.kind === "arc") {
        const c = sk.entities[e.center] as SketchPoint;
        let a0 = 0, span = Math.PI * 2;
        if (e.kind === "arc") {
          const arc = e as SketchArc;
          const s = P(arc.p1), t = P(arc.p2);
          a0 = Math.atan2(s.y - c.y, s.x - c.x);
          let a2 = Math.atan2(t.y - c.y, t.x - c.x);
          span = a2 - a0;
          if (arc.ccw) { while (span <= 0) span += Math.PI * 2; } else { while (span >= 0) span -= Math.PI * 2; }
          referenced.add(arc.p1); referenced.add(arc.p2);
        }
        const samples = sampleRing(c, (e as SketchCircle).r, a0, span).map((s) => toS(s.x, s.y));
        if (matchSamples(samples)) { curves.push(e.id); referenced.add(e.center); }
      }
    }
    // Standalone points (not owned by a selected curve) that fall inside.
    const points: string[] = [];
    for (const e of Object.values(sk.entities) as any[]) {
      if (e.kind === "point" && !referenced.has(e.id) && inRect(toS(e.x, e.y))) points.push(e.id);
    }
    return [...curves, ...points];
  }

  // ---- events ----
  private onDown = (e: PointerEvent) => {
    if (this.st().contextMenu) this.st().closeContextMenu();
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
          return;
        }
      }
      // Empty space (or a curve) → a drag here becomes a box selection.
      this.boxStart = { x: e.clientX, y: e.clientY };
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
      const uv = this.scene.pointerToUV(e.clientX, e.clientY, resolveSketchPlane(st.session.doc.sketches[st.activeSketchId!]));
      if (uv) st.dragTo(uv.u, uv.v);
      return;
    }

    if (this.boxStart && this.moved) {
      this.updateBox(e.clientX, e.clientY);
      return;
    }

    if (st.tool === "select" || st.tool === "dimension" || st.tool === "trim" || st.tool === "extend") {
      if (this.base) {
        const pick = this.scene.pick(e.clientX, e.clientY, this.base);
        const id = pick.type === "entity" ? pick.id ?? null : null;
        if (id !== st.hover) st.setHover(id);
      }
      // No snap ghost while selecting/dimensioning/trimming — only while drawing.
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
        else if (pick.type === "face" && pick.world && pick.normal) {
          st.startSketchOnFace({ x: pick.world.x, y: pick.world.y, z: pick.world.z }, pick.normal);
        }
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
    if (this.boxStart) {
      const start = this.boxStart;
      const hadBox = !!this.boxDiv;
      this.clearBox();
      if (hadBox && this.moved) {
        this.commitBoxSelect(start, { x: e.clientX, y: e.clientY }, e.shiftKey);
        this.downPt = null;
        return;
      }
    }
    if (this.downPt && !this.moved && e.button === 0) {
      const snap = this.snap(e.clientX, e.clientY);
      if (snap) void this.onClick(snap, e);
    }
    this.downPt = null;
  };

  /** Shape tools that use the generic multi-point flow (variants + slot). */
  private isVariantShape(tool: string, variant: string): boolean {
    return (tool === "circle" && variant !== "center") ||
      (tool === "rectangle" && variant !== "corner") ||
      (tool === "arc" && variant !== "center") ||
      tool === "slot" || tool === "ellipse";
  }

  private async onClick(snap: Snap, e: PointerEvent) {
    const st = this.st();
    if (this.isVariantShape(st.tool, st.toolVariant)) { await this.handleVariantShape(snap); return; }
    switch (st.tool) {
      case "select":
        this.handleSelectClick(e);
        break;
      case "dimension":
        this.handleDimensionClick(e);
        break;
      case "trim":
        await this.handleCurveActionClick(e, "sketch.trim");
        break;
      case "extend":
        await this.handleCurveActionClick(e, "sketch.extend");
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
      case "polygon":
        await this.handlePolygonClick(snap);
        break;
    }
  }

  private variantNeed(tool: string, variant: string): number {
    if (tool === "circle") return variant === "2point" ? 2 : 3;
    if (tool === "rectangle") return variant === "center" ? 2 : 3;
    if (tool === "arc") return 3; // 3-point
    if (tool === "slot") return 3;
    if (tool === "ellipse") return 3;
    return 2;
  }

  private async handleVariantShape(snap: Snap) {
    const st = this.st();
    const need = this.variantNeed(st.tool, st.toolVariant);
    const pts = this.stage.kind === "pts" ? this.stage.pts.slice() : [];
    pts.push({ u: snap.u, v: snap.v });
    if (pts.length < need) { this.stage = { kind: "pts", pts }; return; }
    await this.executeVariant(st.tool, st.toolVariant, pts);
    this.stage = { kind: "idle" };
    this.setPreview(null);
  }

  private async executeVariant(tool: string, variant: string, pts: { u: number; v: number }[]) {
    const st = this.st();
    const P = (i: number) => ({ x: pts[i].u, y: pts[i].v });
    if (tool === "circle") {
      if (variant === "2point") {
        const c = { x: (pts[0].u + pts[1].u) / 2, y: (pts[0].v + pts[1].v) / 2 };
        const r = Math.hypot(pts[1].u - pts[0].u, pts[1].v - pts[0].v) / 2;
        if (r > 1e-3) await st.placeCircle(c, r);
      } else {
        const f = circleFrom3(P(0), P(1), P(2));
        if (f) await st.placeCircle({ x: f.x, y: f.y }, f.r);
      }
    } else if (tool === "rectangle") {
      if (variant === "center") {
        const c = pts[0], p = pts[1];
        await st.placeRectangle({ x: 2 * c.u - p.u, y: 2 * c.v - p.v }, { x: p.u, y: p.v });
      } else {
        await st.placeRectangle3(P(0), P(1), P(2));
      }
    } else if (tool === "arc") {
      const start = P(0), end = P(1), mid = P(2);
      const f = circleFrom3(start, mid, end);
      if (f) {
        const cr = (start.x - f.x) * (mid.y - f.y) - (start.y - f.y) * (mid.x - f.x);
        await st.placeArc({ x: f.x, y: f.y }, start, end, cr < 0);
      }
    } else if (tool === "slot") {
      const p1 = P(0), p2 = P(1), p3 = P(2);
      const dx = p2.x - p1.x, dy = p2.y - p1.y, m = Math.hypot(dx, dy) || 1;
      const width = 2 * Math.abs((-dy * (p3.x - p1.x) + dx * (p3.y - p1.y)) / m);
      if (width > 1e-3) await st.placeSlot(p1, p2, width);
    } else if (tool === "ellipse") {
      const c = P(0), major = P(1), minor = P(2);
      const rx = Math.hypot(major.x - c.x, major.y - c.y);
      const rotation = Math.atan2(major.y - c.y, major.x - c.x);
      const ry = Math.abs(-Math.sin(rotation) * (minor.x - c.x) + Math.cos(rotation) * (minor.y - c.y));
      if (rx > 1e-3 && ry > 1e-3) await st.placeEllipse(c, rx, ry, rotation);
    }
  }

  private variantPreview(preview: PreviewGeom, pts: { u: number; v: number }[], snap: Snap) {
    const st = this.st();
    const all = [...pts, { u: snap.u, v: snap.v }];
    const toP = (p: { u: number; v: number }) => ({ x: p.u, y: p.v });
    const seg = (a: { u: number; v: number }, b: { u: number; v: number }) => ({ u1: a.u, v1: a.v, u2: b.u, v2: b.v });
    if (st.tool === "circle") {
      if (st.toolVariant === "2point" && all.length >= 2) {
        const c = { u: (all[0].u + all[1].u) / 2, v: (all[0].v + all[1].v) / 2 };
        preview.circles = [{ cu: c.u, cv: c.v, r: Math.hypot(all[1].u - all[0].u, all[1].v - all[0].v) / 2 }];
      } else if (st.toolVariant === "3point" && all.length >= 3) {
        const f = circleFrom3(toP(all[0]), toP(all[1]), toP(all[2]));
        if (f) preview.circles = [{ cu: f.x, cv: f.y, r: f.r }];
      } else if (all.length >= 2) {
        preview.segments = [seg(all[0], all[all.length - 1])];
      }
    } else if (st.tool === "rectangle") {
      if (st.toolVariant === "center" && all.length >= 2) {
        const c = all[0], p = all[1];
        const c0 = { u: 2 * c.u - p.u, v: 2 * c.v - p.v };
        preview.segments = [seg(c0, { u: p.u, v: c0.v }), seg({ u: p.u, v: c0.v }, p), seg(p, { u: c0.u, v: p.v }), seg({ u: c0.u, v: p.v }, c0)];
      } else if (st.toolVariant === "3point" && all.length >= 2) {
        const p1 = all[0], p2 = all[1];
        let dx = p2.u - p1.u, dy = p2.v - p1.v; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
        const px = -dy, py = dx;
        const w = all.length >= 3 ? (all[2].u - p2.u) * px + (all[2].v - p2.v) * py : 0;
        const c2 = { u: p2.u + px * w, v: p2.v + py * w }, c3 = { u: p1.u + px * w, v: p1.v + py * w };
        preview.segments = [seg(p1, p2), seg(p2, c2), seg(c2, c3), seg(c3, p1)];
      } else if (all.length >= 1) {
        preview.segments = [seg(all[0], all[all.length - 1])];
      }
    } else if (st.tool === "arc" && all.length >= 3) {
      const f = circleFrom3(toP(all[0]), toP(all[2]), toP(all[1]));
      if (f) {
        const cr = (all[0].u - f.x) * (all[2].v - f.y) - (all[0].v - f.y) * (all[2].u - f.x);
        preview.arcs = [{ cu: f.x, cv: f.y, r: f.r, a1: Math.atan2(all[0].v - f.y, all[0].u - f.x), a2: Math.atan2(all[1].v - f.y, all[1].u - f.x), ccw: cr < 0 }];
      }
    } else if (st.tool === "slot" && all.length >= 2) {
      const p1 = all[0], p2 = all[1];
      let dx = p2.u - p1.u, dy = p2.v - p1.v; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const px = -dy, py = dx;
      const r = all.length >= 3 ? Math.abs((-dy * (all[2].u - p1.u) + dx * (all[2].v - p1.v))) : 0;
      const A = { u: p1.u - px * r, v: p1.v - py * r }, B = { u: p2.u - px * r, v: p2.v - py * r };
      const C = { u: p2.u + px * r, v: p2.v + py * r }, D = { u: p1.u + px * r, v: p1.v + py * r };
      preview.segments = [seg(A, B), seg(C, D)];
      preview.arcs = [
        { cu: p2.u, cv: p2.v, r, a1: Math.atan2(B.v - p2.v, B.u - p2.u), a2: Math.atan2(C.v - p2.v, C.u - p2.u), ccw: true },
        { cu: p1.u, cv: p1.v, r, a1: Math.atan2(D.v - p1.v, D.u - p1.u), a2: Math.atan2(A.v - p1.v, A.u - p1.u), ccw: true },
      ];
    } else if (st.tool === "ellipse" && all.length >= 2) {
      const c = all[0], major = all[1];
      const rx = Math.hypot(major.u - c.u, major.v - c.v);
      const rotation = Math.atan2(major.v - c.v, major.u - c.u);
      const ry = all.length >= 3 ? Math.abs(-Math.sin(rotation) * (all[2].u - c.u) + Math.cos(rotation) * (all[2].v - c.v)) : rx * 0.6;
      preview.ellipses = [{ cu: c.u, cv: c.v, rx, ry, rotation }];
    } else if (all.length >= 1) {
      preview.segments = [seg(all[0], all[all.length - 1])];
    }
  }

  private async handlePolygonClick(snap: Snap) {
    const st = this.st();
    if (this.stage.kind !== "polygon") {
      this.stage = { kind: "polygon", centerUV: { u: snap.u, v: snap.v } };
      return;
    }
    const c = this.stage.centerUV;
    if (Math.hypot(snap.u - c.u, snap.v - c.v) > 1e-3) {
      await st.placePolygon({ x: c.u, y: c.v }, { x: snap.u, y: snap.v });
    }
    this.stage = { kind: "idle" };
    this.setPreview(null);
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

  // Trim / Extend: click a curve; the exact click point selects the span (trim)
  // or the end (extend) to act on.
  private async handleCurveActionClick(e: PointerEvent, command: "sketch.trim" | "sketch.extend") {
    const st = this.st();
    if (!this.base || !st.activeSketchId) return;
    const sk = st.session.doc.sketches[st.activeSketchId];
    if (!sk) return;
    const pick = this.scene.pick(e.clientX, e.clientY, this.base);
    if (pick.type !== "entity" || !pick.id) return;
    const ent = sk.entities[pick.id];
    if (!ent || (ent.kind !== "line" && ent.kind !== "circle" && ent.kind !== "arc")) return;
    // Use the exact click point on the plane (not a snapped grid point).
    const uv = this.scene.pointerToUV(e.clientX, e.clientY, resolveSketchPlane(sk));
    if (!uv) return;
    await st.dispatch(command, { sketch: st.activeSketchId, target: pick.id, u: uv.u, v: uv.v });
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
    } else if (this.stage.kind === "pts") {
      this.variantPreview(preview, this.stage.pts, snap);
    } else if (this.stage.kind === "polygon") {
      const c = this.stage.centerUV;
      const r = Math.hypot(snap.u - c.u, snap.v - c.v);
      const base = Math.atan2(snap.v - c.v, snap.u - c.u);
      const N = 6;
      const segs: { u1: number; v1: number; u2: number; v2: number }[] = [];
      for (let i = 0; i < N; i++) {
        const a1 = base + (i * 2 * Math.PI) / N, a2 = base + ((i + 1) * 2 * Math.PI) / N;
        segs.push({ u1: c.u + r * Math.cos(a1), v1: c.v + r * Math.sin(a1), u2: c.u + r * Math.cos(a2), v2: c.v + r * Math.sin(a2) });
      }
      preview.segments = segs;
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
    const st = this.st();
    if (st.mode !== "sketch") return;
    // During an active draw, right-click cancels the tool (Fusion behaviour).
    if (this.stage.kind !== "idle") {
      e.preventDefault();
      this.stage = { kind: "idle" };
      this.setPreview(null);
      return;
    }
    if ((st.tool === "select" || st.tool === "dimension") && this.base) {
      e.preventDefault();
      // If right-clicking an unselected entity, select it first.
      const pick = this.scene.pick(e.clientX, e.clientY, this.base);
      if (pick.type === "entity" && pick.id && !st.selection.includes(pick.id)) st.select([pick.id]);
      st.openContextMenu(e.clientX, e.clientY);
    }
  };

  private onKey = (e: KeyboardEvent) => {
    const st = this.st();
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Escape") {
      if (st.contextMenu) { st.closeContextMenu(); return; }
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
    // X toggles construction (reference) geometry on the selection.
    if (e.key.toLowerCase() === "x" && st.selection.length && st.activeSketchId) {
      const sk = st.session.doc.sketches[st.activeSketchId];
      const op = availableOps(sk, st.selection).modify.find((o) => o.id === "construction");
      if (op) { void st.dispatch(op.command.type, op.command.params); return; }
    }
    const map: Record<string, any> = { l: "line", r: "rectangle", c: "circle", a: "arc", g: "polygon", o: "slot", p: "point", s: "select", d: "dimension", t: "trim", e: "extend", i: "ellipse" };
    if (map[e.key.toLowerCase()]) st.setTool(map[e.key.toLowerCase()]);
    if ((e.key === "Delete" || e.key === "Backspace") && st.selection.length) st.deleteSelected();
  };
}

type Pt = { x: number; y: number };
type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Circle through 3 points; null if collinear. */
function circleFrom3(a: Pt, b: Pt, c: Pt): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x: ux, y: uy, r: Math.hypot(a.x - ux, a.y - uy) };
}

/** Does segment a-b cross any edge of the (screen-space) rect? */
function segIntersectsRect(a: Pt, b: Pt, r: Rect): boolean {
  const corners = [
    { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 },
  ];
  for (let i = 0; i < 4; i++) {
    if (segSeg(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

function segSeg(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Sample points along a ring arc (center c, radius r, from a0 sweeping span). */
function sampleRing(c: Pt, r: number, a0: number, span: number): Pt[] {
  const out: Pt[] = [{ x: c.x, y: c.y }];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const a = a0 + (span * i) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}
