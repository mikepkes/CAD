import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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
  it("shows progress while the kernel draws", () => {
    useStore.setState({ drawing: { loading: true } });
    render(<DrawingView />);
    expect(screen.getByText("Drawing the views…")).toBeTruthy();
  });
  it("writes the cut list as CSV, quoting where needed", () => {
    expect(cutListCsv(parts)).toBe('part,qty,material,thickness_mm,width_mm,length_mm\nLeg,4,Beech,100,100,750\n"Top, front",1,Beech,100,124.2,1700\n');
  });
});
