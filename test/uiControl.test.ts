import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useUi } from "../src/model/concepts/uiState";
import { hotkeys } from "../src/model/hotkeys";
import { listPanels, registerPanel, runActionTool, setPanel } from "../src/model/uiControl";
import { buildTools, type WebMcpHost } from "../src/model/webmcp";
import { createDefaultRegistry } from "../src/core/command/builtins";

// set_panel / run_action: an agent shows and hides panels, and runs any hotkey action by id.

const text = (r: { content: unknown }) => JSON.parse((r.content as { type: string; text: string }[]).find((c) => c.type === "text")!.text);
const reset = () => useUi.setState({ panels: { ...useUi.getState().panels, workbench: true, ledger: false, space: false, lens: false, intent: true }, rightTab: "inspector" });

describe("set_panel", () => {
  beforeEach(reset);

  it("lists the concept panels from useUi (whatever it holds) plus registered app panels", () => {
    let open = false;
    const off = registerPanel("agent", { get: () => open, set: (on) => { open = on; } });
    const panels = listPanels();
    for (const p of Object.keys(useUi.getState().panels)) expect(panels).toHaveProperty(p);
    expect(panels.agent).toBe(false);
    expect(setPanel({ panel: "agent", on: true })).toMatchObject({ ok: true, panel: "agent", on: true });
    expect(open).toBe(true);
    expect(setPanel({ panel: "agent" })).toMatchObject({ ok: true, on: false }); // toggles
    off();
    expect(listPanels()).not.toHaveProperty("agent");
  });

  it("switches a concept panel through useUi (the Ledger tab follows)", () => {
    expect(setPanel({ panel: "ledger", on: true })).toMatchObject({ ok: true, on: true });
    expect(useUi.getState().panels.ledger).toBe(true);
    expect(useUi.getState().rightTab).toBe("ledger");
    expect(setPanel({ panel: "lens" })).toMatchObject({ on: true });
    expect(setPanel({ panel: "lens", on: false }).panels.lens).toBe(false);
  });

  it("names the panels on an unknown one", () => {
    const r = setPanel({ panel: "nope", on: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/workbench.*ledger/);
  });
});

describe("run_action", () => {
  let ran: string[] = [];
  let allow = true;
  let off: () => void = () => {};
  beforeEach(() => {
    ran = []; allow = true;
    off = hotkeys.registerAll([
      { id: "test.go", label: "Go", context: "global", run: () => { ran.push("go"); } },
      { id: "test.maybe", label: "Maybe", context: "global", when: () => allow, run: () => { ran.push("maybe"); } },
      { id: "test.sketchy", label: "Sketchy", context: "sketch", run: () => { ran.push("sketchy"); } },
    ]);
    hotkeys.setContexts(["global", "model"]);
  });
  afterEach(() => off());

  it("runs an action that can run, by id", () => {
    expect(runActionTool({ action: "test.go" })).toEqual({ ok: true, action: "test.go", label: "Go", ran: true });
    expect(ran).toEqual(["go"]);
  });

  it("says why an action can't run, and lists ids for an unknown one", () => {
    allow = false;
    expect(runActionTool({ action: "test.maybe" })).toMatchObject({ ok: false, ran: false });
    expect(runActionTool({ action: "test.sketchy" })).toMatchObject({ ok: false, error: expect.stringMatching(/sketch/) });
    expect(ran).toEqual([]);
    const r = runActionTool({ action: "test" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/get_hotkeys/);
    expect(r.actions).toEqual(expect.arrayContaining(["test.go", "test.maybe"]));
  });

  it("is a tool on the in-app MCP surface, as is set_panel", async () => {
    reset();
    const tools = buildTools({ registry: createDefaultRegistry(), runCommand: async () => ({ ok: true }), describe: () => ({}), render: async () => { throw new Error("no"); } } as WebMcpHost);
    const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute(args);
    expect(tools.find((t) => t.name === "run_action")!.description).toMatch(/get_hotkeys/);
    const ok = await call("run_action", { action: "test.go" });
    expect(ok.isError).toBeFalsy();
    expect(ran).toEqual(["go"]);
    expect((await call("run_action", { action: "nope.nothing" })).isError).toBe(true);
    expect(text(await call("set_panel", { panel: "space", on: true }))).toMatchObject({ ok: true, on: true });
    expect(useUi.getState().panels.space).toBe(true);
    expect((await call("set_panel", { panel: "nope" })).isError).toBe(true);
  });
});
