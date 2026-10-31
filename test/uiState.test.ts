import { describe, it, expect, beforeEach } from "vitest";
import { rightTabFor, rightTabAfterToggle, useUi } from "../src/model/concepts/uiState";

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
  });
});

describe("useUi", () => {
  beforeEach(() => useUi.setState({ panels: panels(), rightTab: "inspector", openFeature: null, hotFeature: null, hotParam: null }));
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
