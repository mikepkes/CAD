// The modelling panels' decisions and the kernel features they reach (M6), and
// "Round edges" that follows its edges when the body moves (M25): edges and
// faces picked by topological name, a revolve about a sketch line, and what each
// panel commits.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures, type SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import type { CadSession } from "../src/core/command/session";
import { segmentEdgeNames, edgesAroundFace, edgesBehindFace, edgeSegments, nearestEdge } from "../src/model/edgePick";
import { defaultRevolveAxis, profileChoices, revolveLineChoices, toolCommand, worldAxisInSketch, toggled, type FeatureTool } from "../src/model/featureTools";
import { faceEdgeSelector } from "../src/ui/concepts/contextActions.logic";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

const solids = (s: CadSession) => evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope);
const body = (s: CadSession, id: string): SolidEval => solids(s)[id];

async function box(z = "20") {
  const s = realSession();
  const r = await s.dispatch("feature.primitive", { shape: "box", x: "40", y: "30", z, at: { x: 0, y: 0, z: Number(z) / 2 } });
  return { s, id: r.createdIds[0], opId: r.opId! };
}

describe("edges by name from the display mesh", () => {
  it("names every edge of a box by the two faces it separates", async () => {
    const { s, id } = await box();
    const mesh = body(s, id).mesh!;
    const names = segmentEdgeNames(mesh).filter(Boolean) as string[];
    expect(new Set(names).size).toBe(12);
    const top = edgesAroundFace(mesh, `${id}:+Z`).sort();
    expect(top).toEqual([`${id}:+X|${id}:+Z`, `${id}:+Y|${id}:+Z`, `${id}:+Z|${id}:-X`, `${id}:+Z|${id}:-Y`].sort());
    const corners = edgesBehindFace(mesh, { x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 1 });
    expect(corners.length).toBe(4);
    expect(corners.every((n) => !n.includes("+Z") && !n.includes("-Z"))).toBe(true);
    expect(edgeSegments(mesh, top).length).toBe(4 * 6);
  });

  it("finds the edge nearest a screen point", async () => {
    const { s, id } = await box();
    const mesh = body(s, id).mesh!;
    // a top view: world (x, y) → screen (x, −y), so the +X top edge runs along screen x = 20
    const hit = nearestEdge([{ bodyId: id, mesh }], { x: 21, y: 0 }, (p) => ({ x: p.x, y: -p.y + p.z * 0.001 }), 5);
    expect(hit?.bodyId).toBe(id);
    expect(hit?.name.split("|")).toContain(`${id}:+X`);
    expect(nearestEdge([{ bodyId: id, mesh }], { x: 100, y: 100 }, (p) => ({ x: p.x, y: -p.y }), 5)).toBeNull();
  });
});

describe("Round edges follows its edges when the body changes (M25)", () => {
  it("a coordinate-plane selector loses them; names keep them", async () => {
    // the lead, confirmed: edges stored as the plane z = 20 match nothing once the box is 30 tall
    const a = await box();
    const f1 = await a.s.dispatch("feature.fillet", { radius: "2", edges: faceEdgeSelector({ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 1 })!, body: a.id, requireEffect: true });
    const grow = async (s: CadSession, opId: string) => { const op = s.timeline.find((o) => o.opId === opId)!; await s.editOperation(opId, { ...op.params, z: "30", at: { x: 0, y: 0, z: 15 } }); };
    expect(body(a.s, a.id).error ?? solids(a.s)[f1.createdIds[0]]?.error).toBeUndefined();
    await grow(a.s, a.opId);
    expect(solids(a.s)[f1.createdIds[0]]?.error).toMatch(/no edge was selected|changed nothing/);

    // by name, as Round edges now stores them
    const b = await box();
    const names = edgesAroundFace(body(b.s, b.id).mesh!, `${b.id}:+Z`);
    const f2 = await b.s.dispatch("feature.fillet", { radius: "2", edges: { names }, body: b.id, requireEffect: true });
    await grow(b.s, b.opId);
    const after = solids(b.s);
    expect(after[f2.createdIds[0]]?.error).toBeUndefined();
    expect(after[b.id].volume!).toBeLessThan(40 * 30 * 30 - 1); // rounded at the new top
    expect(after[b.id].bounds!.max.z).toBeCloseTo(30, 3);
  });
});

describe("shell by picked faces", () => {
  it("opens the faces named", async () => {
    const { s, id } = await box();
    const r = await s.dispatch("feature.shell", { thickness: "2", openFaces: { names: [`${id}:+Z`] }, body: id, requireEffect: true });
    const out = solids(s);
    expect(out[r.createdIds[0]]?.error).toBeUndefined();
    const v = out[id].volume!;
    expect(v).toBeCloseTo(40 * 30 * 20 - 36 * 26 * 18, 0);
  });
});

describe("revolve", () => {
  async function profile() {
    const s = realSession();
    const sk = await s.dispatch("sketch.create", { plane: "XZ" });
    const sid = sk.createdIds[0];
    await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 10, y: 0 }, opposite: { x: 20, y: 10 } });
    const axis = await s.dispatch("sketch.addLine", { sketch: sid, start: { x: 0, y: 0 }, end: { x: 0, y: 30 }, construction: true });
    return { s, sid, line: axis.createdIds[0] };
  }

  it("turns about a sketch line, and offers lines and in-plane world axes", async () => {
    const { s, sid, line } = await profile();
    const sk = s.doc.sketches[sid];
    expect(revolveLineChoices(sk)[0]).toEqual({ id: line, label: "Construction line, vertical, 30 mm" });
    expect(defaultRevolveAxis(sk)).toEqual({ line });
    expect(worldAxisInSketch(sk, "Z")).not.toBeNull();
    expect(worldAxisInSketch(sk, "Y")).toBeNull(); // the XZ sketch's normal
    const tool: FeatureTool = { kind: "revolve", sketch: sid, axis: { line }, angle: "360", operation: "new" };
    const cmd = toolCommand(tool, s.doc);
    expect(cmd).toEqual({ type: "feature.revolve", params: { sketch: sid, angle: "360", axisLine: line } });
    const r = await s.dispatch("feature.revolve", (cmd as { params: Record<string, unknown> }).params);
    const ring = solids(s)[r.createdIds[0]];
    expect(ring.error).toBeUndefined();
    expect(ring.volume!).toBeCloseTo(Math.PI * (20 * 20 - 10 * 10) * 10, 0);
  });

  it("about the world Z axis, from the panel", async () => {
    const { s, sid } = await profile();
    const cmd = toolCommand({ kind: "revolve", sketch: sid, axis: { world: "Z" }, angle: "180", operation: "new" }, s.doc);
    expect("params" in cmd && cmd.params.axis).toBeTruthy();
    const r = await s.dispatch("feature.revolve", (cmd as { params: Record<string, unknown> }).params);
    expect(solids(s)[r.createdIds[0]].volume!).toBeCloseTo((Math.PI * (400 - 100) * 10) / 2, 0);
  });
});

describe("what the panels commit", () => {
  it("only offers sketches with a closed region, by their browser name", async () => {
    const s = realSession();
    await s.dispatch("sketch.create", { plane: "XY" }); // empty
    const sk2 = await s.dispatch("sketch.create", { plane: "XZ" });
    await s.dispatch("sketch.addLine", { sketch: sk2.createdIds[0], start: { x: 0, y: 0 }, end: { x: 5, y: 5 } }); // open
    const sk3 = await s.dispatch("sketch.create", { plane: "YZ" });
    await s.dispatch("sketch.addCircle", { sketch: sk3.createdIds[0], center: { x: 0, y: 0 }, radius: 5 });
    expect(profileChoices(s.doc)).toEqual([{ id: sk3.createdIds[0], label: "Sketch 3 · YZ" }]);
    expect(profileChoices(s.doc, sk2.createdIds[0]).map((c) => c.label)).toEqual(["Sketch 2 · XZ", "Sketch 3 · YZ"]);
  });

  it("says what is missing, and builds each command", () => {
    const doc = realSession().doc;
    expect(toolCommand({ kind: "shell", body: "b", faces: [], thickness: "2" }, doc)).toEqual({ problem: "Click the faces to open" });
    expect(toolCommand({ kind: "edges", blend: "chamfer", body: "b", edges: [], size: "1" }, doc)).toEqual({ problem: "Click the edges to bevel" });
    expect(toolCommand({ kind: "edges", blend: "fillet", body: "b", edges: ["a|b"], size: "r" }, doc)).toEqual({ type: "feature.fillet", params: { radius: "r", edges: { names: ["a|b"] }, body: "b", requireEffect: true } });
    expect(toolCommand({ kind: "pattern", body: "b", mode: "linear", count: "4", direction: "Y", spacing: "12", axis: "Z", angle: "" }, doc))
      .toEqual({ type: "feature.pattern", params: { mode: "linear", count: "4", step: { x: "0", y: "12", z: "0" }, body: "b" } });
    expect(toolCommand({ kind: "pattern", body: "b", mode: "circular", count: "6", direction: "X", spacing: "", axis: "Z", angle: "" }, doc))
      .toEqual({ type: "feature.pattern", params: { mode: "circular", count: "6", axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, body: "b" } });
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
    expect(toggled(["a"], "b")).toEqual(["a", "b"]);
  });
});
