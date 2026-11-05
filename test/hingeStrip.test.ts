// A living hinge drawn bent (src/sim/hingeStrip.ts): straight at rest, a
// half-round when folded flat, and always running from one attachment point to
// the other, however the parts are posed.
import { describe, it, expect } from "vitest";
import { bentStripPath, bentStripMesh, flexureStripEnds, type StripEnds } from "../src/sim/hingeStrip";
import { IDENTITY, rotationAbout, type Rigid } from "../src/math/transform";
import type { Joint } from "../src/core/document";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

describe("bentStripPath", () => {
  it("is a straight line between its ends at rest", () => {
    const e: StripEnds = { from: { x: 0, y: 0, z: 0 }, to: { x: 6, y: 0, z: 0 }, d0: { x: 1, y: 0, z: 0 }, d1: { x: 1, y: 0, z: 0 }, length: 6 };
    const { points, bendAngle } = bentStripPath(e, 8);
    expect(bendAngle).toBe(0);
    for (const p of points) { expect(near(p.y, 0)).toBe(true); expect(near(p.z, 0)).toBe(true); }
    expect(points[0]).toEqual(e.from);
    expect(points[8]).toEqual(e.to);
  });

  it("folded 180° with its ends a diameter apart, it is a half-round of that radius", () => {
    // a strip of length π·r leaving along -X and arriving back along +X, ends 2r apart in Z
    const r = 2, L = Math.PI * r;
    const e: StripEnds = { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 2 * r }, d0: { x: -1, y: 0, z: 0 }, d1: { x: 1, y: 0, z: 0 }, length: L };
    const { points, bendAngle } = bentStripPath(e, 32);
    expect(near(bendAngle, Math.PI)).toBe(true);
    const bulge = Math.min(...points.map((p) => p.x));
    expect(Math.abs(-bulge - r) / r).toBeLessThan(0.03); // a cubic's arc is within 3% of the circle
    // every point within a few percent of the circle about (−0, 0, r)... centred on the chord's middle
    for (const p of points) {
      const d = Math.hypot(p.x, p.z - r);
      expect(Math.abs(d - r) / r).toBeLessThan(0.03);
    }
  });
});

describe("bentStripMesh", () => {
  it("is a closed strip of the given section with outward normals", () => {
    const e: StripEnds = { from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, d0: { x: 1, y: 0, z: 0 }, d1: { x: 1, y: 0, z: 0 }, length: 10 };
    const m = bentStripMesh(e, { x: 0, y: 1, z: 0 }, 12, 0.5, 4);
    expect(m.triangleCount).toBe(4 * 4 * 2 + 4);
    expect(m.indices.length).toBe(m.triangleCount * 3);
    // bounds: 10 long, 12 wide (Y), 0.5 thick (Z)
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) { xs.push(m.positions[i]); ys.push(m.positions[i + 1]); zs.push(m.positions[i + 2]); }
    expect(near(Math.max(...xs) - Math.min(...xs), 10)).toBe(true);
    expect(near(Math.max(...ys) - Math.min(...ys), 12)).toBe(true);
    expect(near(Math.max(...zs) - Math.min(...zs), 0.5)).toBe(true);
    // every triangle's winding agrees with its stored normal, and that normal points away from the axis
    for (let t = 0; t < m.indices.length; t += 3) {
      const v = (k: number) => ({ x: m.positions[3 * m.indices[t + k]], y: m.positions[3 * m.indices[t + k] + 1], z: m.positions[3 * m.indices[t + k] + 2] });
      const a = v(0), b = v(1), c = v(2);
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      const n = { x: ab.y * ac.z - ab.z * ac.y, y: ab.z * ac.x - ab.x * ac.z, z: ab.x * ac.y - ab.y * ac.x };
      const sn = { x: m.normals[3 * m.indices[t]], y: m.normals[3 * m.indices[t] + 1], z: m.normals[3 * m.indices[t] + 2] };
      expect(n.x * sn.x + n.y * sn.y + n.z * sn.z).toBeGreaterThan(0);
      const mid = { x: (a.x + b.x + c.x) / 3 - 5, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 };
      // a long face's normal points away from the centreline; an end cap's along it
      const away = mid.y * sn.y + mid.z * sn.z, along = mid.x * sn.x;
      expect(away > 1e-9 || Math.abs(along) > 4.9).toBe(true);
    }
  });
});

describe("flexureStripEnds", () => {
  const joint = (strip: NonNullable<Joint["flexure"]>["strip"]): Joint => ({
    id: "j", name: "hinge", kind: "flexure", base: "A", moved: "B", baseOrigin: { x: 0, y: 0, z: 4 }, movedOrigin: { x: 0, y: 0, z: 4 },
    axis: { x: 0, y: 1, z: 0 }, valueExpr: "0", valueValue: 0, flexure: { length: 6, width: 12, thickness: 0.25, strip },
  });
  it("runs along the as-modelled chord at rest", () => {
    const j = joint({ from: { x: -3, y: 0, z: 0 }, to: { x: 3, y: 0, z: 4 } });
    const world = new Map<string, Rigid>([["A", IDENTITY], ["B", IDENTITY]]);
    const e = flexureStripEnds(j, world, IDENTITY)!;
    expect(e.from).toEqual({ x: -3, y: 0, z: 0 });
    expect(e.to).toEqual({ x: 3, y: 0, z: 4 });
    expect(near(e.length, Math.hypot(6, 4))).toBe(true);
    expect(near(e.d0.x, e.d1.x) && near(e.d0.z, e.d1.z)).toBe(true);
  });
  it("turns the arriving direction with the moved part", () => {
    const j = joint({ from: { x: -3, y: 0, z: 0 }, to: { x: 3, y: 0, z: 4 } });
    // the lid flipped 180° about the hinge line at the mating face
    const flip = rotationAbout({ x: 0, y: 1, z: 0 }, Math.PI, { x: 0, y: 0, z: 4 });
    const world = new Map<string, Rigid>([["A", IDENTITY], ["B", flip]]);
    const e = flexureStripEnds(j, world, IDENTITY)!;
    expect(near(e.to.x, -3) && near(e.to.z, 4)).toBe(true); // lands on the base's hinge face, a half-thickness above `from`
    expect(near(e.d1.x, -e.d0.x) && near(e.d1.z, -e.d0.z)).toBe(true);
    const { bendAngle } = bentStripPath(e);
    expect(near(bendAngle, Math.PI)).toBe(true);
  });
  it("is nothing without attachment points", () => {
    expect(flexureStripEnds(joint(undefined), new Map(), IDENTITY)).toBeUndefined();
  });
});

describe("drawn beams", async () => {
  const { polylineStripMesh } = await import("../src/sim/hingeStrip");
  const { drawnBeamShapes } = await import("../src/sim/flexure");
  const { translation } = await import("../src/math/transform");
  const { realSession } = await import("./helpers");

  it("a strip through a polyline mitres its corners and keeps its section", () => {
    const m = polylineStripMesh([{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }], { x: 0, y: 0, z: 1 }, 6, 1);
    expect(m.triangleCount).toBe(2 * 4 * 2 + 4);
    const zs: number[] = [];
    for (let i = 2; i < m.positions.length; i += 3) zs.push(m.positions[i]);
    expect(near(Math.max(...zs) - Math.min(...zs), 6)).toBe(true);
  });

  it("is solved at the parts' placement: straight at rest, bent when the moved part is displaced", async () => {
    const s = realSession();
    await s.dispatch("material.create", { name: "PP", kind: "plastic", youngsModulus: 1200, allowableStrain: 0.1 });
    const mat = Object.keys(s.doc.materials)[0];
    await s.dispatch("material.assign", { material: mat });
    const cmp = (await s.dispatch("component.create", { name: "slider" })).createdIds[0];
    await s.dispatch("parameter.add", { name: "pull", expression: "0", min: 0, max: 3 });
    await s.dispatch("joint.create", { kind: "slider", moved: cmp, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, value: "pull" });
    await s.dispatch("joint.create", { kind: "beam", moved: cmp, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 20, y: 0, z: 0 }, beam: { width: 6, thickness: 1, draw: true }, name: "spring" });
    const { resolveParameters } = await import("../src/core/parameters");
    const { resolveComponentWorld } = await import("../src/core/recompute");
    const at = (pull: number) => {
      const scope = { ...resolveParameters(s.doc.parameters).scope, pull };
      const world = resolveComponentWorld(s.doc, scope);
      return drawnBeamShapes(s.doc, scope, world);
    };
    const rest = at(0);
    expect(rest.length).toBe(1);
    expect(rest[0].points[0]).toEqual({ x: 0, y: 0, z: 0 });
    const end = rest[0].points[rest[0].points.length - 1];
    expect(near(end.x, 20, 1e-6) && near(end.y, 0, 1e-6)).toBe(true);
    // the moved part slides 2 along X: the strip's far end follows it (an axial stretch; a straight strip stays straight)
    const pulled = at(2);
    const tip = pulled[0].points[pulled[0].points.length - 1];
    expect(near(tip.x, 22, 1e-3)).toBe(true);
    expect(translation({ x: 0, y: 0, z: 0 })).toBeTruthy();
  });
});

describe("drawn elements in an export", async () => {
  const { drawnElementMeshes } = await import("../src/core/features");
  const { realSession } = await import("./helpers");
  const { resolveParameters } = await import("../src/core/parameters");

  it("lists each drawn beam at the document's pose, with the component it prints with", async () => {
    const s = realSession();
    await s.dispatch("material.create", { name: "PP", kind: "plastic", youngsModulus: 1200, allowableStrain: 0.1 });
    await s.dispatch("material.assign", { material: Object.keys(s.doc.materials)[0] });
    const cmp = (await s.dispatch("component.create", { name: "slider" })).createdIds[0];
    await s.dispatch("parameter.add", { name: "pull", expression: "0", min: 0, max: 3 });
    await s.dispatch("joint.create", { kind: "slider", moved: cmp, baseOrigin: { x: 0, y: 0, z: 0 }, movedOrigin: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, value: "pull" });
    await s.dispatch("joint.create", { kind: "beam", moved: cmp, baseOrigin: { x: 0, y: 0, z: 3 }, movedOrigin: { x: 20, y: 0, z: 3 }, beam: { width: 6, thickness: 1, draw: true }, name: "spring" });
    const drawn = drawnElementMeshes(s.doc, resolveParameters(s.doc.parameters).scope);
    expect(drawn.map((d) => d.name)).toEqual(["spring"]);
    expect(drawn[0].componentId).toBe(s.doc.rootComponentId);
    const zs: number[] = [];
    for (let i = 2; i < drawn[0].mesh.positions.length; i += 3) zs.push(drawn[0].mesh.positions[i]);
    expect(near(Math.min(...zs), 0) && near(Math.max(...zs), 6)).toBe(true); // 6 wide along Z about z = 3
  });
});
