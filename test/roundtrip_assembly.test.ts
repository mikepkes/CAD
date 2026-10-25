import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sessionFromDoc } from "./helpers";
import { deserializeDocument } from "../src/core/persistence";

// Mimic the app's load path: deserialize the example, replay, then edit theta
// exactly as the customize slider does.
describe("round-trip edit of the jointed scissor example", () => {
  it("loads the json, replays, and theta edits take", async () => {
    const json = readFileSync(fileURLToPath(new URL("../public/examples/scissor-jointed.json", import.meta.url)), "utf8");
    const doc = deserializeDocument(json);
    const s = sessionFromDoc(doc);
    await s.recompute(); // replays operations → derived state

    expect(Object.keys(s.doc.componentPatterns).length).toBe(1);
    expect(Object.keys(s.doc.jointTemplates).length).toBe(4);
    const theta0 = s.doc.parameters.find((p) => p.name === "theta")!;
    expect(theta0.value).toBe(40);

    // Editing the parameter's defining op (as the Customize slider does) must take.
    // This guards against an example serialized with trailing parameter.set ops,
    // which would silently override the slider on load.
    expect(s.timeline.filter((o) => o.type === "parameter.set").length).toBe(0);
    const op = s.timeline.find((o) => o.type === "parameter.add" && (o.params as { name?: string }).name === "theta")!;
    const r = await s.editOperation(op.opId, { ...(op.params as object), name: "theta", expression: "25" });
    expect(r.ok).toBe(true);
    const theta = s.doc.parameters.find((p) => p.name === "theta")!;
    expect(theta.expr).toBe("25");
    expect(theta.value).toBe(25);
  });
});
