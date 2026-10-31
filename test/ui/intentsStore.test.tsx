// The shared intents store follows the document store: one evaluation, read by
// the Ledger, the Design Space and the intent line alike.
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { realSession } from "../helpers";
import type { CadSession } from "../../src/core/command/session";
import { useStore } from "../../src/model/store";
import { useIntents } from "../../src/model/concepts/intentsStore";
import { parseIntent } from "../../src/model/concepts/intents";

const solid = (volume: number) => ({ b: { featureId: "b", name: "b", sketchId: "", distance: 0, mesh: {}, volume, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 15, z: 10 } } } }) as never;

describe("intents store", () => {
  let s: CadSession;
  beforeAll(async () => {
    s = realSession();
    await s.dispatch("parameter.add", { name: "h", expression: "12" });
  });
  beforeEach(() => {
    localStorage.clear();
    useIntents.setState({ docId: null, intents: [], results: [], scope: {} });
  });

  it("loads the open document's intents and re-evaluates them whenever the document store changes", () => {
    useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: solid(19200) });
    const st = useIntents.getState();
    expect(st.docId).toBe(s.doc.id);
    expect(st.scope).toMatchObject({ h: 12, volume: 19200, bodies: 1 });
    expect(st.metrics.mass).toBeCloseTo(51.84, 6);
    expect(st.density).toBe(2.7);
    expect(st.densitySource).toMatch(/aluminium/);
    useIntents.getState().add("mass <= 60", "Light");
    expect(useIntents.getState().results[0].ok).toBe(true);
    useStore.setState({ solids: solid(30000) });
    expect(useIntents.getState().results[0]).toMatchObject({ ok: false, lhs: 81 });
    expect(localStorage.getItem(`chisel.intents.v1.${s.doc.id}`)).toContain("mass");
  });

  it("keeps a list set before the store changes and checks it in the new scope", () => {
    useIntents.setState({ docId: s.doc.id, intents: [parseIntent("h >= 10", "i1", "Tall")!] });
    useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: {} });
    expect(useIntents.getState().intents.length).toBe(1);
    expect(useIntents.getState().results[0]).toMatchObject({ ok: true, lhs: 12, rhs: 10 });
    expect(useIntents.getState().metrics.bodies).toBe(0);
  });
});
