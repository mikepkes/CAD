// The OCC side of sheet metal (see core/sheet.ts): the flat blank as a face,
// cut into panels and bend pieces, and the folded solid built from them —
// panels moved rigidly, each bend piece wrapped exactly onto its cylinder
// (its edges keep their shape in the cylinder's (angle, axial) parameter
// space, so a slanted edge becomes a helix) and given thickness, each sharp
// crease filled with the wedge of material outside it.

import { getOC, cast } from "replicad";
import type { Shape3D } from "replicad";
import type { Profile, Pt } from "../geometry/profile";
import type { Rigid } from "../../math/transform";
import type { BlankOp, Seg } from "../sheet";
import { planeById } from "../../geometry/plane";
import { regionsFace, kernelErrorMessage, thickenShape, brepOfShape } from "./kernel";

type OcAny = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const XY = planeById("XY");
const OC = () => getOC() as OcAny;
const raw = (s: Shape3D): OcAny => (s as unknown as { wrapped: OcAny }).wrapped;
const wrap = (r: OcAny): Shape3D => cast(r as never) as unknown as Shape3D;
const free = (...xs: { delete?(): void }[]) => { for (const x of xs) { try { x?.delete?.(); } catch { /* already freed */ } } };

function explore(shape: OcAny, kind: "FACE" | "EDGE" | "WIRE"): OcAny[] {
  const oc = OC();
  const ex = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum[`TopAbs_${kind}`], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const out: OcAny[] = [];
  for (; ex.More(); ex.Next()) out.push(kind === "FACE" ? oc.TopoDS.Face(ex.Current()) : kind === "EDGE" ? oc.TopoDS.Edge(ex.Current()) : oc.TopoDS.Wire(ex.Current()));
  ex.delete();
  return out;
}

const pnt = (x: number, y: number, z: number) => new (OC().gp_Pnt)(x, y, z);
const dir = (x: number, y: number, z: number) => new (OC().gp_Dir)(x, y, z);

/** A closed planar polygon (3D points) as a face. */
function polygon3(pts: { x: number; y: number; z: number }[]): OcAny {
  const oc = OC();
  const mw = new oc.BRepBuilderAPI_MakeWire();
  const owned: { delete?(): void }[] = [mw];
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    const a = pnt(p.x, p.y, p.z), b = pnt(q.x, q.y, q.z);
    const me = new oc.BRepBuilderAPI_MakeEdge(a, b);
    mw.Add(me.Edge());
    owned.push(a, b, me);
  });
  const mf = new oc.BRepBuilderAPI_MakeFace(mw.Wire(), true);
  const f = mf.Face();
  free(mf, ...owned);
  return f;
}

/** A flat polygon (local z = 0) as a face. */
const polyFace = (pts: Pt[]): OcAny => polygon3(pts.map((p) => ({ x: p.x, y: p.y, z: 0 })));

type Kind = "fuse" | "cut" | "common";
function boolean(kind: Kind, a: OcAny, b: OcAny): OcAny {
  const oc = OC();
  const ctor = kind === "fuse" ? oc.BRepAlgoAPI_Fuse : kind === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
  const op = new ctor(a, b);
  try {
    op.Build();
    if (!op.IsDone()) throw new Error(`sheet ${kind} failed in the kernel`);
    op.SimplifyResult(true, true, 1e-6);
    return op.Shape();
  } finally { op.delete(); }
}

/** A face swept up along z (from z0, by h): a thin slab standing in for it in solid booleans. */
function slab(face: OcAny, z0: number, h: number): OcAny {
  const oc = OC();
  const moved = z0 ? place(face, { origin: { x: 0, y: 0, z: z0 }, x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } }) : face;
  const v = new oc.gp_Vec(0, 0, h);
  const pr = new oc.BRepPrimAPI_MakePrism(moved, v, false, true);
  pr.Build();
  const out = pr.Shape();
  free(pr, v);
  return out;
}

/** The blank (local flat coords) as a face: its base, then each added/cut
 *  polygon. The 2D booleans run on unit-thick slabs (solid booleans merge
 *  coplanar faces and collinear edges reliably) and the blank is the slab's
 *  bottom face. */
export function blankFace(base: { regions: Profile[] } | { brep: string }, ops: BlankOp[]): Shape3D {
  const oc = OC();
  const face0 = "regions" in base ? raw(regionsFace(XY, base.regions)) : upward(oc.BRepToolsWrapper.Read(base.brep));
  if (!ops.some((o) => o.poly.length >= 3)) {
    if (!explore(face0, "FACE").length) throw new Error("the sheet's blank is empty");
    return wrap(face0);
  }
  let solid = slab(face0, 0, 1);
  for (const o of ops) {
    if (o.poly.length < 3) continue;
    const pf = polyFace(o.poly);
    const tool = o.op === "add" ? slab(pf, 0, 1) : slab(pf, -1, 3);
    solid = boolean(o.op === "add" ? "fuse" : "cut", solid, tool);
    free(pf);
  }
  solid = unify(solid);
  const bottom = explore(solid, "FACE").filter((f) => {
    const w = wrap(f) as unknown as { geomType: string; center: { z: number }; normalAt(): { z: number } };
    return String(w.geomType).toUpperCase() === "PLANE" && Math.abs(w.center.z) < 1e-9 && w.normalAt().z < -0.999;
  });
  if (!bottom.length) throw new Error("the sheet's blank is empty");
  return wrap(upward(compound(bottom)));
}

function compound(faces: OcAny[]): OcAny {
  if (faces.length === 1) return faces[0];
  const oc = OC(), b = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  b.MakeCompound(comp);
  for (const f of faces) b.Add(comp, f);
  free(b);
  return comp;
}

/** Flat faces turned to face +z (a slab's bottom face, read back, faces down). */
function upward(shape: OcAny): OcAny {
  const oc = OC();
  const faces = explore(shape, "FACE").map((f) => ((wrap(f) as unknown as { normalAt(): { z: number } }).normalAt().z < 0 ? oc.TopoDS.Face(f.Reversed()) : f));
  return compound(faces);
}

/** Merge coplanar neighbouring faces and collinear edges. */
function unify(shape: OcAny): OcAny {
  const oc = OC();
  const u = new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false);
  u.Build();
  const out = u.Shape();
  u.delete();
  return out;
}

/** A face's edges sampled (each its OCC type and points along it). */
export function faceEdges(face: Shape3D | OcAny): { type: string; pts: Pt[] }[] {
  const shape = (face as { wrapped?: unknown }).wrapped ? face as Shape3D : wrap(face);
  const edges = (shape as unknown as { edges: { geomType: string; length: number; pointAt(t: number): { x: number; y: number }; delete(): void }[] }).edges;
  try {
    return edges.map((e) => {
      const type = String(e.geomType).toUpperCase();
      const n = type === "LINE" ? 1 : Math.max(8, Math.min(96, Math.ceil(e.length / 2)));
      const pts = Array.from({ length: n + 1 }, (_, i) => { const p = e.pointAt(i / n); return { x: p.x, y: p.y }; });
      return { type, pts };
    });
  } finally { for (const e of edges) free(e); }
}

const segsOf = (edges: { pts: Pt[] }[]): Seg[] => edges.flatMap((e) => e.pts.slice(1).map((p, i) => [e.pts[i], p] as Seg));

export interface FlatSplit {
  /** Flat panels (faces) and their outlines. */
  panels: { face: OcAny; segs: Seg[] }[];
  /** Bend pieces: the part of the blank inside a bend zone. */
  pieces: { strip: number; face: OcAny; segs: Seg[] }[];
}

export interface Strip { a: Pt; b: Pt; half: number; extend: boolean; id: string }

/**
 * Cut the blank into bend pieces (blank ∩ each bend zone — for an extended
 * bend, only the stretch its line runs through) and panels (the rest, split
 * along the creases).
 */
export function splitBlank(blank: Shape3D, strips: Strip[], creases: { a: Pt; b: Pt }[], onLine: (strip: number, segs: Seg[]) => boolean): FlatSplit {
  const oc = OC();
  const b0 = raw(blank);
  const box = faceEdges(b0).flatMap((e) => e.pts);
  const big = 2 * Math.max(1, ...box.map((p) => Math.hypot(p.x, p.y)));
  const pieces: FlatSplit["pieces"] = [];
  strips.forEach((st, i) => {
    const L = Math.hypot(st.b.x - st.a.x, st.b.y - st.a.y);
    const e = { x: (st.b.x - st.a.x) / L, y: (st.b.y - st.a.y) / L }, d = { x: -e.y, y: e.x };
    const ext = st.extend ? big : 0;
    const at = (p: Pt, s: number, u: number) => ({ x: p.x + e.x * s + d.x * u, y: p.y + e.y * s + d.y * u });
    const rect = polyFace([at(st.a, -ext, -st.half), at(st.b, ext, -st.half), at(st.b, ext, st.half), at(st.a, -ext, st.half)]);
    const common = boolean("common", b0, rect);
    free(rect);
    for (const f of explore(common, "FACE")) {
      const segs = segsOf(faceEdges(f));
      if (!st.extend || onLine(i, segs)) pieces.push({ strip: i, face: f, segs });
    }
  });
  // bend zones may not overlap (two bends crossing): there'd be no telling which way the overlap folds
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
    if (pieces[i].strip === pieces[j].strip) continue;
    const c = boolean("common", pieces[i].face, pieces[j].face);
    const area = explore(c, "FACE").reduce((s, f) => s + areaOf(f), 0);
    if (area > 1e-6) throw new Error(`bends "${strips[pieces[i].strip].id}" and "${strips[pieces[j].strip].id}" cross — move one, or cut a relief where they meet`);
  }
  let rest = b0;
  for (const p of pieces) rest = boolean("cut", rest, p.face);
  if (creases.length) {
    const sp = new oc.BRepAlgoAPI_Splitter();
    const args = new oc.NCollection_List_TopoDS_Shape(), tools = new oc.NCollection_List_TopoDS_Shape();
    args.Append(rest);
    for (const c of creases) {
      const p = pnt(c.a.x, c.a.y, 0), q = pnt(c.b.x, c.b.y, 0);
      const me = new oc.BRepBuilderAPI_MakeEdge(p, q);
      tools.Append(me.Edge());
      free(me, p, q);
    }
    sp.SetArguments(args);
    sp.SetTools(tools);
    try { sp.SetFuzzyValue(1e-6); } catch { /* older builds: exact */ }
    sp.Build();
    if (!sp.IsDone()) { sp.delete(); throw new Error("couldn't split the paper along its creases"); }
    rest = sp.Shape();
    free(sp, args, tools);
  }
  const panels = explore(rest, "FACE").map((face) => ({ face, segs: segsOf(faceEdges(face)) }));
  return { panels, pieces };
}

function areaOf(face: OcAny): number {
  const oc = OC();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(face, props, 1e-7, false);
  const a = props.Mass();
  props.delete();
  return a;
}

function trsfOf(T: Rigid): OcAny {
  const t = new (OC().gp_Trsf)();
  t.SetValues(T.x.x, T.y.x, T.z.x, T.origin.x, T.x.y, T.y.y, T.z.y, T.origin.y, T.x.z, T.y.z, T.z.z, T.origin.z);
  return t;
}

/** Copy of a shape moved by a rigid transform. */
function place(shape: OcAny, T: Rigid): OcAny {
  const oc = OC();
  const tr = trsfOf(T);
  const b = new oc.BRepBuilderAPI_Transform(shape, tr, true, false);
  const out = b.Shape();
  free(b, tr);
  return out;
}

export interface BendPlacement { face: OcAny; T: Rigid; O: Pt; e: Pt; d: Pt; half: number; angle: number; radius: number }
export interface WedgePlacement { T: Rigid; O: Pt; e: Pt; s0: number; s1: number; angle: number }

/**
 * A flat bend piece wrapped onto its bend's inner cylinder. Across the zone
 * (u ∈ [−half, half]) maps linearly to the bend angle; along the fold line to
 * the cylinder's axis — a linear map of the piece's own 2D curves, so the
 * wrapped face is exact.
 */
function wrapBend(b: BendPlacement, t: number): OcAny {
  const oc = OC();
  const sgn = b.angle > 0 ? 1 : -1, th = Math.abs(b.angle);
  const hz = b.angle > 0 ? t + b.radius : -b.radius;
  const A = { x: b.O.x - b.d.x * b.half, y: b.O.y - b.d.y * b.half };
  const p0 = pnt(A.x, A.y, hz), z = dir(sgn * b.e.x, sgn * b.e.y, 0), x = dir(0, 0, -sgn);
  const ax = new oc.gp_Ax3(p0, z, x);
  const surf = new oc.Geom_CylindricalSurface(ax, b.radius);
  free(p0, z, x, ax);
  const map = (px: number, py: number): [number, number] => {
    const dx = px - b.O.x, dy = py - b.O.y;
    const u = dx * b.d.x + dy * b.d.y, s = dx * b.e.x + dy * b.e.y;
    return [(th * (u + b.half)) / (2 * b.half), sgn * s];
  };
  const builder = new oc.TopoDS_Builder();
  const outer = oc.BRepTools.OuterWire(b.face);
  let outerWire: OcAny;
  const holes: OcAny[] = [];
  for (const w of explore(b.face, "WIRE")) {
    const nw = new oc.TopoDS_Wire();
    builder.MakeWire(nw);
    for (const edge of explore(w, "EDGE")) {
      // the piece lies on z = 0, so its 3D curve (as a B-spline) is its 2D
      // curve too; mapping the poles maps the curve exactly (affine map)
      const res = oc.BRep_Tool.Curve(edge, 0, 0);
      const tc = new oc.Geom_TrimmedCurve(res.returnValue, res.First, res.Last, true, true);
      const bs = oc.GeomConvert.CurveToBSplineCurve(tc, oc.Convert_ParameterisationType.Convert_TgtThetaOver2);
      const n = bs.NbPoles(), nk = bs.NbKnots();
      const poles = new oc.NCollection_Array1_gp_Pnt2d(1, n), weights = new oc.NCollection_Array1_double(1, n);
      for (let i = 1; i <= n; i++) {
        const P = bs.Pole(i);
        const [U, V] = map(P.X(), P.Y());
        const Q = new oc.gp_Pnt2d(U, V);
        poles.SetValue(i, Q);
        weights.SetValue(i, bs.Weight(i));
        free(P, Q);
      }
      const K = new oc.NCollection_Array1_double(1, nk), M = new oc.NCollection_Array1_int(1, nk);
      for (let i = 1; i <= nk; i++) { K.SetValue(i, bs.Knot(i)); M.SetValue(i, bs.Multiplicity(i)); }
      const c2 = new oc.Geom2d_BSplineCurve(poles, weights, K, M, bs.Degree(), bs.IsPeriodic());
      const mk = new oc.BRepBuilderAPI_MakeEdge(c2, surf, c2.FirstParameter(), c2.LastParameter());
      let ne = mk.Edge();
      if (edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) ne = oc.TopoDS.Edge(ne.Reversed());
      builder.Add(nw, ne);
      free(mk, tc, poles, weights, K, M);
    }
    oc.BRepLib.BuildCurves3d(nw);
    if (w.IsSame(outer)) outerWire = nw; else holes.push(nw);
  }
  if (!outerWire) throw new Error("a bend piece has no outer boundary");
  const mf = new oc.BRepBuilderAPI_MakeFace(surf, outerWire, true);
  for (const h of holes) mf.Add(h);
  const fix = new oc.ShapeFix_Face(mf.Face());
  fix.SetPrecision(1e-7);
  fix.Perform();
  fix.FixOrientation();
  const face = fix.Face();
  free(fix, mf, builder);
  return face;
}

/** The wedge filling the outside of a sharp crease: the panel's end face swept about the crease axis. */
function wedge(w: WedgePlacement, t: number): OcAny {
  const oc = OC();
  const at = (s: number, z: number) => ({ x: w.O.x + w.e.x * s, y: w.O.y + w.e.y * s, z });
  const face = polygon3([at(w.s0, 0), at(w.s1, 0), at(w.s1, t), at(w.s0, t)]);
  const sgn = w.angle > 0 ? 1 : -1;
  const A = pnt(w.O.x, w.O.y, w.angle > 0 ? t : 0), D = dir(sgn * w.e.x, sgn * w.e.y, 0);
  const ax = new oc.gp_Ax1(A, D);
  const rv = new oc.BRepPrimAPI_MakeRevol(face, ax, Math.abs(w.angle), false);
  rv.Build();
  const out = rv.Shape();
  free(rv, ax, A, D);
  return out;
}

/** Fuse many solids at once. */
function fuseAll(shapes: OcAny[]): OcAny {
  if (shapes.length === 1) return shapes[0];
  const oc = OC();
  const f = new oc.BRepAlgoAPI_Fuse();
  const args = new oc.NCollection_List_TopoDS_Shape(), tools = new oc.NCollection_List_TopoDS_Shape();
  args.Append(shapes[0]);
  for (const s of shapes.slice(1)) tools.Append(s);
  f.SetArguments(args);
  f.SetTools(tools);
  try { f.SetFuzzyValue(1e-6); } catch { /* exact */ }
  f.Build();
  if (!f.IsDone()) { f.delete(); throw new Error("couldn't join the sheet's panels and bends"); }
  f.SimplifyResult(true, true, 1e-6);
  const out = f.Shape();
  free(f, args, tools);
  return out;
}

/**
 * The folded sheet (local coords; `frame` places it): panels as prisms of
 * thickness `t` (faces when t = 0), bends wrapped and thickened outward from
 * their inner radius, crease wedges — fused into one solid (or, for paper of
 * no thickness, a compound of faces).
 */
export function foldedSheet(panels: { face: OcAny; T: Rigid }[], bends: BendPlacement[], wedges: WedgePlacement[], t: number, frame: Rigid): Shape3D {
  const oc = OC();
  try {
    const parts: OcAny[] = [];
    for (const p of panels) {
      if (t > 0) {
        const v = new oc.gp_Vec(0, 0, t);
        const pr = new oc.BRepPrimAPI_MakePrism(p.face, v, false, true);
        pr.Build();
        parts.push(place(pr.Shape(), p.T));
        free(pr, v);
      } else parts.push(place(p.face, p.T));
    }
    for (const b of bends) {
      const face = wrapBend(b, t);
      if (t > 0) {
        const thick = thickenShape(wrap(face), t);
        parts.push(place(raw(thick), b.T));
      } else parts.push(place(face, b.T));
    }
    if (t > 0) for (const w of wedges) parts.push(place(wedge(w, t), w.T));
    let shape: OcAny;
    if (t > 0) shape = fuseAll(parts);
    else {
      const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
      builder.MakeCompound(comp);
      for (const p of parts) builder.Add(comp, p);
      free(builder);
      shape = comp;
    }
    return wrap(place(shape, frame));
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : `couldn't fold the sheet (${kernelErrorMessage(e)})`);
  }
}

/** The flat blank shown as is: a plate of thickness t (or the face itself for t = 0). */
export function flatSheet(blank: Shape3D, t: number, frame: Rigid): Shape3D {
  const oc = OC();
  if (!(t > 0)) return wrap(place(raw(blank), frame));
  const v = new oc.gp_Vec(0, 0, t);
  const pr = new oc.BRepPrimAPI_MakePrism(raw(blank), v, false, true);
  pr.Build();
  const out = place(pr.Shape(), frame);
  free(pr, v);
  return wrap(out);
}

/** The blank back from a flat sheet another feature has cut: its bottom face(s) in local flat coords, as BREP text. */
export function flatBlankOf(shape: Shape3D, toLocal: Rigid, t: number): string {
  const local = place(raw(shape), toLocal);
  const faces = explore(local, "FACE").filter((f) => {
    const w = wrap(f) as unknown as { geomType: string; center: { z: number }; normalAt(): { z: number } };
    if (String(w.geomType).toUpperCase() !== "PLANE" || Math.abs(w.center.z) > 1e-5) return false;
    const n = w.normalAt();
    return t > 0 ? n.z < -0.999 : Math.abs(n.z) > 0.999;
  });
  if (!faces.length) throw new Error("the flat sheet has no face left on its bottom plane to fold");
  let blank = faces[0];
  for (const f of faces.slice(1)) blank = boolean("fuse", blank, f);
  return brepOfShape({ wrapped: blank });
}
