import { describe, it, expect, afterEach, vi } from "vitest";
vi.mock("../../src/ui/pdf", () => ({ sheetPdf: vi.fn(async () => new Blob(["%PDF"])), saveBlob: vi.fn() }));
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { saveBlob } from "../../src/ui/pdf";
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
    expect(screen.getByRole("dialog", { name: "Shop drawing" })).toBeTruthy();
    expect(screen.getByText("Drawing the views…")).toBeTruthy();
  });
  it("writes the cut list as CSV, quoting where needed", () => {
    expect(cutListCsv(parts)).toBe('part,qty,material,thickness_mm,width_mm,length_mm\nLeg,4,Beech,100,100,750\n"Top, front",1,Beech,100,124.2,1700\n');
  });
});

describe("annotating the shop drawing", () => {
  const sheet = {
    views: [{ id: "front", label: "Front", kind: "ortho" as const, x: 0, y: 0, w: 100, h: 100, scale: 1, minU: 0, maxV: 100 }],
    picks: { front: [] },
    dimensions: [{ id: "dim1", view: "front", kind: "horizontal" as const, value: 40, text: "40" }, { id: "dim2", view: "front", kind: "radius" as const, broken: "b3 has no edge x|y" }],
  };
  const { dispatch: realDispatch, openDrawing: realOpen } = useStore.getState();
  afterEach(() => { act(() => { useStore.getState().session.doc.drafting = undefined; useStore.setState({ dispatch: realDispatch, openDrawing: realOpen }); }); vi.restoreAllMocks(); });

  it("lists the dimensions with their values (or broken), and removes one by the drawing.remove command", async () => {
    const dispatch = vi.spyOn(useStore.getState(), "dispatch").mockResolvedValue({ ok: true } as never);
    useStore.setState({ dispatch, openDrawing: vi.fn(async () => {}) });
    useStore.getState().session.doc.drafting = {
      dimensions: [{ id: "dim1", view: "front", kind: "horizontal", refs: [] }, { id: "dim2", view: "front", kind: "radius", refs: [] }],
      sections: [{ id: "sec3", label: "A", base: "front", from: { u: 0, v: 0 }, to: { u: 0, v: 1 } }], details: [],
    };
    useStore.setState({ drawing: { svg: "<svg></svg>", parts, title: "Bench", sheet } });
    render(<DrawingView />);
    expect(screen.getByRole("toolbar", { name: "Annotate the drawing" })).toBeTruthy();
    expect(screen.getByText("40")).toBeTruthy();
    expect(screen.getByText("broken").closest("li")?.getAttribute("title")).toBe("b3 has no edge x|y");
    expect(screen.getByText("section A–A · front")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove dim2" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith("drawing.remove", { id: "dim2" }));
    await waitFor(() => expect(useStore.getState().openDrawing).toHaveBeenCalledWith({ refresh: true })); // redrawn after
  });
  it("takes Escape for the tool before the dialog, and has no tools in the viewer", () => {
    useStore.setState({ drawing: { svg: "<svg></svg>", parts, title: "Bench", sheet } });
    const { unmount } = render(<DrawingView />);
    fireEvent.click(screen.getByRole("button", { name: "Section" }));
    expect(screen.getByRole("button", { name: "Section" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/click two points on the cutting line/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().drawing).not.toBeNull(); // the tool went, the dialog stayed
    expect(screen.getByRole("button", { name: "Section" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().drawing).toBeNull();
    unmount();
    useStore.setState({ drawing: { svg: "<svg></svg>", parts, title: "Bench", sheet } });
    render(<DrawingView viewer />);
    expect(screen.queryByRole("toolbar", { name: "Annotate the drawing" })).toBeNull();
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
