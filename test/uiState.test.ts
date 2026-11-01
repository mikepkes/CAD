import { describe, it, expect, beforeEach } from "vitest";
import { rightTabFor, rightTabAfterToggle, switchPress, fitSides, maxSide, useUi, SIDE_DEFAULT, SIDE_MIN, MIN_VIEW, PANEL_NAMES } from "../src/model/concepts/uiState";

const panels = (over: Partial<Record<"workbench" | "ledger" | "space" | "lens" | "intent", boolean>> = {}) =>
  ({ workbench: true, ledger: false, space: false, lens: false, intent: true, ...over });

describe("right panel tab rules", () => {
  it("shows a tab only while its panel is on, else the inspector", () => {
    expect(rightTabFor("ledger", panels({ ledger: true }))).toBe("ledger");
    expect(rightTabFor("ledger", panels())).toBe("inspector");
    expect(rightTabFor("space", panels({ space: true }))).toBe("space");
    expect(rightTabFor("inspector", panels({ ledger: true, space: true }))).toBe("inspector");
  });
  it("turning Ledger or Space on selects it; turning the shown one off returns to the inspector", () => {
    expect(rightTabAfterToggle("inspector", "ledger", true, panels({ ledger: true }))).toBe("ledger");
    expect(rightTabAfterToggle("ledger", "space", true, panels({ ledger: true, space: true }))).toBe("space");
    expect(rightTabAfterToggle("ledger", "ledger", false, panels())).toBe("inspector");
    expect(rightTabAfterToggle("ledger", "space", false, panels({ ledger: true }))).toBe("ledger");
    expect(rightTabAfterToggle("inspector", "lens", true, panels({ lens: true }))).toBe("inspector");
    // the shown tab turned off while another is on: that one comes forward, as a closed browser tab's neighbour does
    expect(rightTabAfterToggle("space", "space", false, panels({ ledger: true }))).toBe("ledger");
  });
});

describe("a panel's switch", () => {
  it("turns it on; a lit one whose tab is hidden comes forward first; the next press turns it off", () => {
    expect(switchPress("space", panels(), "inspector", true)).toBe("on");
    expect(switchPress("space", panels({ space: true }), "inspector", true)).toBe("forward");
    expect(switchPress("space", panels({ space: true }), "space", false)).toBe("forward"); // the right side is collapsed
    expect(switchPress("space", panels({ space: true }), "space", true)).toBe("off");
    expect(switchPress("lens", panels({ lens: true }), "inspector", true)).toBe("off"); // the lens has no tab
  });
  it("has one name, the switch's, everywhere", () => {
    expect(PANEL_NAMES.workbench).toBe("Pins");
    expect(PANEL_NAMES.space).toBe("Space");
  });
});

describe("side panel widths", () => {
  const open = { left: true, right: true };
  it("default to 320 px", () => expect(SIDE_DEFAULT).toBe(320));
  it("shrink, the wider first and never under the minimum, so the view keeps MIN_VIEW", () => {
    expect(fitSides({ left: 320, right: 320 }, open, 1440)).toEqual({ left: 320, right: 320 });
    const w = fitSides({ left: 640, right: 320 }, open, 1280);
    expect(w).toEqual({ left: 480, right: 320 });
    expect(1280 - w.left - w.right).toBe(MIN_VIEW);
    const both = fitSides({ left: 640, right: 640 }, open, 1200);
    expect(both).toEqual({ left: 360, right: 360 });
    expect(fitSides({ left: 640, right: 640 }, open, 700)).toEqual({ left: SIDE_MIN, right: SIDE_MIN });
    expect(fitSides({ left: 640, right: 640 }, { left: true, right: false }, 1000)).toEqual({ left: 520, right: 640 });
  });
  it("a drag stops where the view would drop under MIN_VIEW", () => {
    expect(maxSide("left", { left: 320, right: 320 }, open, 1440)).toBe(640);
    expect(maxSide("left", { left: 320, right: 320 }, open, 1200)).toBe(400);
    expect(maxSide("left", { left: 320, right: 320 }, { left: true, right: false }, 1000)).toBe(520);
  });
});

describe("useUi", () => {
  beforeEach(() => useUi.setState({ panels: panels(), rightTab: "inspector", openFeature: null, hotFeature: null, hotParam: null, sideOpen: { left: true, right: true } }));
  it("brings a lit panel's hidden tab forward before turning it off, opening the right side", () => {
    useUi.getState().togglePanel("space");
    useUi.getState().setRightTab("inspector");
    useUi.getState().setSideOpen("right", false);
    useUi.getState().togglePanel("space");
    expect(useUi.getState().panels.space).toBe(true);
    expect(useUi.getState().rightTab).toBe("space");
    expect(useUi.getState().sideOpen.right).toBe(true);
    useUi.getState().togglePanel("space");
    expect(useUi.getState().panels.space).toBe(false);
    expect(useUi.getState().rightTab).toBe("inspector");
  });
  it("toggles panels and follows with the right tab", () => {
    useUi.getState().togglePanel("ledger");
    expect(useUi.getState().panels.ledger).toBe(true);
    expect(useUi.getState().rightTab).toBe("ledger");
    useUi.getState().setRightTab("space"); // space is off: cannot be shown
    expect(useUi.getState().rightTab).toBe("inspector");
    useUi.getState().togglePanel("space", true);
    useUi.getState().setRightTab("ledger");
    expect(useUi.getState().rightTab).toBe("ledger");
    useUi.getState().togglePanel("ledger", false);
    expect(useUi.getState().rightTab).toBe("space"); // Space is still on: its tab comes forward
    useUi.getState().togglePanel("space", false);
    expect(useUi.getState().rightTab).toBe("inspector");
  });
  it("sets hot feature only when it changes", () => {
    useUi.getState().setHotFeature("f1");
    const before = useUi.getState();
    useUi.getState().setHotFeature("f1");
    expect(useUi.getState()).toBe(before);
    useUi.getState().setHotFeature(null);
    expect(useUi.getState().hotFeature).toBeNull();
  });
});
