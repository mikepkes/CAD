import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, act, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { realSession } from "../helpers";
import { useStore } from "../../src/model/store";
import { useUi } from "../../src/model/concepts/uiState";
import { featureRows } from "../../src/model/concepts/featureCatalog";
import { resolveParameters } from "../../src/core/parameters";
import type { CadDocument } from "../../src/core/document";
import type { GeometryBackend } from "../../src/core/geometry/backend";
import { disposeSamplerBackend } from "../../src/ui/concepts/space/sampler";
import { LedgerPanel, clearFixCache, useIntents, useSuggestions } from "../../src/ui/concepts/ledger";
import type { CadSession } from "../../src/core/command/session";

/** A session with a parameter, a sketch, an extrude driven by it and a fillet. */
async function bracket(): Promise<{ s: CadSession; extrudeId: string; filletOp: string }> {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "h", expression: "12" });
  const sk = await s.dispatch("sketch.create", { plane: "XY" });
  const sid = sk.createdIds[0];
  await s.dispatch("sketch.addRectangle", { sketch: sid, corner: { x: 0, y: 0 }, opposite: { x: 40, y: 20 } });
  const ex = await s.dispatch("feature.extrude", { sketch: sid, distance: "h*2" });
  const fi = await s.dispatch("feature.fillet", { radius: "1.5" });
  return { s, extrudeId: ex.createdIds[0], filletOp: fi.opId };
}

function mount(s: CadSession, solids: Record<string, unknown> = {}) {
  const editOperation = vi.fn(async () => {});
  const setParameterExpr = vi.fn(async () => {});
  useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: solids as never, editOperation, setParameterExpr });
  const r = render(<LedgerPanel />);
  return { ...r, editOperation, setParameterExpr };
}

describe("LedgerPanel", () => {
  let b: Awaited<ReturnType<typeof bracket>>;
  beforeAll(async () => { b = await bracket(); });
  beforeEach(() => {
    localStorage.clear();
    useIntents.setState({ docId: null, intents: [], results: [], scope: {} });
    useSuggestions.setState({ dismissed: {}, accepted: {} });
    useUi.setState({ hotFeature: null, hotParam: null });
  });

  it("shows an empty state when nothing is built", () => {
    mount(realSession());
    expect(screen.getByRole("region", { name: "Ledger" })).toBeTruthy();
    expect(screen.getByText(/Nothing built yet/)).toBeTruthy();
  });

  it("reads each feature as a numbered sentence with live numbers and an estimated mass", () => {
    const solids = { [b.extrudeId]: { featureId: b.extrudeId, name: "x", sketchId: "", distance: 24, mesh: {}, volume: 19200 } };
    mount(b.s, solids);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Root Component");
    const prose = screen.getByRole("region", { name: "Features" });
    const paras = prose.querySelectorAll("p.ledger-row");
    expect(paras.length).toBe(2);
    expect(paras[0].textContent).toMatch(/^1Extrude .+ by 24\.0 mm\.\+51\.8 g$/);
    expect(paras[1].textContent).toBe("2Round the edges to 1.5 mm.");
    expect(paras[0].querySelector(".ledger-mass")?.getAttribute("title")).toMatch(/est\./);
    expect(screen.getByRole("button", { name: /distance, 24\.0 mm/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /radius, 1\.5 mm/ })).toBeTruthy();
  });

  it("edits a parameter through store.editOperation with the whole param set", async () => {
    const { editOperation } = mount(b.s);
    const rows = featureRows(b.s.doc, b.s.timeline, b.s.rollbackIndex, {});
    const live = screen.getByRole("button", { name: /distance, 24\.0 mm/ });
    live.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(editOperation).toHaveBeenCalledTimes(1);
    expect(editOperation).toHaveBeenCalledWith(rows[0].opId, { ...rows[0].op.params, distance: "24.5" });
  });

  it("keeps one edit in flight while scrubbing, then sends the latest and the commit", async () => {
    let release!: () => void;
    const editOperation = vi.fn(() => new Promise<void>((r) => { release = r; }));
    useStore.setState({ session: b.s, rev: useStore.getState().rev + 1, solids: {}, editOperation });
    render(<LedgerPanel />);
    const live = screen.getByRole("button", { name: /distance, 24\.0 mm/ });
    fireEvent.pointerDown(live, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(live, { clientX: 105 });
    fireEvent.pointerMove(live, { clientX: 110 });
    fireEvent.pointerMove(live, { clientX: 115 });
    expect(editOperation).toHaveBeenCalledTimes(1);
    expect((editOperation.mock.calls[0] as unknown[])[1]).toMatchObject({ distance: "24.5" });
    fireEvent.pointerUp(live);
    expect(editOperation).toHaveBeenCalledTimes(1);
    release();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(editOperation).toHaveBeenCalledTimes(2);
    expect((editOperation.mock.calls[1] as unknown[])[1]).toMatchObject({ distance: "25.5" });
  });

  it("commits the value released at, not an earlier live one, when a scrub returns to where it started", async () => {
    let release!: () => void;
    const editOperation = vi.fn(() => new Promise<void>((r) => { release = r; }));
    useStore.setState({ session: b.s, rev: useStore.getState().rev + 1, solids: {}, editOperation });
    render(<LedgerPanel />);
    const live = screen.getByRole("button", { name: /distance, 24\.0 mm/ });
    fireEvent.pointerDown(live, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(live, { clientX: 105 }); // 24.5 in flight
    fireEvent.pointerMove(live, { clientX: 100 }); // back to 24.0: equals the prop, so no live edit, but it is where the user releases
    fireEvent.pointerUp(live);
    release();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(editOperation).toHaveBeenCalledTimes(2);
    expect((editOperation.mock.calls[1] as unknown[])[1]).toMatchObject({ distance: "24" });
  });

  it("makes a hovered sentence the hot feature, lights the hot one, and reports the hot parameter", () => {
    mount(b.s);
    const paras = screen.getByRole("region", { name: "Features" }).querySelectorAll("p.ledger-row");
    fireEvent.mouseEnter(paras[1]);
    expect(useUi.getState().hotFeature).toBe(paras[1].getAttribute("data-feature"));
    expect(paras[1].className).toContain("hot");
    fireEvent.mouseLeave(paras[1]);
    expect(useUi.getState().hotFeature).toBeNull();
    act(() => useUi.getState().setHotFeature(b.extrudeId));
    expect(paras[0].className).toContain("hot");
    expect(paras[1].className).not.toContain("hot");
    const live = screen.getByRole("button", { name: /distance, 24\.0 mm/ });
    fireEvent.mouseEnter(live);
    expect(useUi.getState().hotParam).toEqual({ featureId: b.extrudeId, key: "distance" });
    expect(live.className).toContain("hot");
    fireEvent.mouseLeave(live);
    expect(useUi.getState().hotParam).toBeNull();
  });

  it("dims a rolled-back feature and strikes a suppressed one", async () => {
    const { s } = await bracket();
    await s.moveRollback(s.timeline.length - 1);
    mount(s);
    let paras = screen.getByRole("region", { name: "Features" }).querySelectorAll("p.ledger-row");
    expect(paras[1].className).toContain("ghost");
    expect(paras[0].className).not.toContain("ghost");
    await s.moveRollback(s.timeline.length);
    const filletOp = s.timeline.find((o) => o.type === "feature.fillet")!.opId;
    await s.setSuppressed(filletOp, true);
    act(() => useStore.setState({ rev: useStore.getState().rev + 1 }));
    paras = screen.getByRole("region", { name: "Features" }).querySelectorAll("p.ledger-row");
    expect(paras[1].className).toContain("off");
    expect(paras[1].className).not.toContain("ghost");
  });

  it("checks intents, scrubs a numeric limit, and removes one — each through intent.* operations on the document", async () => {
    const { s } = await bracket(); // its own session: intents are document state now
    mount(s);
    const section = screen.getByRole("region", { name: "Design intents" });
    expect(within(section).getByText(/No intents yet/)).toBeTruthy();
    await userEvent.type(within(section).getByRole("textbox", { name: "Intent" }), "h >= 15");
    await userEvent.type(within(section).getByRole("textbox", { name: "Label" }), "Height");
    await userEvent.click(within(section).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(section).getByRole("img", { name: "fails" })).toBeTruthy());
    expect(within(section).getByText("now 12")).toBeTruthy();
    expect(within(section).getByText("Height:")).toBeTruthy();
    expect(s.doc.intents).toMatchObject([{ label: "Height", lhs: "h", op: ">=", rhs: "15" }]);
    expect(s.doc.operations.at(-1)?.type).toBe("intent.add");
    expect(localStorage.getItem("chisel.intents.v1.doc1")).toBeNull();
    const limit = within(section).getByRole("button", { name: /Height limit, 15/ });
    limit.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(useIntents.getState().intents[0].rhs).toBe("12");
    expect(within(section).getByRole("img", { name: "passes" })).toBeTruthy();
    await waitFor(() => expect(s.doc.intents[0].rhs).toBe("12"));
    expect(s.doc.operations.filter((o) => o.type === "intent.update").length).toBe(3);
    await userEvent.type(within(section).getByRole("textbox", { name: "Intent" }), "h*2 <= width{Enter}");
    await waitFor(() => expect(within(section).getAllByRole("listitem").length).toBe(2));
    await userEvent.click(within(section).getByRole("button", { name: "Remove h*2" }));
    await waitFor(() => expect(s.doc.intents.length).toBe(1));
    expect(useIntents.getState().intents.length).toBe(1);
    expect(s.doc.operations.at(-1)?.type).toBe("intent.delete");
  });

  it("rejects text that is not a comparison", async () => {
    mount(b.s);
    const section = screen.getByRole("region", { name: "Design intents" });
    await userEvent.type(within(section).getByRole("textbox", { name: "Intent" }), "keep it light{Enter}");
    expect(within(section).getByRole("alert").textContent).toMatch(/comparison/);
    expect(useIntents.getState().intents.length).toBe(0);
    expect(b.s.doc.intents.length).toBe(0);
  });

  it("suggests the smallest parameter change that fixes a failing intent; Accept, Undo and Not now", async () => {
    const { s } = await bracket();
    const { setParameterExpr } = mount(s);
    await act(async () => { await useIntents.getState().add("h >= 15", "Height"); });
    const sugg = screen.getByRole("group", { name: "Suggestion for Height" });
    expect(sugg.textContent).toContain("Set h to 15 (+3)");
    expect(sugg.textContent).not.toContain("re-evaluate");
    await userEvent.click(within(sugg).getByRole("button", { name: "Accept" }));
    expect(setParameterExpr).toHaveBeenCalledWith("h", "15");
    expect(screen.queryByRole("group", { name: "Suggestion for Height" })).toBeNull();
    const done = screen.getByRole("group", { name: "Accepted suggestion for Height" });
    await userEvent.click(within(done).getByRole("button", { name: "Undo" }));
    expect(setParameterExpr).toHaveBeenLastCalledWith("h", "12");
    // the document did not actually change (the store is mocked), so the same suggestion returns
    const again = screen.getByRole("group", { name: "Suggestion for Height" });
    await userEvent.click(within(again).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("group", { name: "Suggestion for Height" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Suggestions" })).toBeNull();
  });

  it("marks a metric-based suggestion as needing a rebuild", async () => {
    const { s, extrudeId } = await bracket();
    const solids = { [extrudeId]: { featureId: extrudeId, name: "x", sketchId: "", distance: 24, mesh: {}, volume: 19200 } };
    mount(s, solids);
    await act(async () => { await useIntents.getState().add("mass / h <= 4", "Mass per height"); });
    const sugg = screen.getByRole("group", { name: "Suggestion for Mass per height" });
    expect(sugg.textContent).toContain("re-evaluate to confirm");
    expect(sugg.textContent).toMatch(/Set h to 1[3-8]/);
  });
});

// ---- the sampled search for metric intents ----

/** Two bounded parameters and a free one; nothing sketched (the live solids are mocked). */
async function boxSession(): Promise<CadSession> {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "w", expression: "30", min: 10, max: 50, step: 5 });
  await s.dispatch("parameter.add", { name: "h", expression: "15", min: 5, max: 25 });
  await s.dispatch("parameter.add", { name: "free", expression: "2" });
  return s;
}

/** The live model: one 30 × 15 × 10 box, 4,500 mm³, 12.15 g at aluminium's density. */
const boxSolids = { b: { featureId: "b", name: "b", sketchId: "", distance: 0, mesh: {}, volume: 4500, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 15, z: 10 } } } };

/** The sampling backend: a w × h × 10 box, so every variant's mass is w·h·0.027 g. `gate` holds each build until it resolves. */
function boxBackend(gate?: () => Promise<void>) {
  const evaluate = vi.fn(async (doc: CadDocument) => {
    await gate?.();
    const { scope } = resolveParameters(doc.parameters);
    return { solids: { b: { ...boxSolids.b, volume: scope.w * scope.h * 10, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: scope.w, y: scope.h, z: 10 } } } }, facePlanes: {} };
  });
  const backend = {
    init: async () => {}, ready: () => true, dispose: () => {}, evaluate,
    edges: async () => [], exportBytes: async () => null, collide: async () => ({ overlaps: [], maxOverlap: 0 }), topology: async () => [], distance: async () => 0, analyze: async () => [],
  } as unknown as GeometryBackend;
  return { backend, evaluate };
}

function mountBox(s: CadSession, backend: GeometryBackend) {
  const setParameterExpr = vi.fn(async () => {});
  useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: boxSolids as never, setParameterExpr });
  const createBackend = vi.fn(async () => backend);
  const r = render(<LedgerPanel createBackend={createBackend} />);
  return { ...r, setParameterExpr, createBackend };
}

describe("LedgerPanel: built fixes for metric intents", () => {
  let s: CadSession;
  beforeEach(async () => {
    s = await boxSession(); // fresh each time: intents are document operations now, so they would carry over
    localStorage.clear();
    clearFixCache();
    disposeSamplerBackend();
    useIntents.setState({ docId: null, intents: [], results: [], scope: {} });
    useSuggestions.setState({ dismissed: {}, accepted: {} });
  });

  it("looks for a fix off the render path: pending, then the smallest built change with its sampled metric; Accept applies it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { backend, evaluate } = boxBackend(() => gate);
    const { setParameterExpr, createBackend } = mountBox(s, backend);
    expect(screen.queryByRole("region", { name: "Suggestions" })).toBeNull();
    act(() => { useIntents.getState().add("mass <= 10", "Mass"); });
    // pending: the kernel is building, nothing is proposed yet
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Looking for a fix…");
    expect(status.getAttribute("data-status")).toBe("searching");
    expect(createBackend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: /Suggestion for/ })).toBeNull();
    // ready: h moves least relative to its range (15 → 11.67 of 5…25), then w (30 → 20 of 10…50)
    await act(async () => { release(); });
    const cards = await screen.findAllByRole("group", { name: "Suggestion for Mass" });
    expect(cards.map((c) => c.textContent)).toEqual([expect.stringContaining("Set h to 11.7 (mass 9.45 g)"), expect.stringContaining("Set w to 20 (mass 8.10 g)")]);
    expect(cards[0].textContent).toContain("built");
    expect(cards[0].textContent).not.toContain("re-evaluate");
    expect(screen.queryByRole("status")).toBeNull();
    expect(evaluate).toHaveBeenCalledTimes(8);
    expect(s.doc.parameters.map((p) => p.expr)).toEqual(["30", "15", "2"]); // the live document was never touched
    await userEvent.click(within(cards[0]).getByRole("button", { name: "Accept" }));
    expect(setParameterExpr).toHaveBeenCalledWith("h", "11.6667");
    const done = screen.getByRole("group", { name: "Accepted suggestion for Mass" });
    expect(done.textContent).toContain("Set h to 11.7 (mass 9.45 g)");
    await userEvent.click(within(done).getByRole("button", { name: "Undo" }));
    expect(setParameterExpr).toHaveBeenLastCalledWith("h", "15");
  });

  it("starts no sampler while no metric intent fails, and says so when nothing within the bounds fixes one", async () => {
    const { backend, evaluate } = boxBackend();
    const { createBackend } = mountBox(s, backend);
    await act(async () => { await useIntents.getState().add("h >= 20", "Tall"); }); // a parameter intent: the instant fix, no build
    expect((await screen.findByRole("group", { name: "Suggestion for Tall" })).textContent).toMatch(/Set h to 20/);
    expect(createBackend).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => { await useIntents.getState().add("mass <= 1", "Mass"); }); // the smallest box, 10 × 5 × 10, is still 1.35 g
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/No change to a bounded parameter fixes this/));
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("done");
    expect(evaluate).toHaveBeenCalledTimes(4); // each side's bound only: w 50, w 10, h 25, h 5
    expect(screen.getByRole("group", { name: "Suggestion for Tall" })).toBeTruthy(); // the instant one stays
    expect(screen.queryByRole("group", { name: "Suggestion for Mass" })).toBeNull();
  });

  it("drops a search when the document changes and starts over on the new revision", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let gated = true;
    const { backend, evaluate } = boxBackend(() => (gated ? gate : Promise.resolve()));
    mountBox(s, backend);
    await act(async () => { await useIntents.getState().add("mass <= 10", "Mass"); });
    await screen.findByRole("status");
    await waitFor(() => expect(useStore.getState().session.doc.intents.length).toBe(1)); // the intent.add op has landed
    const probes = evaluate.mock.calls.length; // the first probe of each revision so far, each held by the gate
    expect(probes).toBeGreaterThanOrEqual(1);
    gated = false;
    act(() => { useStore.setState({ rev: useStore.getState().rev + 1 }); }); // the document changed
    expect(screen.getByRole("status").textContent).toBe("Looking for a fix…");
    const cards = await screen.findAllByRole("group", { name: "Suggestion for Mass" });
    expect(cards.length).toBe(2);
    expect(evaluate).toHaveBeenCalledTimes(probes + 8); // the new revision rebuilt everything: nothing of the old one is reused
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    expect(evaluate).toHaveBeenCalledTimes(probes + 8); // the old searches stopped at their probe instead of carrying on
    expect(screen.getAllByRole("group", { name: "Suggestion for Mass" }).length).toBe(2);
  });

  it("reports a sampler that could not start, and keeps the instant guess", async () => {
    useStore.setState({ session: s, rev: useStore.getState().rev + 1, solids: boxSolids as never, setParameterExpr: vi.fn(async () => {}) });
    render(<LedgerPanel createBackend={vi.fn(async () => { throw new Error("no wasm"); })} />);
    act(() => { useIntents.getState().add("mass / h <= 0.7", "Mass per height"); }); // 12.15 / 15 = 0.81: fails, and h is a parameter it reads
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Could not look for a fix: no wasm"));
    expect(screen.getByRole("group", { name: "Suggestion for Mass per height" }).textContent).toContain("re-evaluate to confirm");
  });
});
