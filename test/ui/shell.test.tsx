import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useUi } from "../../src/model/concepts/uiState";
import { useStore } from "../../src/model/store";
import { PanelToggles, RightPanel } from "../../src/ui/ConceptShell";

const reset = () => useUi.setState({ panels: { workbench: true, ledger: false, space: false, lens: false, intent: true }, rightTab: "inspector" });

describe("PanelToggles", () => {
  beforeEach(reset);
  it("shows one pressed switch per shown panel and toggles through useUi", async () => {
    render(<PanelToggles />);
    const bar = screen.getByRole("toolbar", { name: "Concept panels" });
    expect(within(bar).getByRole("button", { name: "Pins" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(bar).getByRole("button", { name: "Lens" }).getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(within(bar).getByRole("button", { name: "Lens" }));
    expect(useUi.getState().panels.lens).toBe(true);
    await userEvent.click(within(bar).getByRole("button", { name: "Ledger" }));
    expect(useUi.getState().panels.ledger).toBe(true);
    expect(useUi.getState().rightTab).toBe("ledger");
    expect(within(bar).getByRole("button", { name: "Open the intent line" })).toBeTruthy();
  });
});

describe("RightPanel", () => {
  beforeEach(() => { reset(); useStore.setState({ mode: "model" }); });
  it("is the inspector alone until a tabbed panel is on", () => {
    render(<RightPanel />);
    expect(screen.queryByRole("group", { name: "Right panel" })).toBeNull();
    expect(document.querySelector(".panel.inspector")).toBeTruthy();
  });
  it("adds Ledger / Space tabs and switches between them", async () => {
    useUi.getState().togglePanel("ledger", true);
    useUi.getState().togglePanel("space", true);
    render(<RightPanel />);
    const tabs = screen.getByRole("group", { name: "Right panel" });
    expect(within(tabs).getAllByRole("button").map((b) => b.textContent)).toEqual(["Inspector", "Ledger", "Space"]);
    expect(screen.getByTestId("space-empty")).toBeTruthy(); // the panel turned on last is the shown tab
    await userEvent.click(within(tabs).getByRole("button", { name: "Ledger" }));
    expect(screen.getByRole("region", { name: "Ledger" })).toBeTruthy();
    await userEvent.click(within(tabs).getByRole("button", { name: "Space" }));
    expect(screen.getByTestId("space-empty")).toBeTruthy();
    await userEvent.click(within(tabs).getByRole("button", { name: "Inspector" }));
    expect(document.querySelector(".panel.inspector")).toBeTruthy();
  });
  it("falls back to the inspector when the shown tab's panel goes off", () => {
    useUi.getState().togglePanel("ledger", true);
    const { rerender } = render(<RightPanel />);
    expect(screen.getByRole("region", { name: "Ledger" })).toBeTruthy();
    useUi.getState().togglePanel("ledger", false);
    rerender(<RightPanel />);
    expect(screen.queryByRole("region", { name: "Ledger" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Right panel" })).toBeNull();
  });
});
