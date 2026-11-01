// Save / share for printing in the customize viewer (V1, V2): it never writes the
// model as it was before the last edit — a slider value still waiting to commit
// is committed, and the rebuild it starts is waited for — and while it works
// the button says so and can't save twice; a toast says when it's done.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { realSession } from "../helpers";
import { __setGeometryBackend, useStore, whenRebuilt } from "../../src/model/store";
import type { GeometryBackend, EvaluateResult } from "../../src/core/geometry/backend";
import { resolveParameters } from "../../src/core/parameters";
import { editCommitter } from "../../src/ui/editCommitter";
import { SaveButton } from "../../src/ui/CustomizeControls";
import type { CadSession } from "../../src/core/command/session";

/** A stand-in kernel: one triangle per body, `W` wide, built after `delay` ms. */
function fakeBackend(delay = 40): GeometryBackend & { builds: number[] } {
  const builds: number[] = [];
  const evaluate = (doc: Parameters<GeometryBackend["evaluate"]>[0], onProgress?: (f: number) => void, onMeshes?: (r: EvaluateResult) => void) => {
    const W = resolveParameters(doc.parameters).scope.W;
    builds.push(W);
    return new Promise<EvaluateResult>((res) => setTimeout(() => {
      const fid = Object.keys(doc.features)[0];
      const r: EvaluateResult = {
        solids: { [fid]: { featureId: fid, name: "Body", sketchId: doc.features[fid].sketchId ?? "", distance: 10,
          mesh: { positions: new Float32Array([0, 0, 0, W, 0, 0, 0, W, 0]), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), edges: new Float32Array(0) } } as never },
        facePlanes: {},
      };
      onProgress?.(0.9);
      onMeshes?.(r);
      res(r);
    }, delay));
  };
  return {
    builds,
    init: async () => {}, ready: () => true, evaluate,
    edges: async () => [], exportBytes: async () => null, collide: async () => ({ maxOverlap: 0, overlaps: [] }) as never,
    topology: async () => [], distance: async () => 0, analyze: async () => [], drawing: async () => ({ svg: "", parts: [] }), dispose: () => {},
  } as never;
}

/** The widest x in a binary STL. */
function stlMaxX(buf: ArrayBuffer): number {
  const dv = new DataView(buf);
  let max = -Infinity;
  for (let t = 0; t < dv.getUint32(80, true); t++) for (let v = 0; v < 3; v++) max = Math.max(max, dv.getFloat32(84 + t * 50 + 12 + v * 12, true));
  return max;
}

let session: CadSession;
let saved: File[] = [];
beforeAll(async () => {
  session = realSession();
  await session.dispatch("parameter.add", { name: "W", expression: "64", min: 20, max: 120 });
  const sk = (await session.dispatch("sketch.create", { plane: "XY" })).createdIds![0];
  await session.dispatch("sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: 20, y: 20 } });
  await session.dispatch("feature.extrude", { sketch: sk, distance: "W" });
});
beforeEach(() => {
  saved = [];
  vi.stubGlobal("URL", Object.assign(Object.create(URL), URL, { createObjectURL: (f: File) => { saved.push(f); return "blob:x"; }, revokeObjectURL: () => {} }));
  HTMLAnchorElement.prototype.click = () => {};
});
afterEach(() => { vi.unstubAllGlobals(); act(() => useStore.setState({ saving: null, toast: null })); });

describe("Save / share for printing", () => {
  it("commits a waiting slider value and waits for its rebuild, so the file matches the screen", async () => {
    const g = fakeBackend();
    __setGeometryBackend(g);
    useStore.setState({ session, kernelReady: true, solids: {}, saving: null });
    await useStore.getState().setParameterExpr("W", "64");
    await whenRebuilt();
    expect(g.builds.at(-1)).toBe(64);

    // the slider moved to 100 a moment ago: the debounced commit hasn't fired yet
    const committer = editCommitter((n, v) => useStore.getState().setParameterExpr(n, v), 200);
    committer.edit("W", "100", false);
    render(<SaveButton onSave={() => {}} />);
    let first!: Promise<void>, second!: Promise<void>;
    act(() => {
      first = useStore.getState().shareModel("starbox", { flush: () => committer.flush() });
      second = useStore.getState().shareModel("starbox", { flush: () => committer.flush() }); // a double press
    });
    expect(useStore.getState().saving).toEqual({ stage: "updating" });
    const button = screen.getByRole("button", { name: /Updating model/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => { await first; await second; });

    expect(saved).toHaveLength(1); // saved once
    expect(saved[0].name).toBe("starbox.stl");
    expect(stlMaxX(await saved[0].arrayBuffer())).toBe(100); // the new width, not 64
    expect(useStore.getState().toast).toEqual({ kind: "info", text: "Saved starbox.stl" });
    expect(useStore.getState().saving).toBeNull();
    expect((screen.getByRole("button", { name: /Save \/ share · STL/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("whenRebuilt waits for a rebuild asked for a moment ago, before it has started", async () => {
    const g = fakeBackend(30);
    __setGeometryBackend(g);
    useStore.setState({ session, kernelReady: true, solids: {} });
    void useStore.getState().rebuildSolids(); // starts after a tick (it first makes sure of the kernel)
    await whenRebuilt();
    expect(Object.keys(useStore.getState().solids)).toHaveLength(1);
  });

  it("names the format it's preparing", async () => {
    const g = fakeBackend(5);
    __setGeometryBackend(g);
    useStore.setState({ session, kernelReady: true, solids: {} });
    await useStore.getState().rebuildSolids();
    render(<SaveButton onSave={() => {}} />);
    act(() => useStore.setState({ saving: { stage: "preparing", format: "3mf" } }));
    expect(screen.getByRole("button", { name: "Preparing 3MF…" })).toBeTruthy();
    act(() => useStore.setState({ saving: null }));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
  });
});
