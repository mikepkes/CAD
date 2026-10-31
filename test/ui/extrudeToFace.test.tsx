import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useStore } from "../../src/model/store";
import { ExtrudePanel } from "../../src/ui/ExtrudePanel";
import { realSession } from "../helpers";

describe("extrude to a face (panel)", () => {
  let extrudeSketch: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const s = realSession();
    const sk = await s.dispatch("sketch.create", { planeDef: { origin: { x: 45, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } } });
    extrudeSketch = vi.fn(() => Promise.resolve());
    useStore.setState({ session: s, rev: 1, extrudeSketch } as never);
    useStore.getState().openExtrude(sk.createdIds[0]);
  });

  it("picks a face, shows how far it is, and commits a toFace extrude", async () => {
    render(<ExtrudePanel />);
    fireEvent.change(screen.getByDisplayValue("Distance"), { target: { value: "toFace" } });
    expect(screen.getByText("click a face")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Extrude" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useStore.getState().pickExtrudeToFace({ x: -45, y: 3, z: 2 }, { x: -1, y: 0, z: 0 }));
    expect(screen.getByText("the face, -90 mm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Extrude" }));
    await act(async () => {});
    expect(extrudeSketch).toHaveBeenCalledWith(expect.any(String), "-90", expect.objectContaining({ toFace: expect.objectContaining({ normal: { x: -1, y: 0, z: 0 }, point: { x: -45, y: 3, z: 2 } }) }));
  });
});
