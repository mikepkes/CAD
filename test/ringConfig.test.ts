import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HotkeyManager, hotkeys, type HotkeyAction } from "../src/model/hotkeys";
import { DEFAULT_RING, useRing } from "../src/model/ring";
import {
  applyRingSlot, contextLabel, describeRing, editorSlotPos, parseSlot, ringChoices, ringPreview, ringSlotProblem, slotViews,
} from "../src/model/ringConfig";
import { buildTools as webTools, type WebMcpHost } from "../src/model/webmcp";
import { buildTools as agentTools } from "../src/model/agent";

// The ring configuration the Hotkeys panel, the agent and MCP share: reading
// rows, validating a slot write against ringSources, and the two tools.

const act = (id: string, context: string, label = id, defaultPrimary?: string): HotkeyAction => ({ id, label, context, defaultPrimary, run: () => {} });
const ACTS = [
  act("view.top", "global", "View: Top"), act("edit.undo", "global", "Undo", "mod+z"), act("ring.open", "global", "Action ring", "space"),
  act("model.sketch", "model", "New sketch"), act("tool.line", "sketch", "Line tool", "l"),
  act("face.lookAt", "face", "Look at face"), act("lens.zebra", "lens", "Zebra"),
];

describe("ring config", () => {
  let hk: HotkeyManager;
  beforeEach(() => {
    hk = new HotkeyManager();
    hk.registerAll(ACTS);
    useRing.getState().resetAll();
  });

  it("parses slots by index or compass name", () => {
    expect(parseSlot(0)).toBe(0);
    expect(parseSlot("7")).toBe(7);
    expect(parseSlot("ne")).toBe(1);
    expect(parseSlot(" SW ")).toBe(5);
    expect(parseSlot(8)).toBeNull();
    expect(parseSlot(1.5)).toBeNull();
    expect(parseSlot("up")).toBeNull();
    expect(parseSlot(null)).toBeNull();
  });

  it("labels contexts, falling back to the raw id", () => {
    expect(contextLabel("face")).toBe("Face selected");
    expect(contextLabel("plugin")).toBe("plugin");
  });

  it("offers only actions from the ring's sources, never the ring key", () => {
    const face = ringChoices("face", hk);
    expect(face.map((g) => g.context)).toEqual(["global", "model", "face"]);
    const ids = face.flatMap((g) => g.actions.map((a) => a.id));
    expect(ids).toEqual(expect.arrayContaining(["view.top", "edit.undo", "model.sketch", "face.lookAt"]));
    expect(ids).not.toContain("tool.line");
    expect(ids).not.toContain("lens.zebra");
    expect(ids).not.toContain("ring.open");
    expect(face[0].actions.find((a) => a.id === "edit.undo")!.primary).toBe("mod+z");
  });

  it("says why an action can't go in a slot", () => {
    expect(ringSlotProblem("face", "face.lookAt", hk)).toBeNull();
    expect(ringSlotProblem("face", "tool.line", hk)).toMatch(/sketch context/);
    expect(ringSlotProblem("face", "nope", hk)).toMatch(/no hotkey action/);
    expect(ringSlotProblem("global", "ring.open", hk)).toMatch(/opens it/);
  });

  it("views a context's slots with own, default and inherited values", () => {
    useRing.getState().setSlot("face", 5, "edit.undo");
    const v = slotViews("face", useRing.getState().overrides);
    expect(v[0]).toMatchObject({ name: "N", own: "face.sketch", default: "face.sketch", overridden: false });
    expect(v[5]).toMatchObject({ name: "SW", own: "edit.undo", default: null, overridden: true });
    expect(v[7]).toMatchObject({ own: null, overridden: false, inherited: { actionId: "model.component", from: "model" } });
    expect(v[6].inherited).toMatchObject({ actionId: "edit.undo", from: "global" }); // W: model inherits too
  });

  it("lays the editor's slots out like the ring", () => {
    expect(editorSlotPos(0, 100, 50)).toEqual({ x: 0, y: -50 });
    expect(editorSlotPos(2, 100, 50)).toEqual({ x: 100, y: 0 });
    expect(editorSlotPos(6, 100, 50)).toEqual({ x: -100, y: 0 });
  });

  it("previews the ring on a stack", () => {
    hk.setContexts(["global", "sketch"]);
    const text = ringPreview(["global", "sketch"], {}, hk);
    expect(text.startsWith("N Line tool · NE tool.rectangle")).toBe(true); // unregistered ids read as themselves
    expect(text).toContain("W Undo");
  });

  it("describes every context and the ring on the active stack", () => {
    hk.setContexts(["global", "model", "face"]);
    const d = describeRing({}, hk);
    expect(d.slots).toEqual(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);
    expect(d.stack).toEqual(["global", "model", "face"]);
    expect(d.ring[4]).toEqual({ slot: "S", action: "face.lookAt", label: "Look at face", from: "face" });
    expect(d.ring[7]).toMatchObject({ action: "model.component", from: "model" });
    const face = d.contexts.find((c) => c.context === "face")!;
    expect(face).toMatchObject({ active: true, customized: false, sources: ["global", "model", "face"] });
    expect(face.own).toEqual(DEFAULT_RING.face);
    expect(face.defaults).toEqual(DEFAULT_RING.face);
    expect(d.contexts.find((c) => c.context === "sketch")!.active).toBe(false);
  });

  it("applies a slot: an id, null to inherit, \"default\" to restore", () => {
    hk.setContexts(["global", "model", "face"]);
    const r = applyRingSlot({ context: "face", slot: "SW", action: "edit.undo" }, hk);
    expect(r.ok).toBe(true);
    expect(useRing.getState().overrides.face).toEqual({ 5: "edit.undo" });
    expect(r.ring.ring[5]).toMatchObject({ action: "edit.undo", from: "face" });
    applyRingSlot({ context: "face", slot: 0, action: null }, hk);
    expect(describeRing(undefined, hk).ring[0]).toMatchObject({ action: "model.sketch", from: "model" });
    applyRingSlot({ context: "face", slot: "n", action: "default" }, hk);
    applyRingSlot({ context: "face", slot: 5, action: "default" }, hk);
    expect(useRing.getState().overrides).toEqual({});
  });

  it("rejects bad context, slot and action", () => {
    expect(() => applyRingSlot({ context: "room", slot: 0, action: null }, hk)).toThrow(/unknown context/);
    expect(() => applyRingSlot({ context: "face", slot: 9, action: null }, hk)).toThrow(/slot must be/);
    expect(() => applyRingSlot({ context: "face", slot: 0 }, hk)).toThrow(/action is required/);
    expect(() => applyRingSlot({ context: "face", slot: 0, action: "tool.line" }, hk)).toThrow(/sketch context/);
    expect(useRing.getState().overrides).toEqual({});
  });
});

describe("ring tools on the agent and MCP surfaces", () => {
  let off: () => void;
  beforeEach(() => {
    off = hotkeys.registerAll(ACTS);
    hotkeys.setContexts(["global", "sketch"]);
    useRing.getState().resetAll();
  });
  afterEach(() => { off(); hotkeys.setContexts(["global"]); useRing.getState().resetAll(); });

  const host: WebMcpHost = {
    registry: { toMcpTools: () => [] } as unknown as WebMcpHost["registry"],
    runCommand: async () => ({ ok: true }),
    describe: () => ({}),
    render: async () => { throw new Error("no viewport"); },
  };
  const text = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0].text);

  it("the agent lists get_ring and set_ring_slot", () => {
    const names = agentTools({ toMcpTools: () => [] } as never).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_hotkeys", "set_hotkey", "get_ring", "set_ring_slot"]));
  });

  it("MCP get_ring reads, set_ring_slot writes and validates", async () => {
    const tools = webTools(host);
    const get = tools.find((t) => t.name === "get_ring")!, set = tools.find((t) => t.name === "set_ring_slot")!;
    expect(get.annotations?.readOnlyHint).toBe(true);
    const before = text(await get.execute({}));
    expect(before.stack).toEqual(["global", "sketch"]);
    expect(before.ring[0]).toMatchObject({ slot: "N", action: "tool.line", label: "Line tool", from: "sketch" });

    const r = await set.execute({ context: "sketch", slot: "N", action: "view.top" });
    expect(r.isError).toBeFalsy();
    expect(text(r).ring.ring[0]).toMatchObject({ action: "view.top", from: "sketch" });

    const bad = await set.execute({ context: "sketch", slot: "N", action: "face.lookAt" });
    expect(bad.isError).toBe(true);
    expect(text(bad).error).toMatch(/face context/);
    expect(useRing.getState().overrides.sketch).toEqual({ 0: "view.top" });
  });
});
