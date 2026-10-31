// The shared intents store follows the document store: the list is the open
// document's `intents` (built by the intent.* operations), one evaluation, read
// by the Ledger, the Design Space and the intent line alike.
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { realSession } from "../helpers";
import type { CadSession } from "../../src/core/command/session";
import { useStore } from "../../src/model/store";
import { useIntents } from "../../src/model/concepts/intentsStore";

const solid = (volume: number) => ({ b: { featureId: "b", name: "b", sketchId: "", distance: 0, mesh: {}, volume, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 15, z: 10 } } } }) as never;

describe("intents store", () => {
  let s: CadSession;
  beforeAll(async () => {
    s = realSession();
    await s.dispatch("parameter.add", { name: "h", expression: "12" });
  });
  beforeEach(async () => {
    // Each test starts from a document without intents.
    for (const i of [...s.doc.intents]) await s.dispatch("intent.delete", { id: i.id });
    useIntents.setState({ docId: null, intents: [], results: [], scope: {} });
  });

  it("reads the open document's intents and re-evaluates them whenever the document store changes", async () => {
    useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: solid(19200) });
    const st = useIntents.getState();
    expect(st.docId).toBe(s.doc.id);
    expect(st.scope).toMatchObject({ h: 12, volume: 19200, bodies: 1 });
    expect(st.metrics.mass).toBeCloseTo(51.84, 6);
    expect(st.density).toBe(2.7);
    expect(st.densitySource).toMatch(/aluminium/);
    const added = await useIntents.getState().add("mass <= 60", "Light");
    expect(added).toMatchObject({ label: "Light", lhs: "mass", op: "<=", rhs: "60" });
    expect(s.doc.intents).toEqual([added]); // the write went through the store into the document
    expect(s.doc.operations.at(-1)?.type).toBe("intent.add");
    expect(useIntents.getState().results[0].ok).toBe(true);
    useStore.setState({ solids: solid(30000) });
    expect(useIntents.getState().results[0]).toMatchObject({ ok: false, lhs: 81 });
    expect(localStorage.getItem(`chisel.intents.v1.${s.doc.id}`)).toBeNull(); // nothing kept outside the document
  });

  it("picks up intents already in the document when the store changes and checks them in the new scope", async () => {
    await s.dispatch("intent.add", { label: "Tall", lhs: "h", op: ">=", rhs: "10" });
    useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: {} });
    expect(useIntents.getState().intents).toEqual(s.doc.intents);
    expect(useIntents.getState().results[0]).toMatchObject({ ok: true, lhs: 12, rhs: 10 });
    expect(useIntents.getState().metrics.bodies).toBe(0);
  });

  it("an update shows at once and lands in the document; a remove takes the intent out of both", async () => {
    useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: {} });
    const i = (await useIntents.getState().add("h >= 10", "Tall"))!;
    const p = useIntents.getState().update(i.id, { rhs: "20" });
    expect(useIntents.getState().intents[0].rhs).toBe("20"); // optimistic
    expect(useIntents.getState().results[0].ok).toBe(false);
    await p;
    expect(s.doc.intents[0].rhs).toBe("20");
    expect(s.doc.operations.at(-1)).toMatchObject({ type: "intent.update", params: { id: i.id, rhs: "20" } });
    await useIntents.getState().remove(i.id);
    expect(s.doc.intents).toEqual([]);
    expect(useIntents.getState().intents).toEqual([]);
  });
});
