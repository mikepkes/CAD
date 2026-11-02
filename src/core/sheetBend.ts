// Paper that bends: a sheet's facets as a mesh of small triangles, moved by energy instead of rigidly.
//
// A rigid fold step keeps every facet flat and only turns creases. Some folds can't be made that way — an inside
// reverse fold, a wing folded down through layers tied into the body — because real paper gives a little: it
// bends across its faces, and its old creases ease open. A bending step meshes the paper into triangles (each a
// small rigid panel) and moves them as a bar-and-hinge model, the pseudo-rigid-body idea the flexure joints use
// (sim/flexure.ts: a strip that bends acts as a hinge with a torsional spring k = E·I/L, I = w·t³/12):
//  - bars along every triangle edge keep the paper from stretching (axial stiffness E·t·A/L², much stiffer);
//  - hinges across every edge between two triangles resist bending: across a face, k = w/ℓ (w the edge's length,
//    ℓ the width of paper that bends: a third of the two triangles' heights), with E·t³/12 = 1; across an old crease
//    a fraction of that (a crease is a weakened line), across a crease the step frees a smaller fraction still;
//  - the step's driven creases are hinges far stiffer again, whose rest angle runs to where they're folded.
// Each sample of the step is the least-energy shape (Gauss–Newton with Levenberg–Marquardt damping on the vertex
// positions; the normal equations solved in envelope form after a reverse Cuthill–McKee ordering, so a few
// hundred vertices solve in milliseconds), each started from the last. Panels are then placed by the best rigid fit
// of their three vertices. Pure geometry: no kernel.

import type { Pt } from "./geometry/profile";
import type { Rigid } from "../math/transform";

type V3 = { x: number; y: number; z: number };

/** A conforming triangle mesh of the flat sheet: vertices (flat coords), CCW triangles, and the facet each lies in. */
export interface BendMesh {
  verts: Pt[];
  tris: [number, number, number][];
  owner: number[];
}

/** Mesh convex facets that meet edge to edge (T-junctions allowed): each fanned from its centroid, then the
 *  longest edge over `size` split, in every triangle that has it, until none is. */
export function meshFacets(polys: Pt[][], size: number, tol: number): BendMesh {
  const verts: Pt[] = [];
  const id = (p: Pt) => {
    for (let k = 0; k < verts.length; k++) if (Math.abs(verts[k].x - p.x) <= tol && Math.abs(verts[k].y - p.y) <= tol) return k;
    return verts.push({ x: p.x, y: p.y }) - 1;
  };
  for (const poly of polys) for (const p of poly) id(p);
  const corners = verts.length;
  const tris: [number, number, number][] = [], owner: number[] = [];
  polys.forEach((poly, f) => {
    const ring: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ex = b.x - a.x, ey = b.y - a.y, L = Math.hypot(ex, ey);
      ring.push(id(a));
      if (L <= tol) continue;
      // another facet's corner on this edge: a vertex here too, so the mesh conforms
      const on: { k: number; s: number }[] = [];
      for (let k = 0; k < corners; k++) {
        const v = verts[k], s = ((v.x - a.x) * ex + (v.y - a.y) * ey) / L, d = Math.abs((v.y - a.y) * ex - (v.x - a.x) * ey) / L;
        if (d <= tol && s > tol && s < L - tol) on.push({ k, s });
      }
      ring.push(...on.sort((x, y) => x.s - y.s).map((o) => o.k));
    }
    const r = ring.filter((k, i) => k !== ring[(i + 1) % ring.length]);
    const c = verts.push({ x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length }) - 1;
    for (let i = 0; i < r.length; i++) { tris.push([c, r[i], r[(i + 1) % r.length]]); owner.push(f); }
  });
  // split the longest edge over `size` (and with it both triangles on it) until none is
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const onEdge = new Map<string, Set<number>>();
  const addTri = (t: number) => { const T = tris[t]; for (let i = 0; i < 3; i++) { const k = key(T[i], T[(i + 1) % 3]); (onEdge.get(k) ?? onEdge.set(k, new Set()).get(k)!).add(t); } };
  const dropTri = (t: number) => { const T = tris[t]; for (let i = 0; i < 3; i++) onEdge.get(key(T[i], T[(i + 1) % 3]))?.delete(t); };
  tris.forEach((_, t) => addTri(t));
  const len = (k: string) => { const [a, b] = k.split(",").map(Number); return Math.hypot(verts[a].x - verts[b].x, verts[a].y - verts[b].y); };
  for (let guard = 0; guard < 100000; guard++) {
    let best = "", bl = size;
    for (const [k, ts] of onEdge) if (ts.size) { const l = len(k); if (l > bl) { bl = l; best = k; } }
    if (!best) break;
    const [a, b] = best.split(",").map(Number);
    const m = verts.push({ x: (verts[a].x + verts[b].x) / 2, y: (verts[a].y + verts[b].y) / 2 }) - 1;
    for (const t of [...onEdge.get(best)!]) {
      const T = tris[t], i = T.findIndex((v, j) => key(v, T[(j + 1) % 3]) === best), u = T[i], v = T[(i + 1) % 3], o = T[(i + 2) % 3];
      dropTri(t);
      tris[t] = [u, m, o]; addTri(t);
      owner.push(owner[t]); tris.push([m, v, o]); addTri(tris.length - 1);
    }
    onEdge.delete(best);
  }
  return { verts, tris, owner };
}

/** A hinge between the triangles either side of edge a→b: c the third vertex of the one on its left (a, b, c CCW
 *  in the flat), d of the one on its right. `k` its stiffness; it rests at `rest` (radians, + valley as seen from
 *  the paper's top), or runs from `rest` to `to` over the step. */
export interface BendHinge { a: number; b: number; c: number; d: number; k: number; rest: number; to?: number }

export interface BendProblem {
  /** Flat positions (the paper's rest shape: bars keep these lengths). */
  flat: Pt[];
  tris: [number, number, number][];
  /** The start: 3 numbers a vertex. */
  x0: Float64Array;
  hinges: BendHinge[];
  /** Vertices held where they start. */
  fixed: number[];
  /** The paper's thickness (sheet units): what makes stretching stiff next to bending. */
  thickness: number;
}

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const norm = (a: V3) => Math.hypot(a.x, a.y, a.z);
const at = (x: Float64Array, i: number): V3 => ({ x: x[3 * i], y: x[3 * i + 1], z: x[3 * i + 2] });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A hinge's fold angle (+ valley: the two triangles turning toward their tops) near `prev` (unwrapped from it), and
 *  its gradient with respect to a, b, c, d. */
export function dihedral(x: Float64Array, h: { a: number; b: number; c: number; d: number }, prev = 0): { th: number; g: [V3, V3, V3, V3] } {
  const A = at(x, h.a), B = at(x, h.b), C = at(x, h.c), D = at(x, h.d);
  const e = sub(B, A), L2 = dot(e, e), L = Math.sqrt(L2), eh = scale(e, 1 / L);
  const n1 = cross(e, sub(C, A)), n2 = cross(sub(A, B), sub(D, B)); // the left triangle (a, b, c), the right (b, a, d)
  const m1 = norm(n1), m2 = norm(n2);
  const raw = Math.atan2(-dot(cross(n1, n2), eh), dot(n1, n2));
  const th = prev + wrap(raw - prev);
  // moving c (d) along its triangle's normal turns that triangle about the edge by 1/height a unit: valley-wards
  const h1 = m1 / L, h2 = m2 / L;
  const gc = scale(n1, 1 / (m1 * h1)), gd = scale(n2, 1 / (m2 * h2));
  const tc = dot(sub(C, A), e) / L2, td = dot(sub(D, A), e) / L2;
  const ga = { x: -(1 - tc) * gc.x - (1 - td) * gd.x, y: -(1 - tc) * gc.y - (1 - td) * gd.y, z: -(1 - tc) * gc.z - (1 - td) * gd.z };
  const gb = { x: -tc * gc.x - td * gd.x, y: -tc * gc.y - td * gd.y, z: -tc * gc.z - td * gd.z };
  return { th, g: [ga, gb, gc, gd] };
}

/** The mesh's hinges: every edge two triangles share, with its left and right triangles' third vertices. */
export function meshHinges(tris: [number, number, number][]): { a: number; b: number; c: number; d: number }[] {
  const half = new Map<string, number>(); // "a,b" (directed, as it runs in a CCW triangle) → that triangle's third vertex
  for (const T of tris) for (let i = 0; i < 3; i++) half.set(`${T[i]},${T[(i + 1) % 3]}`, T[(i + 2) % 3]);
  const out: { a: number; b: number; c: number; d: number }[] = [];
  for (const [k, c] of half) {
    const [a, b] = k.split(",").map(Number);
    if (a > b) continue;
    const d = half.get(`${b},${a}`);
    if (d != null) out.push({ a, b, c, d });
  }
  return out;
}

/** The paper's own stiffness across a hinge (E·t³/12 = 1): its length over the width of paper that bends there — at
 *  least `minWidth` (a sliver of a triangle beside a crease isn't paper bending in a hairline: without a floor its
 *  hinge would be stiff past anything the solver can balance). */
export function hingeStiffness(flat: Pt[], h: { a: number; b: number; c: number; d: number }, minWidth = 0): number {
  const A = flat[h.a], B = flat[h.b], w = Math.hypot(B.x - A.x, B.y - A.y);
  const height = (P: Pt) => Math.abs((B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x)) / (w || 1);
  return w / Math.max(1e-9, minWidth, (height(flat[h.c]) + height(flat[h.d])) / 3);
}

/** The bending step's path: the least-energy shape at each of `samples` + 1 even steps of its progress (the first
 *  with every hinge at rest where it starts, so the stretch the start carries relaxes out before anything moves). */
export function bendPath(P: BendProblem, samples: number): Float64Array[] {
  const nv = P.flat.length;
  // the bars: every triangle edge, at its flat length, stiffness E·t·A/L² (E·t = 12/t² with E·t³/12 = 1)
  const area = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const [i, j, k] of P.tris) {
    const A = P.flat[i], B = P.flat[j], C = P.flat[k], ar = Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2;
    for (const [u, v] of [[i, j], [j, k], [k, i]]) area.set(key(u, v), (area.get(key(u, v)) ?? 0) + ar / 3);
  }
  const bars = [...area].map(([kk, ar]) => {
    const [a, b] = kk.split(",").map(Number), L0 = Math.hypot(P.flat[a].x - P.flat[b].x, P.flat[a].y - P.flat[b].y);
    return { a, b, L0, w: Math.sqrt((12 / P.thickness ** 2) * ar / (L0 * L0)) };
  });

  // unknowns: three per free vertex, in an order that keeps the normal matrix banded (reverse Cuthill–McKee)
  const fixed = new Set(P.fixed);
  const nbr = Array.from({ length: nv }, () => new Set<number>());
  const link = (u: number, v: number) => { if (u !== v) { nbr[u].add(v); nbr[v].add(u); } };
  for (const b of bars) link(b.a, b.b);
  for (const h of P.hinges) { link(h.a, h.c); link(h.a, h.d); link(h.b, h.c); link(h.b, h.d); link(h.c, h.d); link(h.a, h.b); }
  const order: number[] = [], seen = new Uint8Array(nv);
  for (;;) {
    let s = -1;
    for (let v = 0; v < nv; v++) if (!seen[v] && !fixed.has(v) && (s < 0 || nbr[v].size < nbr[s].size)) s = v;
    if (s < 0) break;
    seen[s] = 1;
    for (let q = [s], qi = 0; qi < q.length; qi++) {
      order.push(q[qi]);
      for (const w of [...nbr[q[qi]]].filter((w) => !seen[w] && !fixed.has(w)).sort((x, y) => nbr[x].size - nbr[y].size)) { seen[w] = 1; q.push(w); }
    }
  }
  order.reverse();
  const slot = new Int32Array(nv).fill(-1);
  order.forEach((v, i) => (slot[v] = i));
  const n = 3 * order.length;
  // the envelope: each row's first column
  const first = new Int32Array(n);
  for (let i = 0; i < n; i++) first[i] = i;
  for (const v of order) for (const w of nbr[v]) if (slot[w] >= 0) for (let p = 0; p < 3; p++) {
    const r = 3 * slot[v] + p, c0 = 3 * slot[w];
    if (c0 < first[r]) first[r] = c0;
  }
  for (let i = 0; i < n; i++) first[i] = Math.min(first[i], i - (i % 3)); // the vertex's own block
  const rowAt = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowAt[i + 1] = rowAt[i] + (i - first[i] + 1);
  const env = new Float64Array(rowAt[n]);
  const E = (i: number, j: number) => rowAt[i] + (j - first[i]); // i ≥ j

  const out: Float64Array[] = [];
  let x = Float64Array.from(P.x0), prevX = x;
  let prevTh = P.hinges.map((h) => dihedral(x, h, h.rest).th);
  const evaluate = (y: Float64Array, s: number, ths: number[]) => {
    const rows: { r: number; g: { v: number; d: V3 }[] }[] = [];
    let cost = 0;
    const th: number[] = [];
    for (const b of bars) {
      const d = sub(at(y, b.b), at(y, b.a)), L = norm(d) || 1e-12, u = scale(d, 1 / L), r = b.w * (L - b.L0);
      rows.push({ r, g: [{ v: b.a, d: scale(u, -b.w) }, { v: b.b, d: scale(u, b.w) }] });
      cost += r * r;
    }
    P.hinges.forEach((h, q) => {
      const { th: t, g } = dihedral(y, h, ths[q]);
      th.push(t);
      const target = h.to == null ? h.rest : h.rest + s * (h.to - h.rest), w = Math.sqrt(h.k), r = w * (t - target);
      rows.push({ r, g: [{ v: h.a, d: scale(g[0], w) }, { v: h.b, d: scale(g[1], w) }, { v: h.c, d: scale(g[2], w) }, { v: h.d, d: scale(g[3], w) }] });
      cost += r * r;
    });
    return { rows, cost, th };
  };
  const comp = (d: V3, p: number) => (p === 0 ? d.x : p === 1 ? d.y : d.z);
  /** Solve (JᵀJ + λ·diag)·dx = −Jᵀr in the envelope (Cholesky). */
  const step = (rows: ReturnType<typeof evaluate>["rows"], lambda: number): Float64Array | undefined => {
    env.fill(0);
    const rhs = new Float64Array(n);
    for (const { r, g } of rows) {
      const live = g.filter((e) => slot[e.v] >= 0);
      for (const e1 of live) for (let p = 0; p < 3; p++) {
        const i = 3 * slot[e1.v] + p, gi = comp(e1.d, p);
        if (!gi) continue;
        rhs[i] -= gi * r;
        for (const e2 of live) for (let q = 0; q < 3; q++) {
          const j = 3 * slot[e2.v] + q;
          if (j > i) continue;
          env[E(i, j)] += gi * comp(e2.d, q);
        }
      }
    }
    for (let i = 0; i < n; i++) env[E(i, i)] = env[E(i, i)] * (1 + lambda) + 1e-12;
    // Cholesky in place: L Lᵀ
    for (let i = 0; i < n; i++) {
      for (let j = first[i]; j <= i; j++) {
        let s = env[E(i, j)];
        for (let k = Math.max(first[i], first[j]); k < j; k++) s -= env[E(i, k)] * env[E(j, k)];
        if (j < i) env[E(i, j)] = s / env[E(j, j)];
        else { if (!(s > 0)) return undefined; env[E(i, i)] = Math.sqrt(s); }
      }
    }
    // L z = rhs, then Lᵀ dx = z
    const z = rhs;
    for (let i = 0; i < n; i++) { let s = z[i]; for (let k = first[i]; k < i; k++) s -= env[E(i, k)] * z[k]; z[i] = s / env[E(i, i)]; }
    for (let i = n - 1; i >= 0; i--) { z[i] /= env[E(i, i)]; const zi = z[i]; for (let k = first[i]; k < i; k++) z[k] -= env[E(i, k)] * zi; }
    return z;
  };
  const apply = (y: Float64Array, dx: Float64Array, t: number) => {
    const o = Float64Array.from(y);
    order.forEach((v, i) => { for (let p = 0; p < 3; p++) o[3 * v + p] += t * dx[3 * i + p]; });
    return o;
  };
  const scaleLen = Math.max(1e-9, ...P.flat.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
  for (let k = 0; k <= samples; k++) {
    const s = k / samples;
    // start from where the last two samples point
    if (k > 1) { const g = Float64Array.from(x); for (let i = 0; i < g.length; i++) g[i] += x[i] - prevX[i]; prevX = x; x = g; } else prevX = x;
    let ev = evaluate(x, s, prevTh), lambda = 1e-4;
    for (let it = 0; it < 60; it++) {
      const dx = step(ev.rows, lambda);
      if (!dx) { lambda *= 10; continue; }
      let big = 0;
      for (let i = 0; i < n; i++) big = Math.max(big, Math.abs(dx[i]));
      const t = big > 0.05 * scaleLen ? (0.05 * scaleLen) / big : 1; // a short way at a time
      const y = apply(x, dx, t), ey = evaluate(y, s, ev.th);
      if (ey.cost < ev.cost) {
        const gain = ev.cost - ey.cost;
        x = y; ev = ey; lambda = Math.max(1e-9, lambda / 3);
        if (gain < 1e-12 * (1 + ev.cost) || big * t < 1e-10 * scaleLen) break;
      } else {
        lambda *= 4;
        if (lambda > 1e8) break;
      }
    }
    prevTh = ev.th;
    out.push(x);
  }
  return out;
}

/** A triangle's placement (flat → 3D): the rotation nearest to how its two edges map (polar decomposition), about
 *  its centroid — the best rigid fit, sharing what little the paper stretched among its corners. */
export function fitPanel(flat: [Pt, Pt, Pt], x: [V3, V3, V3]): Rigid {
  const p1 = { x: flat[1].x - flat[0].x, y: flat[1].y - flat[0].y }, p2 = { x: flat[2].x - flat[0].x, y: flat[2].y - flat[0].y };
  const det = p1.x * p2.y - p1.y * p2.x;
  // F = [dx1 dx2] · [p1 p2]⁻¹ (3×2)
  const q1 = sub(x[1], x[0]), q2 = sub(x[2], x[0]);
  const i00 = p2.y / det, i01 = -p2.x / det, i10 = -p1.y / det, i11 = p1.x / det;
  const c0 = { x: q1.x * i00 + q2.x * i10, y: q1.y * i00 + q2.y * i10, z: q1.z * i00 + q2.z * i10 };
  const c1 = { x: q1.x * i01 + q2.x * i11, y: q1.y * i01 + q2.y * i11, z: q1.z * i01 + q2.z * i11 };
  // R = F (FᵀF)^-½: the 2×2 square root of M = FᵀF is (M + √det·I)/√(tr + 2√det)
  const a = dot(c0, c0), b = dot(c0, c1), d = dot(c1, c1), sd = Math.sqrt(Math.max(0, a * d - b * b)), st = Math.sqrt(a + d + 2 * sd);
  const s00 = (a + sd) / st, s01 = b / st, s11 = (d + sd) / st, sdet = s00 * s11 - s01 * s01;
  const r00 = s11 / sdet, r01 = -s01 / sdet, r11 = s00 / sdet;
  const X = { x: c0.x * r00 + c1.x * r01, y: c0.y * r00 + c1.y * r01, z: c0.z * r00 + c1.z * r01 };
  const Y = { x: c0.x * r01 + c1.x * r11, y: c0.y * r01 + c1.y * r11, z: c0.z * r01 + c1.z * r11 };
  const Z = cross(X, Y);
  const cf = { x: (flat[0].x + flat[1].x + flat[2].x) / 3, y: (flat[0].y + flat[1].y + flat[2].y) / 3 };
  const cx = scale({ x: x[0].x + x[1].x + x[2].x, y: x[0].y + x[1].y + x[2].y, z: x[0].z + x[1].z + x[2].z }, 1 / 3);
  const origin = { x: cx.x - X.x * cf.x - Y.x * cf.y, y: cx.y - X.y * cf.x - Y.y * cf.y, z: cx.z - X.z * cf.x - Y.z * cf.y };
  return { origin, x: X, y: Y, z: Z };
}
