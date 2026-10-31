import { describe, it, expect, beforeAll } from "vitest";
import { realSession } from "./helpers";
import { featureRows, featureSpec, featureSpecForOp, allFeatureSpecs, sentenceText, pinAnchor, evalParam, nameOf, nameFromTimeline, pushParamFor, unitLabel, paramsWith, unionBounds, boundsCentre, type FeatureRow } from "../src/model/concepts/featureCatalog";
import { createDefaultRegistry } from "../src/core/command/builtins";

describe("feature catalog", () => {
  it("covers every feature command in the registry", () => {
    const reg = createDefaultRegistry();
    const featureOps = reg.list().map((d) => d.type).filter((t) => t.startsWith("feature.") && t !== "feature.setCondition");
    for (const op of featureOps) expect(featureSpecForOp(op), op).toBeDefined();
    expect(allFeatureSpecs().length).toBeGreaterThanOrEqual(featureOps.length);
  });

  it("every spec's sentence names each of its params at most once and only its own params", () => {
    for (const spec of allFeatureSpecs()) {
      const op = { opId: "o", type: spec.op, createdIds: ["f"], label: spec.label, at: 0, params: Object.fromEntries(spec.params.map((p) => [p.key, 1])) };
      (op.params as Record<string, unknown>).sketch = "s1"; (op.params as Record<string, unknown>).at = [{ x: 0, y: 0, z: 0 }];
      const segs = spec.sentence(op, (id) => id);
      const used = segs.flatMap((s) => ("param" in s ? [s.param] : []));
      for (const key of used) expect(spec.params.some((p) => p.key === key), `${spec.kind} uses ${key}`).toBe(true);
      expect(new Set(used).size).toBe(used.length);
    }
  });

  describe("rows from a real session", () => {
    let s: ReturnType<typeof realSession>;
    beforeAll(async () => {
      s = realSession();
      await s.dispatch("parameter.add", { name: "h", expression: "12" });
      const sk = await s.dispatch("sketch.create", { plane: "XY" });
      const sid = sk.createdIds[0];
      await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
      await s.dispatch("feature.extrude", { sketch: sid, distance: "h*2" });
      await s.dispatch("feature.fillet", { radius: "1.5" });
    });

    it("lists features in history order with evaluated values and expressions", () => {
      const rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
      expect(rows.map((r) => r.spec.kind)).toEqual(["extrude", "fillet"]);
      expect(rows[0].num).toBe(1);
      expect(rows[0].values.distance).toBe(24);
      expect(rows[0].exprs.distance).toBe("h*2");
      expect(rows[1].values.radius).toBe(1.5);
      expect(rows[0].rolledBack).toBe(false);
      expect(rows[0].componentId).toBe(s.doc.rootComponentId);
    });

    it("reads each feature back as a sentence", () => {
      const rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
      expect(sentenceText(rows[0], s.doc, s.timeline)).toMatch(/^Extrude .+ by 24 mm\.$/);
      expect(sentenceText(rows[1], s.doc, s.timeline)).toBe("Round the edges to 1.5 mm.");
    });

    it("marks rolled-back and suppressed features", async () => {
      await s.moveRollback(s.timeline.length - 1);
      let rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
      expect(rows[1].rolledBack).toBe(true);
      await s.moveRollback(s.timeline.length);
      await s.setSuppressed(rows[1].opId, true);
      rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
      expect(rows[1].suppressed).toBe(true);
      await s.setSuppressed(rows[1].opId, false);
    });

    it("anchors a pin on the body's bounds, or a hole's centre", () => {
      const rows = featureRows(s.doc, s.timeline, s.rollbackIndex, { [s.timeline.find((o) => o.type === "feature.extrude")!.createdIds[0]]: { featureId: "x", name: "x", bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 24 } } } as never });
      const a = pinAnchor(rows[0])!;
      expect(a.z).toBe(24);
      expect(a.x).toBeGreaterThan(0); expect(a.x).toBeLessThan(40);
      const holeRow = { ...rows[0], op: { ...rows[0].op, params: { at: [{ x: 3, y: 4, z: 5 }] } } };
      expect(pinAnchor(holeRow)).toEqual({ x: 3, y: 4, z: 5 });
      expect(pinAnchor({ ...rows[0], solid: undefined })).toBeNull();
    });

    it("resolves the body a modifier changed (the latest earlier body) and anchors its pin on it", () => {
      const extrudeId = s.timeline.find((o) => o.type === "feature.extrude")!.createdIds[0];
      const filletId = s.timeline.find((o) => o.type === "feature.fillet")!.createdIds[0];
      const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 24 } };
      const rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {
        [extrudeId]: { featureId: extrudeId, name: "x", sketchId: "", distance: 24, bounds, volume: 19200 } as never,
        [filletId]: { featureId: filletId, name: "f", sketchId: "", distance: 0 } as never, // the kernel's modifier row: no geometry
      });
      expect(rows[0].body).toBeUndefined(); // its own solid has the geometry
      expect(rows[1].solid?.featureId).toBe(filletId); // its own row stays its own (no mass of its own)
      expect(rows[1].body?.featureId).toBe(extrudeId);
      expect(pinAnchor(rows[1])?.z).toBe(24);
      expect(rows[1].componentId).toBe(s.doc.rootComponentId);
      // nothing built yet: no body to borrow
      expect(featureRows(s.doc, s.timeline, s.rollbackIndex, {})[1].body).toBeUndefined();
    });

    it("names sketches and features for sentences", () => {
      const sketchId = Object.keys(s.doc.sketches)[0];
      const extrudeId = s.timeline.find((o) => o.type === "feature.extrude")!.createdIds[0];
      expect(nameOf(s.doc, s.timeline, sketchId)).toBe(s.doc.sketches[sketchId].name || "the sketch");
      expect(nameOf(s.doc, s.timeline, extrudeId)).toBe((s.doc.features[extrudeId] as { name?: string }).name || "Extrude 1");
      expect(nameOf(s.doc, s.timeline, "nothing-here")).toBe("nothing-here");
      expect(nameOf(s.doc, [], "nothing-here")).toBe("nothing-here");
    });

    it("keeps names once the history is rolled back past the sketch (from the timeline, not the document)", async () => {
      const sketchId = Object.keys(s.doc.sketches)[0];
      const extrudeId = s.timeline.find((o) => o.type === "feature.extrude")!.createdIds[0];
      // roll back to just after the parameter: the sketch and both features leave the document
      await s.moveRollback(1);
      expect(s.doc.sketches[sketchId]).toBeUndefined();
      expect(s.doc.features[extrudeId]).toBeUndefined();
      const rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
      expect(rows.map((r) => r.rolledBack)).toEqual([true, true]);
      expect(nameOf(s.doc, s.timeline, sketchId)).toBe("Sketch 1"); // numbered as the Timeline panel numbers it
      expect(nameOf(s.doc, s.timeline, extrudeId)).toBe("Extrude 1");
      expect(sentenceText(rows[0], s.doc, s.timeline)).toBe("Extrude Sketch 1 by 24 mm.");
      expect(rows[0].name).toBe("Extrude 1");
      await s.moveRollback(s.timeline.length);
      expect(nameOf(s.doc, s.timeline, sketchId)).toBe(s.doc.sketches[sketchId].name);
    });

    it("names rolled-back sketches and features by their own name when the op has one, numbering sketches in timeline order", async () => {
      const t = realSession();
      const a = (await t.dispatch("sketch.create", { plane: "XY" })).createdIds[0];
      const b = (await t.dispatch("sketch.create", { plane: "XZ", name: "Profile" })).createdIds[0];
      const c = (await t.dispatch("sketch.create", { plane: "YZ" })).createdIds[0];
      await t.dispatch("sketch.addRectangle", { sketch: b, corner: { x: 0, y: 0 }, opposite: { x: 10, y: 10 } });
      const rev = (await t.dispatch("feature.revolve", { sketch: b, axis: { p1: { x: -1, y: 0 }, p2: { x: -1, y: 1 } }, angle: "90", name: "Spun" })).createdIds[0];
      expect(rev).toBeDefined();
      await t.moveRollback(0);
      expect(Object.keys(t.doc.sketches)).toEqual([]);
      expect(nameOf(t.doc, t.timeline, a)).toBe("Sketch 1");
      expect(nameOf(t.doc, t.timeline, b)).toBe("Profile");
      expect(nameOf(t.doc, t.timeline, c)).toBe("Sketch 3");
      expect(nameOf(t.doc, t.timeline, rev)).toBe("Spun");
      expect(nameFromTimeline(t.timeline, "pt-not-here")).toBeUndefined();
      const rows = featureRows(t.doc, t.timeline, t.rollbackIndex, {});
      expect(sentenceText(rows[0], t.doc, t.timeline)).toBe("Revolve Profile through 90°.");
    });

    it("builds editOperation params with one value changed as text", () => {
      const rows = featureRows(s.doc, s.timeline, s.rollbackIndex, {});
      const params = paramsWith(rows[0], "distance", 25.5);
      expect(params.distance).toBe("25.5");
      expect(params.sketch).toBe(rows[0].op.params.sketch);
      expect(rows[0].op.params.distance).toBe("h*2");
    });

    it("evaluates expressions against the parameters", () => {
      expect(evalParam(s.doc, "h/4")).toBe(3);
      expect(evalParam(s.doc, 7)).toBe(7);
      expect(Number.isNaN(evalParam(s.doc, "nope*2"))).toBe(true);
    });
  });

  it("labels units once for every surface", () => {
    expect(unitLabel("mm")).toBe("mm");
    expect(unitLabel("deg")).toBe("°");
    expect(unitLabel("")).toBe("");
  });

  it("unions and centres bounds", () => {
    const a = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 30 } }, b = { min: { x: -5, y: 5, z: 10 }, max: { x: 5, y: 25, z: 20 } };
    expect(unionBounds([a, b])).toEqual({ min: { x: -5, y: 0, z: 0 }, max: { x: 10, y: 25, z: 30 } });
    expect(unionBounds([])).toBeNull();
    expect(boundsCentre(a)).toEqual({ x: 5, y: 10, z: 15 });
  });

  it("knows which param a push on a face drives", () => {
    expect(featureSpec("extrude")?.pushParam).toBe("distance");
    expect(featureSpec("fillet")?.pushParam).toBe("radius");
    expect(featureSpec("revolve")?.pushParam).toBe("angle");
    expect(featureSpec("pattern")?.pushParam).toBe("count");
    expect(featureSpec("mirror")?.pushParam).toBeUndefined();
    // every kind with a number has a push, statically or (a primitive) by what the op carries
    for (const spec of allFeatureSpecs()) {
      if (spec.params.length) expect(spec.pushParam ?? pushParamFor({ spec, exprs: { [spec.params[0].key]: "1" } }), spec.kind).toBeDefined();
      else expect(spec.pushParam, spec.kind).toBeUndefined();
    }
  });

  it("picks the push param the op actually has: the spec's, else its first present param, else none", () => {
    const row = (kind: Parameters<typeof featureSpec>[0], exprs: Record<string, string>): Pick<FeatureRow, "spec" | "exprs"> => ({ spec: featureSpec(kind)!, exprs });
    expect(pushParamFor(row("extrude", { distance: "24" }))).toBe("distance");
    expect(pushParamFor(row("primitive", { x: "10", y: "20", z: "30" }))).toBe("x");
    expect(pushParamFor(row("primitive", { radius: "5", height: "12" }))).toBe("radius");
    expect(pushParamFor(row("primitive", { radius: "5" }))).toBe("radius");
    expect(pushParamFor(row("hole", { depth: "8" }))).toBe("depth"); // a hole op without a diameter still pushes something
    expect(pushParamFor(row("flange", {}))).toBeUndefined();
    expect(pushParamFor(row("mirror", {}))).toBeUndefined();
  });
});
