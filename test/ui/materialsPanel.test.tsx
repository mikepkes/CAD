// The Materials tab: lists the document's materials, applies one to the chosen part,
// adds from a preset (create + apply), and edits a printed material's build direction.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { realSession } from "../helpers";
import { useStore } from "../../src/model/store";
import { MaterialsPanel } from "../../src/ui/concepts/materials";
import { rightTabAfterToggle } from "../../src/model/concepts/uiState";
import { useDialog } from "../../src/ui/kit/askDialog";

async function doc() {
  const s = realSession();
  const part = (await s.dispatch("component.create", { name: "Bracket" })).createdIds[0];
  const brass = (await s.dispatch("material.create", { name: "Brass", kind: "metal", finish: "polished", color: "#e3c46e" })).createdIds[0];
  return { s, part, brass };
}

describe("<MaterialsPanel/>", () => {
  let ctx: Awaited<ReturnType<typeof doc>>;
  beforeEach(async () => {
    ctx = await doc();
    useStore.setState({ session: ctx.s, rev: useStore.getState().rev + 1, activeComponentId: ctx.part });
  });

  it("lists materials and applies one to the active part", async () => {
    render(<MaterialsPanel />);
    expect((screen.getByLabelText("Apply materials to") as HTMLSelectElement).value).toBe(ctx.part);
    fireEvent.click(screen.getByTitle("Apply Brass to Bracket"));
    await waitFor(() => expect(ctx.s.doc.components[ctx.part].materialId).toBe(ctx.brass));
  });

  it("adds a preset and applies it; a printed material's build direction is one click", async () => {
    render(<MaterialsPanel />);
    fireEvent.click(screen.getByTitle("Add PLA and apply it"));
    await waitFor(() => expect(Object.values(ctx.s.doc.materials).some((m) => m.name === "PLA")).toBe(true));
    const pla = Object.values(ctx.s.doc.materials).find((m) => m.name === "PLA")!;
    await waitFor(() => expect(ctx.s.doc.components[ctx.part].materialId).toBe(pla.id));
    expect(pla).toMatchObject({ kind: "printed", printAxis: "z", mechanical: { layerFactor: 0.5 } });
    fireEvent.click(await screen.findByLabelText("Edit PLA"));
    fireEvent.click(within(screen.getByRole("group", { name: "Print direction" })).getByText("X"));
    await waitFor(() => expect(ctx.s.doc.materials[pla.id].printAxis).toBe("x"));
  });

  it("'Whole model' reaches every part: a part's own material gives way, in one undoable step", async () => {
    const steel = (await ctx.s.dispatch("material.create", { name: "Steel", kind: "metal", finish: "brushed", color: "#cccccc" })).createdIds[0];
    await ctx.s.dispatch("material.assign", { component: ctx.part, material: ctx.brass });
    useStore.setState({ rev: useStore.getState().rev + 1, activeComponentId: ctx.s.doc.rootComponentId });
    render(<MaterialsPanel />);
    expect(screen.getByTestId("mats-note").textContent).toMatch(/replacing the own material of 1 part/);
    const before = ctx.s.undoDepth;
    fireEvent.click(screen.getByTitle("Apply Steel to the whole model"));
    await waitFor(() => expect(ctx.s.doc.components[ctx.s.doc.rootComponentId].materialId).toBe(steel));
    expect(ctx.s.doc.components[ctx.part].materialId).toBeUndefined();
    expect(ctx.s.undoDepth).toBe(before + 1);
    ctx.s.undo();
    expect(ctx.s.doc.components[ctx.part].materialId).toBe(ctx.brass);
  });

  it("asks before overriding a material a parameter picks, and keeps it on Cancel", async () => {
    const pla = (await ctx.s.dispatch("material.create", { name: "PLA", kind: "printed" })).createdIds[0];
    await ctx.s.dispatch("parameter.add", { name: "stock", expression: "0", options: ["Brass", "PLA"] });
    await ctx.s.dispatch("material.assign", { component: ctx.part, materials: [ctx.brass, pla], by: "stock" });
    useStore.setState({ rev: useStore.getState().rev + 1 });
    render(<MaterialsPanel />);
    expect(screen.getByTestId("mats-note").textContent).toMatch(/Follows the parameter “stock”: Brass · PLA/);
    fireEvent.click(screen.getByTitle("Apply PLA to Bracket"));
    await waitFor(() => expect(useDialog.getState().current?.title).toBe("Override a parameter-driven material?"));
    act(() => useDialog.getState().cancel());
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.s.doc.components[ctx.part].materialChoice?.by).toBe("stock");
    fireEvent.click(screen.getByTitle("Apply PLA to Bracket"));
    await waitFor(() => expect(useDialog.getState().current).toBeTruthy());
    act(() => { const c = useDialog.getState().current; if (c?.kind === "confirm") c.settle(true); });
    await waitFor(() => expect(ctx.s.doc.components[ctx.part].materialId).toBe(pla));
    expect(ctx.s.doc.components[ctx.part].materialChoice).toBeUndefined();
  });

  it("marks the material in effect (inherited too) and reuses a preset already in the document", async () => {
    await ctx.s.dispatch("material.assign", { material: ctx.brass });
    useStore.setState({ rev: useStore.getState().rev + 1 });
    render(<MaterialsPanel />);
    // Bracket has no material of its own: the model's Brass is in effect on it
    const row = screen.getByTitle("Apply Brass to Bracket").closest("li")!;
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.textContent).toMatch(/in effect/);
    fireEvent.click(screen.getByTitle("Add PETG and apply it"));
    await waitFor(() => expect(ctx.s.doc.components[ctx.part].materialId).toBeTruthy());
    const count = Object.keys(ctx.s.doc.materials).length;
    fireEvent.click(await screen.findByTitle("Apply PETG (already in this document)"));
    await new Promise((r) => setTimeout(r, 20));
    expect(Object.values(ctx.s.doc.materials).filter((m) => m.name === "PETG")).toHaveLength(1);
    expect(Object.keys(ctx.s.doc.materials).length).toBe(count);
  });

  it("is a right-panel tab: turning it on shows it", () => {
    expect(rightTabAfterToggle("inspector", "materials", true, { workbench: true, ledger: false, space: false, lens: false, intent: true, mechanism: false, materials: true })).toBe("materials");
  });
});
