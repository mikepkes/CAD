import { describe, it, expect, afterEach, vi } from "vitest";
vi.mock("../../src/ui/pdf", () => ({ sheetPdf: vi.fn(async () => new Blob(["%PDF"])), saveBlob: vi.fn() }));
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { saveBlob } from "../../src/ui/pdf";
import { useStore } from "../../src/model/store";
import { DrawingView, cutListCsv } from "../../src/ui/DrawingView";

const parts = [{ part: "Leg", qty: 4, material: "Beech", kind: "wood", thickness: 100, width: 100, length: 750 }, { part: "Top, front", qty: 1, material: "Beech", kind: "wood", thickness: 100, width: 124.2, length: 1700 }];
afterEach(() => act(() => useStore.setState({ drawing: null })));

describe("shop drawing view", () => {
  it("shows the sheet and the cut list, and closes on Escape", () => {
    useStore.setState({ drawing: { svg: "<svg data-test='sheet'></svg>", parts, title: "Roubo bench" } });
    render(<DrawingView />);
    expect(screen.getByRole("dialog", { name: "Shop drawing" })).toBeTruthy();
    expect(screen.getByText("Roubo bench")).toBeTruthy();
    expect(document.querySelector("[data-test=sheet]")).toBeTruthy();
    expect(screen.getByText("100 × 100 × 750")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cut list (CSV)" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().drawing).toBeNull();
  });
  it("keys identical cut-list rows apart, says plainly what publishing does, and confirms the PDF", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const pins = [{ part: "Pin", qty: 1, material: "Iron", kind: "metal", thickness: 19.8, width: 19.8, length: 40.8 }, { part: "Pin", qty: 4, material: "Iron", kind: "metal", thickness: 19.8, width: 19.8, length: 36 }];
    useStore.setState({ drawing: { svg: "<svg></svg>", parts: pins, title: "Roubo bench" }, toast: null });
    render(<DrawingView />);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    errors.mockRestore();
    expect(screen.getByLabelText("Offer this drawing to people viewing the shared model")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(useStore.getState().toast).toEqual({ kind: "info", text: "Saved roubo-bench.pdf" }));
    expect(saveBlob).toHaveBeenCalledWith("roubo-bench.pdf", expect.any(Blob));
  });
  it("shows progress while the kernel draws", () => {
    useStore.setState({ drawing: { loading: true } });
    render(<DrawingView />);
    expect(screen.getByText("Drawing the views…")).toBeTruthy();
  });
  it("writes the cut list as CSV, quoting where needed", () => {
    expect(cutListCsv(parts)).toBe('part,qty,material,thickness_mm,width_mm,length_mm\nLeg,4,Beech,100,100,750\n"Top, front",1,Beech,100,124.2,1700\n');
  });
});
