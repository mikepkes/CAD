import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { realSession } from "../helpers";
import type { CadSession } from "../../src/core/command/session";

import { useStore } from "../../src/model/store";
import { hotkeys, prettyKey } from "../../src/model/hotkeys";
import { useUi } from "../../src/model/concepts/uiState";
import { useIntents } from "../../src/model/concepts/intentsStore";
import { IntentLine, IntentButton, OPEN_ACTION_ID } from "../../src/ui/concepts/intent";

let session: CadSession;

async function build() {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "h", expression: "12" });
  const sk = await s.dispatch("sketch.create", { plane: "XY" });
  const sid = sk.createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
  await s.dispatch("feature.extrude", { sketch: sid, distance: "h*2" });
  await s.dispatch("feature.fillet", { radius: "1.5" });
  return s;
}

const open = () => act(() => { hotkeys.runAction(OPEN_ACTION_ID); });
const input = () => screen.getByRole("combobox", { name: "What do you want?" });

describe("<IntentLine/>", () => {
  beforeAll(async () => { session = await build(); });
  beforeEach(() => {
    useStore.setState({ session, rev: useStore.getState().rev + 1, solids: {}, lastMessage: "", kernelReady: false });
    useUi.setState({ openFeature: null, panels: { workbench: true, ledger: false, space: false, lens: false, intent: true } });
    localStorage.clear();
    useIntents.setState({ docId: session.doc.id, intents: [], results: [], scope: {} });
  });

  it("renders nothing until opened; registers its hotkey action while mounted", () => {
    const { unmount } = render(<IntentLine />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hotkeys.describe().contexts.flatMap((c) => c.actions).some((a) => a.id === OPEN_ACTION_ID)).toBe(true);
    expect(hotkeys.primary(OPEN_ACTION_ID)).toBe("mod+k");
    expect(hotkeys.secondary(OPEN_ACTION_ID)).toBe("/");
    unmount();
    expect(hotkeys.runAction(OPEN_ACTION_ID)).toBe(false);
  });

  it("opens on ⌘K and '/' (not from an input), focuses the input, closes on Escape", async () => {
    render(<><input aria-label="other" /><IntentLine /></>);
    const off = hotkeys.attach(window);
    try {
      // a key pressed inside a text field is not a hotkey
      fireEvent.keyDown(screen.getByLabelText("other"), { key: "/" });
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.keyDown(document.body, { key: "k", metaKey: true });
      expect(screen.getByRole("dialog", { name: "Intent line" })).toBeTruthy();
      expect(document.activeElement).toBe(input());
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.keyDown(document.body, { key: "/" });
      expect(screen.getByRole("dialog")).toBeTruthy();
    } finally { off(); }
  });

  it("lists ranked suggestions as a listbox, moves with the arrows and runs the selected one on Enter", async () => {
    render(<IntentLine />);
    open();
    await userEvent.type(input(), "fillet 3");
    const list = screen.getByRole("listbox", { name: "Suggestions" });
    const options = list.querySelectorAll("[role=option]");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[0].textContent).toMatch(/2 · Fillet · Radius → 3\.0 mm/);
    expect(input().getAttribute("aria-activedescendant")).toBe(options[0].id);
    if (options.length > 1) {
      await userEvent.keyboard("{ArrowDown}");
      expect(input().getAttribute("aria-activedescendant")).toBe(options[1].id);
      await userEvent.keyboard("{ArrowUp}");
    }
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    const fillet = session.timeline.find((o) => o.type === "feature.fillet")!;
    await waitFor(() => expect(fillet.params.radius ?? session.timeline.find((o) => o.type === "feature.fillet")!.params.radius).toBe("3"));
    await waitFor(() => expect(useStore.getState().lastMessage).toBe("2 · Fillet: radius 3.0 mm."));
  });

  it("sets a document parameter through setParameterExpr", async () => {
    render(<IntentLine />);
    open();
    await userEvent.type(input(), "h = 20{Enter}");
    await waitFor(() => expect(session.doc.parameters.find((p) => p.name === "h")?.expr).toBe("20"));
    expect(useStore.getState().lastMessage).toBe("Set h to 20.");
  });

  it("fires the view and frame events", async () => {
    const seen: string[] = [];
    const onView = (e: Event) => seen.push(`view:${(e as CustomEvent).detail}`);
    const onFrame = () => seen.push("frame");
    window.addEventListener("chisel:view", onView); window.addEventListener("chisel:frame", onFrame);
    try {
      render(<IntentLine />);
      open(); await userEvent.type(input(), "front{Enter}");
      open(); await userEvent.type(input(), "fit{Enter}");
      await waitFor(() => expect(seen).toEqual(["view:front", "frame"]));
      expect(useStore.getState().lastMessage).toBe("Framed.");
    } finally { window.removeEventListener("chisel:view", onView); window.removeEventListener("chisel:frame", onFrame); }
  });

  it("rolls back, suppresses and restores through the store", async () => {
    render(<IntentLine />);
    open(); await userEvent.type(input(), "back to extrude{Enter}");
    await waitFor(() => expect(session.rollbackIndex).toBe(session.timeline.findIndex((o) => o.type === "feature.extrude") + 1));
    open(); await userEvent.type(input(), "roll end{Enter}");
    await waitFor(() => expect(session.rollbackIndex).toBe(session.timeline.length));
    open(); await userEvent.type(input(), "suppress fillet{Enter}");
    await waitFor(() => expect(session.timeline.find((o) => o.type === "feature.fillet")!.suppressed).toBe(true));
    open(); await userEvent.type(input(), "unsuppress{Enter}");
    await waitFor(() => expect(session.timeline.find((o) => o.type === "feature.fillet")!.suppressed).toBeFalsy());
  });

  it("'measure <feature>' opens its card in the shared UI state; panel names toggle panels", async () => {
    render(<IntentLine />);
    open(); await userEvent.type(input(), "measure fillet{Enter}");
    const fillet = session.timeline.find((o) => o.type === "feature.fillet")!;
    expect(useUi.getState().openFeature).toBe(fillet.createdIds[0]);
    open(); await userEvent.type(input(), "ledger{Enter}");
    expect(useUi.getState().panels.ledger).toBe(true);
  });

  it("a comparator adds a design intent to the shared intents store, and a duplicate is said so", async () => {
    render(<IntentLine />);
    open(); await userEvent.type(input(), "mass <= 120{Enter}");
    expect(useIntents.getState().intents).toHaveLength(1);
    expect(useIntents.getState().intents[0]).toMatchObject({ lhs: "mass", op: "<=", rhs: "120", label: "mass" });
    expect(useStore.getState().lastMessage).toBe("Intent added: mass <= 120");
    open(); await userEvent.type(input(), "mass <= 120");
    expect(screen.getByRole("option", { name: /Already an intent/ })).toBeTruthy();
  });

  it("runs a hotkey action by its label and reports one that is unavailable", async () => {
    const run = vi.fn();
    const off = hotkeys.register({ id: "test.zap", label: "Zap the widget", context: "global", run, when: () => false });
    try {
      render(<IntentLine />);
      open(); await userEvent.type(input(), "zap{Enter}");
      expect(run).not.toHaveBeenCalled();
      await waitFor(() => expect(useStore.getState().lastMessage).toMatch(/not available/));
    } finally { off(); }
  });

  it("says when nothing matches, and the mouse picks an option", async () => {
    render(<IntentLine />);
    open(); await userEvent.type(input(), "qzxv");
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    await userEvent.clear(input());
    await userEvent.type(input(), "undo");
    const undo = vi.spyOn(session, "undo");
    await userEvent.click(screen.getByRole("option", { name: /Undo/ }));
    expect(undo).toHaveBeenCalled();
    undo.mockRestore();
  });

  it("works with an empty document", async () => {
    useStore.setState({ session: realSession(), rev: useStore.getState().rev + 1 });
    render(<IntentLine />);
    open(); await userEvent.type(input(), "wall 5");
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it("<IntentButton/> shows the platform's ⌘K / Ctrl+K and opens the palette", async () => {
    render(<><IntentButton /><IntentLine /></>);
    expect(screen.getByRole("button", { name: "Open the intent line" }).textContent).toBe(prettyKey("mod+k"));
    await userEvent.click(screen.getByRole("button", { name: "Open the intent line" }));
    expect(screen.getByRole("dialog", { name: "Intent line" })).toBeTruthy();
  });
});
