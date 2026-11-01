// M11: the Extrude panel lists profiles by the names the browser shows and only
// sketches that can be extruded, has Reverse and Through all, and refuses a
// sketch with no closed region with a sentence.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { realSession } from "../helpers";
import type { CadSession } from "../../src/core/command/session";
import { useStore } from "../../src/model/store";
import { ExtrudePanel } from "../../src/ui/ExtrudePanel";

let s: CadSession;
let closed: string, open: string;
beforeEach(async () => {
  s = realSession();
  await s.dispatch("sketch.create", { plane: "XY" }); // Sketch 1: empty
  closed = (await s.dispatch("sketch.create", { plane: "XZ" })).createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: closed, corner: { x: 0, y: 0 }, opposite: { x: 20, y: 10 } });
  open = (await s.dispatch("sketch.create", { plane: "YZ" })).createdIds[0];
  await s.dispatch("sketch.addLine", { sketch: open, start: { x: 0, y: 0 }, end: { x: 5, y: 5 } });
  useStore.setState({ session: s, rev: 1, solids: {}, mode: "model", toast: null, activeSketchId: null, rebuildSolids: vi.fn(async () => {}), ensureKernel: vi.fn(async () => {}) } as never);
});

describe("the Extrude panel", () => {
  it("offers only extrudable sketches, by name", () => {
    act(() => useStore.getState().openExtrude());
    render(<ExtrudePanel />);
    const profile = screen.getByRole("combobox", { name: "Profile" }) as HTMLSelectElement;
    expect([...profile.options].map((o) => o.textContent)).toEqual(["Sketch 2 · XZ"]);
    expect(profile.value).toBe(closed);
  });

  it("extrudes through all, reversed", async () => {
    act(() => useStore.getState().openExtrude());
    render(<ExtrudePanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Extent" }), { target: { value: "throughAll" } });
    expect(screen.getByText("past every body")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Reverse/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Extrude" })); });
    const f = Object.values(s.doc.features)[0] as { extent?: string; direction?: string };
    expect(f.extent).toBe("throughAll");
    expect(f.direction).toBe("reverse");
  });

  it("refuses a sketch without a closed region, saying why", async () => {
    await act(async () => { await useStore.getState().extrudeSketch(open, "10"); });
    expect(Object.keys(s.doc.features)).toEqual([]);
    expect(useStore.getState().toast?.text).toBe("Sketch 3 has no closed region to extrude: close its outline first");
  });
});
