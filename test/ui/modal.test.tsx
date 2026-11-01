// The shared Modal and the dialogs built on it (Settings, Keyboard shortcuts,
// the shop drawing): marked as modal dialogs named by their heading, focus
// moves in, Tab stays inside, focus goes back on close, Escape closes only the
// topmost one (and the app's Escape doesn't also run). Plus Escape on the assist
// card, Settings opening at the API key from the Agent drawer, and `?`.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Modal, modalOpen } from "../../src/ui/kit/Modal";
import { useStore } from "../../src/model/store";
import { SettingsPanel } from "../../src/ui/SettingsPanel";
import { HotkeyPanel } from "../../src/ui/HotkeyPanel";
import { AgentPanel } from "../../src/ui/AgentPanel";
import { installHotkeys } from "../../src/model/hotkeyActions";
import { hotkeys } from "../../src/model/hotkeys";

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}; // jsdom has no layout

afterEach(() => act(() => useStore.setState({ settingsOpen: false, hotkeysOpen: false, agentOpen: false, drawing: null })));

/** A page with a button that opens a Modal, so focus has somewhere to come back to. */
function Harness(p: { escape?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <button>Behind</button>
      {open && (
        <Modal title="Things" onClose={() => setOpen(false)} closeOnEscape={p.escape}>
          <div className="modal-body"><input aria-label="First" /><input aria-label="Second" /></div>
          <div className="modal-foot"><button>Done</button></div>
        </Modal>
      )}
    </>
  );
}

describe("the shared Modal", () => {
  it("is a modal dialog named by its heading, takes focus, traps Tab and gives focus back", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Things" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "Things" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "First" })));
    // Tab walks the dialog only: First → Second → Done → Close → back to First
    await userEvent.tab(); expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Second" }));
    await userEvent.tab(); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
    await userEvent.tab(); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    await userEvent.tab(); expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "First" }));
    await userEvent.tab({ shift: true }); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    // Escape closes it, and the opener has focus again
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(modalOpen()).toBe(false);
  });

  it("keeps the app's own Escape from running, and leaves Escape alone when told to", async () => {
    let seen = 0;
    const late = () => { seen++; };
    window.addEventListener("keydown", late);
    const { unmount } = render(<Harness escape={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy(); // closeOnEscape={false}: the dialog uses Escape itself
    expect(seen).toBe(1);
    unmount();
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(seen).toBe(1); // swallowed
    window.removeEventListener("keydown", late);
  });

  it("closes on a press outside, not inside", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.pointerDown(screen.getByRole("textbox", { name: "First" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(document.querySelector(".modal-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Settings and Keyboard shortcuts", () => {
  it("Settings is a modal dialog that closes on Escape", async () => {
    render(<SettingsPanel />);
    act(() => useStore.getState().setSettingsOpen(true));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector(".modal-body")).toBeTruthy(); // the scrolling body (capped by .modal's max-height)
    expect(screen.getByLabelText("Claude API key")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("the Agent drawer's \"connect your key\" opens Settings at the API key, focused", async () => {
    act(() => useStore.setState({ apiKey: "", agentOpen: true }));
    render(<><AgentPanel /><SettingsPanel /></>);
    await userEvent.click(screen.getByText("Settings", { selector: "button.linklike" }));
    expect(useStore.getState().settingsFocus).toBe("apiKey");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Claude API key")));
  });

  it("a key typed into Settings is kept when Escape closes it", async () => {
    act(() => useStore.setState({ apiKey: "" }));
    render(<SettingsPanel />);
    act(() => useStore.getState().setSettingsOpen(true, "apiKey"));
    await userEvent.type(screen.getByLabelText("Claude API key"), "sk-ant-test");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().apiKey).toBe("sk-ant-test");
    act(() => useStore.setState({ apiKey: "" }));
  });

  it("Shortcuts closes on Escape, except while a key is being captured", async () => {
    const off = hotkeys.register({ id: "test.thing", label: "A thing", context: "global", run: () => {} });
    render(<HotkeyPanel />);
    act(() => useStore.getState().setHotkeysOpen(true));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" }).classList.contains("hk-modal")).toBe(true);
    await userEvent.click(screen.getAllByTitle("Click to rebind")[0]);
    expect(screen.getByText("press…")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("press…")).toBeNull(); // the capture was cancelled…
    expect(useStore.getState().hotkeysOpen).toBe(true); // …and the dialog stays
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().hotkeysOpen).toBe(false);
    off();
  });

  it("Escape closes only the topmost of two stacked dialogs", () => {
    render(<><SettingsPanel /><HotkeyPanel /></>);
    act(() => useStore.getState().setSettingsOpen(true));
    act(() => useStore.getState().setHotkeysOpen(true));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().hotkeysOpen).toBe(false);
    expect(useStore.getState().settingsOpen).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("? opens the shortcuts", () => {
    const off = installHotkeys();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(useStore.getState().hotkeysOpen).toBe(true);
    off();
  });
});

describe("the assist card", () => {
  it("closes on Escape", async () => {
    vi.resetModules();
    const { useAssist } = await import("../../src/model/assistController");
    const { AssistChip } = await import("../../src/ui/AssistInbox");
    act(() => useAssist.setState({ enabled: true, items: [{ id: "a1", target: "sk1", targetKind: "sketch", from: "Sketch 1", status: "pending", at: 0 } as never] }));
    render(<AssistChip />);
    await userEvent.click(screen.getByRole("button", { name: "Organizational assist" }));
    expect(screen.getByRole("dialog", { name: "Organizational assist inbox" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Organizational assist inbox" })).toBeNull();
  });
});
