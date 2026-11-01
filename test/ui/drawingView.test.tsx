import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useStore } from "../../src/model/store";
import { DrawingView, cutListCsv } from "../../src/ui/DrawingView";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const parts = [{ part: "Leg", qty: 4, material: "Beech", kind: "wood", thickness: 100, width: 100, length: 750 }, { part: "Top, front", qty: 1, material: "Beech", kind: "wood", thickness: 100, width: 124.2, length: 1700 }];
afterEach(() => act(() => useStore.setState({ drawing: null })));

describe("shop drawing view", () => {
  it("shows the sheet and the cut list, and closes on Escape", () => {
    useStore.setState({ drawing: { svg: "<svg data-test='sheet'></svg>", parts, title: "Roubo bench" } });
    render(<DrawingView />);
    // a modal dialog named by its heading, the sheet's title
    const dialog = screen.getByRole("dialog", { name: "Roubo bench" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "Roubo bench" })).toBeTruthy();
    expect(document.querySelector("[data-test=sheet]")).toBeTruthy();
    expect(screen.getByText("100 × 100 × 750")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cut list (CSV)" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().drawing).toBeNull();
  });
  it("shows progress while the kernel draws", () => {
    useStore.setState({ drawing: { loading: true } });
    render(<DrawingView />);
    expect(screen.getByRole("dialog", { name: "Shop drawing" })).toBeTruthy();
    expect(screen.getByText("Drawing the views…")).toBeTruthy();
  });
  it("writes the cut list as CSV, quoting where needed", () => {
    expect(cutListCsv(parts)).toBe('part,qty,material,thickness_mm,width_mm,length_mm\nLeg,4,Beech,100,100,750\n"Top, front",1,Beech,100,124.2,1700\n');
  });
});

// V3: on a phone the dialog fills the screen, ✕ stays on the title row, the
// actions wrap, and the sheet stacks above the cut list (jsdom has no layout, so
// this reads the stylesheet's phone rules).
describe("shop drawing on a phone", () => {
  const path = "../../src/styles.css"; // through a variable, so Vite leaves the URL alone
  const css = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  /** The rule bodies inside `@media (max-width: 720px)` blocks, by selector. */
  const phone: Record<string, string> = {};
  for (const m of css.matchAll(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/g)) {
    for (const r of m[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) phone[r[1].trim()] = (phone[r[1].trim()] ?? "") + r[2];
  }
  it("goes full screen, wraps the actions, keeps ✕ beside the title and stacks the sheet", () => {
    expect(phone[".modal.drawing-view"]).toMatch(/width: 100vw/);
    expect(phone[".modal.drawing-view"]).toMatch(/height: 100dvh/);
    expect(phone[".drawing-view .modal-head"]).toMatch(/flex-wrap: wrap/);
    expect(phone[".drawing-view .modal-actions"]).toMatch(/flex: 1 0 100%/); // a row of its own, under title and ✕
    expect(phone[".drawing-view .modal-close"]).toMatch(/order: 1/);
    expect(phone[".drawing-view .drawing-actions"]).toMatch(/flex-wrap: wrap/);
    expect(phone[".drawing-body"]).toMatch(/flex-direction: column/);
    expect(phone[".drawing-sheet"]).toMatch(/aspect-ratio/);
  });
  it("puts the close button in the head row, after the actions", () => {
    useStore.setState({ drawing: { svg: "<svg></svg>", parts, title: "Roubo bench" } });
    render(<DrawingView viewer />);
    const head = document.querySelector(".drawing-view .modal-head")!;
    expect([...head.children].map((c) => c.className.split(" ").find((k) => k.startsWith("modal-")))).toEqual(["modal-title", "modal-actions", "modal-close"]);
  });
});
