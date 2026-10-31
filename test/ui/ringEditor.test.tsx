import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { hotkeys, type HotkeyAction } from "../../src/model/hotkeys";
import { useRing } from "../../src/model/ring";
import { useStore } from "../../src/model/store";
import { RingEditor } from "../../src/ui/RingEditor";
import { HotkeyPanel } from "../../src/ui/HotkeyPanel";

// The ring section of the Hotkeys panel: what it shows per context (own slots,
// inherited ones and where from), and that every change goes through useRing.

const act_ = (id: string, context: string, label: string, defaultPrimary?: string): HotkeyAction => ({ id, label, context, defaultPrimary, run: () => {} });
const ACTS = [
  act_("view.top", "global", "View: Top"), act_("view.iso", "global", "View: Iso"), act_("edit.undo", "global", "Undo", "mod+z"),
  act_("ring.open", "global", "Action ring", "space"),
  act_("model.sketch", "model", "New sketch"), act_("model.component", "model", "New component"),
  act_("tool.line", "sketch", "Line tool", "l"), act_("tool.rectangle", "sketch", "Rectangle tool", "r"),
  act_("face.sketch", "face", "Sketch on face"), act_("face.lookAt", "face", "Look at face"),
  act_("lens.zebra", "lens", "Zebra"),
];

const slot = (name: string) => screen.getByRole("button", { name: `Slot ${name}` });
const pickerFor = (name: string) => screen.getByRole("combobox", { name: `Action for slot ${name}` }) as HTMLSelectElement;
const ctxPill = (label: RegExp) => within(screen.getByRole("group", { name: "Ring context" })).getByRole("button", { name: label });

describe("RingEditor", () => {
  let off: () => void;
  beforeEach(() => {
    off = hotkeys.registerAll(ACTS);
    hotkeys.setContexts(["global", "model", "face"]);
    useRing.getState().resetAll();
  });
  afterEach(() => { off(); hotkeys.setContexts(["global"]); useRing.getState().resetAll(); });

  it("opens on the top of the active stack and shows its own and inherited slots", () => {
    render(<RingEditor />);
    expect(ctxPill(/^Face selected/).getAttribute("aria-pressed")).toBe("true");
    expect(slot("N").textContent).toContain("Sketch on face");
    expect(slot("N").className).not.toContain("inherits");
    // NW: face sets nothing, so it shows the model's slot, dimmed, with its source
    expect(slot("NW").className).toContain("inherits");
    expect(slot("NW").textContent).toContain("New component");
    expect(slot("NW").textContent).toContain("from Model");
  });

  it("switching context shows that ring; global inherits nothing", () => {
    render(<RingEditor />);
    fireEvent.click(ctxPill(/^Sketch/));
    expect(slot("N").textContent).toContain("Line tool");
    expect(slot("W").textContent).toContain("Undo");
    expect(slot("W").textContent).toContain("from Everywhere");
    fireEvent.click(ctxPill(/^Everywhere/));
    fireEvent.click(slot("N"));
    expect(pickerFor("N").options[0].textContent).toBe("Inherit (nothing below: empty)");
  });

  it("the picker offers inherit, then only actions from the ring's sources, grouped", () => {
    render(<RingEditor />);
    fireEvent.click(slot("NW"));
    const sel = pickerFor("NW");
    expect(sel.value).toBe("");
    expect(sel.options[0].textContent).toBe("Inherit (from Model: New component)");
    const groups = [...sel.querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["Everywhere", "Model", "Face selected"]);
    const ids = [...sel.options].map((o) => o.value);
    expect(ids).toEqual(expect.arrayContaining(["view.top", "edit.undo", "model.sketch", "face.lookAt"]));
    expect(ids).not.toContain("tool.line");
    expect(ids).not.toContain("lens.zebra");
    expect(ids).not.toContain("ring.open");
    expect([...sel.options].find((o) => o.value === "edit.undo")!.textContent).toMatch(/^Undo · /);
  });

  it("choosing an action sets the slot in the store and the compass; inherit and reset undo it", () => {
    render(<RingEditor />);
    fireEvent.click(slot("NW"));
    fireEvent.change(pickerFor("NW"), { target: { value: "face.lookAt" } });
    expect(useRing.getState().overrides.face).toEqual({ 7: "face.lookAt" });
    expect(slot("NW").textContent).toContain("Look at face");
    expect(slot("NW").className).not.toContain("inherits");
    expect(ctxPill(/^Face selected •/)).toBeTruthy(); // customized dot
    expect(screen.getByLabelText("Ring now").textContent).toContain("NW Look at face");

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(useRing.getState().overrides).toEqual({});
    expect(slot("NW").textContent).toContain("from Model");

    // N defaults to face.sketch: inheriting overrides it, and the model's N shows through
    fireEvent.click(slot("N"));
    fireEvent.change(pickerFor("N"), { target: { value: "" } });
    expect(useRing.getState().overrides.face).toEqual({ 0: null });
    expect(slot("N").textContent).toContain("New sketch");
    expect(slot("N").textContent).toContain("from Model");
  });

  it("reset this ring and reset all rings clear the overrides", () => {
    useRing.getState().setSlot("face", 7, "view.top");
    useRing.getState().setSlot("sketch", 6, "view.iso");
    render(<RingEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Reset this ring" }));
    expect(useRing.getState().overrides).toEqual({ sketch: { 6: "view.iso" } });
    expect(slot("NW").textContent).toContain("from Model");
    fireEvent.click(screen.getByRole("button", { name: "Reset all rings" }));
    expect(useRing.getState().overrides).toEqual({});
  });

  it("previews the ring Space shows on the current stack, and follows the stack", () => {
    render(<RingEditor />);
    const now = screen.getByLabelText("Ring now");
    expect(now.textContent).toContain("N Sketch on face");
    expect(now.textContent).toContain("NW New component");
    act(() => hotkeys.setContexts(["global", "sketch"]));
    expect(now.textContent).toContain("N Line tool · NE Rectangle tool");
  });
});

describe("HotkeyPanel", () => {
  let off: () => void;
  beforeEach(() => {
    off = hotkeys.registerAll(ACTS);
    hotkeys.setContexts(["global", "model"]);
    useStore.getState().setHotkeysOpen(true);
  });
  afterEach(() => { off(); hotkeys.setContexts(["global"]); useStore.getState().setHotkeysOpen(false); });

  it("labels context groups and switches to the ring section", () => {
    render(<HotkeyPanel />);
    expect(screen.getByText("Everywhere")).toBeTruthy();
    expect(screen.getByText("Face selected").className).not.toContain("active");
    expect(screen.getByText("Model").className).toContain("active");
    fireEvent.click(within(screen.getByRole("group", { name: "Hotkeys section" })).getByRole("button", { name: "Ring" }));
    expect(screen.getByRole("group", { name: "Model ring" })).toBeTruthy();
    expect(screen.getByText(/Hold Space/)).toBeTruthy();
  });
});
