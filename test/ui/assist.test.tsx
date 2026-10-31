import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useStore } from "../../src/model/store";
import { ASSIST_LS, startAssist, useAssist } from "../../src/model/assistController";
import { setAgentClientFactory } from "../../src/model/agent";
import { assistReplyMessage, getAssistHost, isAssistRequest } from "../../src/model/assist";
import { realSession } from "../helpers";
import { AssistChip } from "../../src/ui/AssistInbox";
import { SettingsPanel } from "../../src/ui/SettingsPanel";

// The Settings toggle and the status-bar inbox, over the real store.

let stop: () => void = () => {};
beforeEach(() => {
  try { localStorage.removeItem(ASSIST_LS); } catch { /* ignore */ }
  useAssist.setState({ enabled: true, busy: false });
  useStore.setState({ session: realSession(), rev: 1, mode: "model", activeSketchId: null, apiKey: "", solids: {} } as never);
  stop = startAssist();
});
afterEach(() => { stop(); setAgentClientFactory(null); });

/** A finished sketch with a rectangle (model mode, so it counts as finished). */
async function sketch(name?: string) {
  const r = await useStore.getState().dispatch("sketch.create", { plane: "XY", ...(name ? { name } : {}) });
  await useStore.getState().dispatch("sketch.addRectangle", { sketch: r.createdIds[0], corner: { x: 0, y: 0 }, opposite: { x: 30, y: 10 } });
  return r.createdIds[0];
}

describe("Settings: Organizational assist", () => {
  it("is on by default, explains itself, and persists when switched off", async () => {
    useStore.setState({ settingsOpen: true });
    render(<SettingsPanel />);
    const box = screen.getByRole("checkbox", { name: "Organizational assist" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText(/sends\s+their context/)).toBeTruthy();
    await userEvent.click(box);
    expect(useAssist.getState().enabled).toBe(false);
    expect(localStorage.getItem(ASSIST_LS)).toBe("0");
    await userEvent.click(box);
    expect(localStorage.getItem(ASSIST_LS)).toBe("1");
  });

  it("switched off, nothing is queued and the status bar shows nothing", async () => {
    useAssist.getState().setEnabled(false);
    await sketch();
    const { container } = render(<AssistChip />);
    expect(container.textContent).toBe("");
    expect(getAssistHost()!.view()).toMatchObject({ enabled: false, pending: 0 });
  });
});

describe("the status-bar inbox", () => {
  it("counts what waits for a name; accept a suggestion, type another, or dismiss", async () => {
    const a = await sketch();
    const b = await sketch();
    await sketch("Named already");
    render(<AssistChip />);
    const chip = await screen.findByRole("button", { name: "Organizational assist" });
    expect(chip.textContent).toMatch(/2 to name/);
    await userEvent.click(chip);
    const card = screen.getByRole("dialog", { name: "Organizational assist inbox" });
    const waiting = within(card).getByRole("list", { name: "Waiting for a name" });
    const nameA = useStore.getState().session.doc.sketches[a].name;
    const input = within(waiting).getByRole("textbox", { name: `New name for ${nameA}` }) as HTMLInputElement;
    expect(input.value).toBe("Rectangle sketch"); // the offline suggestion
    await userEvent.clear(input);
    await userEvent.type(input, "Front panel");
    await userEvent.click(within(waiting).getByRole("button", { name: `Accept name for ${nameA}` }));
    await waitFor(() => expect(useStore.getState().session.doc.sketches[a].name).toBe("Front panel"));
    // undoable like any edit
    expect(useStore.getState().session.canUndo()).toBe(true);
    const nameB = useStore.getState().session.doc.sketches[b].name;
    await userEvent.click(within(card).getByRole("button", { name: `Dismiss ${nameB}` }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Organizational assist" }).textContent).toMatch(/Named/));
    expect(useStore.getState().session.doc.sketches[b].name).toBe(nameB);
    const recent = within(screen.getByRole("dialog", { name: "Organizational assist inbox" })).getByRole("list", { name: "Recently named" });
    expect(recent.textContent).toMatch(/Front panel/);
    expect(recent.textContent).toMatch(/you/);
  });

  it("with an agent, names through the agent client hook", async () => {
    const seen: string[] = [];
    setAgentClientFactory(() => ({ messages: { create: async (body) => { seen.push(isAssistRequest(body) ? "naming" : "turn"); return assistReplyMessage(body, {}); } } }));
    useStore.setState({ apiKey: "test-key" });
    const a = await sketch();
    render(<AssistChip />);
    await userEvent.click(await screen.findByRole("button", { name: "Organizational assist" }));
    await userEvent.click(screen.getByRole("button", { name: "Name with Claude" }));
    await waitFor(() => expect(useStore.getState().session.doc.sketches[a].name).toBe("Rectangle sketch"));
    expect(seen).toEqual(["naming"]);
    expect(useAssist.getState().items.find((i) => i.target === a)).toMatchObject({ status: "done", by: "agent" });
  });
});
