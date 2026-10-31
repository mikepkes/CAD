import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SpaceMouseButtons } from "../../src/ui/SpaceMouseButtons";
import { hotkeys } from "../../src/model/hotkeys";
import { setSpaceMouseSettings, spaceMouseSettings } from "../../src/model/spaceMouseInput";
import { DEFAULT_SETTINGS } from "../../src/viewport/spaceMouse";

let off: () => void;
beforeEach(() => {
  setSpaceMouseSettings({ buttons: { ...DEFAULT_SETTINGS.buttons }, contextButtons: {} });
  hotkeys.setContexts(["global", "model", "face"]);
  off = hotkeys.registerAll([
    { id: "view.frame", label: "Frame selection / fit", context: "global", run: () => {} },
    { id: "view.iso", label: "View: Iso", context: "global", run: () => {} },
    { id: "ring.open", label: "Action ring (hold, point, release)", context: "global", defaultPrimary: "space", run: () => {} },
    { id: "model.extrude", label: "Extrude", context: "model", run: () => {} },
    { id: "face.lookAt", label: "Look at face", context: "face", run: () => {} },
    { id: "tool.line", label: "Line tool", context: "sketch", run: () => {} },
  ]);
});
afterEach(() => { off(); hotkeys.setContexts(["global"]); });

const select = (name: RegExp) => screen.getByRole("combobox", { name }) as HTMLSelectElement;

describe("3D-mouse button editor", () => {
  it("opens on the top active context, inheriting the global buttons", () => {
    render(<SpaceMouseButtons />);
    const b1 = select(/Button 1 \(Face selected\)/);
    expect(b1.value).toBe("__inherit");
    expect(within(b1).getByRole("option", { name: /Inherit \(Everywhere: Frame selection/ })).toBeTruthy();
  });

  it("offers every action from the context and those it sits on, ring included, but not other contexts", () => {
    render(<SpaceMouseButtons />);
    const names = [...select(/Button 1/).options].map((o) => o.textContent);
    expect(names.some((n) => n?.startsWith("Look at face"))).toBe(true);
    expect(names.some((n) => n?.startsWith("Extrude"))).toBe(true);
    expect(names.some((n) => n?.startsWith("Action ring"))).toBe(true);
    expect(names.some((n) => n?.startsWith("Line tool"))).toBe(false);
  });

  it("overrides a button in one context and saves it to the settings", () => {
    render(<SpaceMouseButtons />);
    fireEvent.change(select(/Button 1 \(Face selected\)/), { target: { value: "face.lookAt" } });
    expect(spaceMouseSettings().contextButtons).toEqual({ face: { 0: "face.lookAt" } });
    expect(spaceMouseSettings().buttons).toEqual(DEFAULT_SETTINGS.buttons);
    expect(screen.getAllByText(/now: Look at face/).length).toBe(1);
    fireEvent.change(select(/Button 2 \(Face selected\)/), { target: { value: "" } });
    expect(spaceMouseSettings().contextButtons).toEqual({ face: { 0: "face.lookAt", 1: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Clear Face selected overrides/ }));
    expect(spaceMouseSettings().contextButtons).toEqual({});
  });

  it("edits the global row and adds rows", () => {
    render(<SpaceMouseButtons />);
    fireEvent.click(screen.getByRole("button", { name: /^Everywhere/ }));
    fireEvent.change(select(/Button 2 \(Everywhere\)/), { target: { value: "ring.open" } });
    expect(spaceMouseSettings().buttons).toEqual({ 0: "view.frame", 1: "ring.open" });
    fireEvent.click(screen.getByRole("button", { name: "Add a button" }));
    expect(select(/Button 3 \(Everywhere\)/).value).toBe("");
  });
});
