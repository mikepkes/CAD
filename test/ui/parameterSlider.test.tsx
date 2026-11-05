// The parameters panel's slider (src/model/store.ts setParameterExpr): it edits the latest operation that
// gives the parameter its value, so a `parameter.set` appended later (an agent's, a sweep's) does not
// undo the edit on replay.
import { describe, it, expect, beforeAll } from "vitest";
import { realSession } from "../helpers";
import { __setGeometryBackend, useStore } from "../../src/model/store";
import type { GeometryBackend, EvaluateResult } from "../../src/core/geometry/backend";

function idleBackend(): GeometryBackend {
  const evaluate = async (_doc: unknown, _p?: unknown, onMeshes?: (r: EvaluateResult) => void) => { const r = { solids: {}, facePlanes: {} }; onMeshes?.(r); return r; };
  return { init: async () => {}, ready: () => true, evaluate, edges: async () => [], exportBytes: async () => null, collide: async () => ({ maxOverlap: 0, overlaps: [] }), topology: async () => [], distance: async () => 0, analyze: async () => [], drawing: async () => ({ svg: "", parts: [] }), dispose: () => {} } as never;
}

describe("a bounded parameter's slider", () => {
  beforeAll(() => { __setGeometryBackend(idleBackend()); });

  it("sets the value although later operations set the same parameter", async () => {
    const session = realSession();
    await session.dispatch("parameter.add", { name: "fold", expression: "0", min: 0, max: 180 });
    await session.dispatch("parameter.set", { name: "fold", expression: "180" }); // an agent posed it
    await session.dispatch("parameter.set", { name: "fold", expression: "0" });   // and put it back
    useStore.setState({ session, kernelReady: true, solids: {} });
    await useStore.getState().setParameterExpr("fold", "78");
    const p = useStore.getState().session.doc.parameters.find((q) => q.name === "fold")!;
    expect(p.value).toBe(78);
    expect(p.expr).toBe("78");
    expect(useStore.getState().session.timeline.filter((o) => o.params.name === "fold").length).toBe(3); // edited, not appended
  });
});
