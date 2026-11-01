import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useUi } from "../../src/model/concepts/uiState";
import { useStore } from "../../src/model/store";
import { PanelToggles, RightPanel } from "../../src/ui/ConceptShell";
import { OverflowRow } from "../../src/ui/kit/OverflowRow";

const reset = () => { useUi.setState({ panels: { workbench: true, ledger: false, space: false, lens: false, intent: true } as never, rightTab: "inspector", sideOpen: { left: true, right: true } }); useStore.setState({ mode: "model" }); };

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

describe("PanelToggles, more", () => {
  beforeEach(reset);
  it("a lit switch whose tab is hidden brings the tab forward; the second press turns it off", async () => {
    useUi.getState().togglePanel("ledger", true);
    useUi.getState().setRightTab("inspector");
    render(<PanelToggles />);
    const bar = screen.getByRole("toolbar", { name: "Concept panels" });
    await userEvent.click(within(bar).getByRole("button", { name: "Ledger" }));
    expect(useUi.getState().panels.ledger).toBe(true);
    expect(useUi.getState().rightTab).toBe("ledger");
    await userEvent.click(within(bar).getByRole("button", { name: "Ledger" }));
    expect(useUi.getState().panels.ledger).toBe(false);
  });
  it("says Pins also shows the history strip, and names each panel as its switch does in the hotkeys", async () => {
    render(<PanelToggles />);
    expect(screen.getByRole("button", { name: "Pins" }).getAttribute("title")).toMatch(/history strip/);
    const { installHotkeys } = await import("../../src/model/hotkeyActions");
    const { hotkeys } = await import("../../src/model/hotkeys");
    const off = installHotkeys();
    const labels = Object.fromEntries(hotkeys.describe().contexts.flatMap((c) => c.actions).map((a) => [a.id, a.label]));
    expect(labels["view.workbench"]).toMatch(/^Toggle Pins/);
    expect(labels["view.space"]).toBe("Toggle Space");
    expect(labels["view.materials"]).toBe("Toggle Materials"); // Materials has a hotkey action now
    off();
  });

  it("is hidden while sketching (the sketch needs the whole view)", () => {
    useStore.setState({ mode: "sketch" });
    render(<PanelToggles />);
    expect(screen.queryByRole("toolbar", { name: "Concept panels" })).toBeNull();
  });
});

describe("OverflowRow", () => {
  it("keeps one line: what does not fit goes into the ⋯ menu, and runs from there", async () => {
    const proto = HTMLElement.prototype;
    const keep = { ow: Object.getOwnPropertyDescriptor(proto, "offsetWidth"), cw: Object.getOwnPropertyDescriptor(proto, "clientWidth") };
    Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return (this as HTMLElement).classList.contains("k-ovf-more") ? 30 : 100; } });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return (this as HTMLElement).classList.contains("k-ovf") ? 250 : 0; } });
    try {
      let ran = "";
      const btn = (k: string) => <button onClick={() => { ran = k; }}>{k}</button>;
      render(<OverflowRow ariaLabel="Row" role="toolbar" items={[
        { key: "a", node: btn("A"), priority: 2 }, { key: "b", node: btn("B"), priority: 1 }, { key: "c", node: btn("C") }, { key: "k", node: btn("K"), pin: true },
      ]} />);
      const row = screen.getByRole("toolbar", { name: "Row" });
      // four 100-px items in 250 px: only A and the pinned K stay, with the menu button
      expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["A", "K", "⋯2"]);
      await userEvent.click(within(row).getByRole("button", { name: "More" }));
      const menu = screen.getByRole("menu", { name: "More" });
      expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual(["B", "C"]);
      await userEvent.click(within(menu).getByRole("button", { name: "C" }));
      expect(ran).toBe("C");
      expect(screen.queryByRole("menu", { name: "More" })).toBeNull();
    } finally {
      if (keep.ow) Object.defineProperty(proto, "offsetWidth", keep.ow);
      if (keep.cw) Object.defineProperty(proto, "clientWidth", keep.cw);
    }
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
