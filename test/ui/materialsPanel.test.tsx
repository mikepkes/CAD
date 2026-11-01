// The Materials tab: lists the document's materials, applies one to the chosen part,
// adds from a preset (create + apply), and edits a printed material's build direction.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { realSession } from "../helpers";
import { useStore } from "../../src/model/store";
import { MaterialsPanel } from "../../src/ui/concepts/materials";
import { rightTabAfterToggle } from "../../src/model/concepts/uiState";

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

  it("is a right-panel tab: turning it on shows it", () => {
    expect(rightTabAfterToggle("inspector", "materials", true, { workbench: true, ledger: false, space: false, lens: false, intent: true, mechanism: false, materials: true })).toBe("materials");
  });
});
