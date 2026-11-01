// Parameters a person can read (V7): an optional label, unit and one-line
// description on a parameter (parameter.add, parameter.describe), and a title
// and intro for the design (document.describe). They persist with the recipe,
// survive a rename, reach the agent's tools, and are display only.
import { describe, it, expect } from "vitest";
import { realSession, sessionFromDoc } from "./helpers";
import { serializeDocument, deserializeDocument } from "../src/core/persistence";
import { createDefaultRegistry } from "../src/core/command/builtins";

describe("describing parameters", () => {
  it("parameter.add takes a label, unit and description", async () => {
    const s = realSession();
    const r = await s.dispatch("parameter.add", { name: "L", expression: "1700", min: 1200, max: 2400, label: " Length ", unit: "mm", description: "Overall length of the bench top" });
    expect(r.ok).toBe(true);
    expect(s.doc.parameters[0]).toMatchObject({ name: "L", label: "Length", unit: "mm", description: "Overall length of the bench top", value: 1700 });
    await s.dispatch("parameter.add", { name: "D", expression: "500", label: "" });
    expect(s.doc.parameters[1].label).toBeUndefined(); // empty means none
  });

  it("parameter.describe sets, keeps and clears each field", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "TT", expression: "100" });
    expect((await s.dispatch("parameter.describe", { name: "TT", label: "Top thickness", unit: "mm" })).ok).toBe(true);
    expect(s.doc.parameters[0]).toMatchObject({ label: "Top thickness", unit: "mm" });
    await s.dispatch("parameter.describe", { name: "TT", description: "How thick the laminated top is" });
    expect(s.doc.parameters[0]).toMatchObject({ label: "Top thickness", unit: "mm", description: "How thick the laminated top is" });
    await s.dispatch("parameter.describe", { name: "TT", unit: "" });
    expect(s.doc.parameters[0].unit).toBeUndefined();
    expect(s.doc.parameters[0].label).toBe("Top thickness");
    expect((await s.dispatch("parameter.describe", { name: "nope", label: "x" })).ok).toBe(false);
    // undoable, like any edit
    s.undo();
    expect(s.doc.parameters[0].unit).toBe("mm");
  });

  it("document.describe titles the design and gives it an intro", async () => {
    const s = realSession();
    await s.dispatch("document.describe", { title: "Roubo workbench", description: "A full-size woodworking bench." });
    expect(s.doc.about).toEqual({ title: "Roubo workbench", description: "A full-size woodworking bench." });
    await s.dispatch("document.describe", { description: "" });
    expect(s.doc.about).toEqual({ title: "Roubo workbench" });
  });

  it("persists with the recipe and survives a rename", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "W", expression: "64", min: 40, max: 120, label: "Width", unit: "mm" });
    await s.dispatch("parameter.describe", { name: "W", description: "Across the box" });
    await s.dispatch("document.describe", { title: "Star box" });
    const back = sessionFromDoc(deserializeDocument(serializeDocument(s.doc)));
    await back.recompute();
    expect(back.doc.parameters[0]).toMatchObject({ name: "W", label: "Width", unit: "mm", description: "Across the box" });
    expect(back.doc.about).toEqual({ title: "Star box" });
    const r = await back.renameParameter("W", "width");
    expect(r.ok).toBe(true);
    expect(back.doc.parameters[0]).toMatchObject({ name: "width", label: "Width", unit: "mm", description: "Across the box" });
  });

  it("the agent's and MCP's tools offer the fields", () => {
    const tools = createDefaultRegistry().toMcpTools();
    const add = tools.find((t) => t.name === "parameter.add")!;
    const props = (add.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["label", "unit", "description"]));
    expect(tools.find((t) => t.name === "parameter.describe")).toBeTruthy();
    expect(tools.find((t) => t.name === "document.describe")).toBeTruthy();
  });
});
