// The Folds panel (src/ui/FoldsPanel.tsx): a paper's steps and folds, edited with feature.sheet.edit.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, screen, within } from "@testing-library/react";
import { realSession } from "../../helpers";
import type { CadSession } from "../../../src/core/command/session";
import type { SheetFeature } from "../../../src/core/document";
import { useStore } from "../../../src/model/store";
import { useUi } from "../../../src/model/concepts/uiState";
import { FoldsPanel } from "../../../src/ui/FoldsPanel";

let s: CadSession;
let ids: { sk: string; v: string; h: string; d: string; sheet: string };
const sheet = () => s.doc.features[ids.sheet] as SheetFeature;

async function setup() {
  s = realSession();
  const ok = async (type: string, params: Record<string, unknown>) => {
    const r = await s.dispatch(type, params);
    if (!r.ok) throw new Error(`${type}: ${r.error}`);
    return r.createdIds;
  };
  await ok("parameter.add", { name: "fold", expression: "1", min: 0, max: 1, step: 0.01 });
  const [sk] = await ok("sketch.create", { plane: "XY", name: "Paper" });
  await ok("sketch.addRectangle", { sketch: sk, corner: { x: -75, y: -75 }, opposite: { x: 75, y: 75 } });
  const line = async (a: [number, number], b: [number, number]) => (await ok("sketch.addLine", { sketch: sk, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, construction: true }))[0];
  const v = await line([0, -75], [0, 75]), h = await line([-75, 0], [0, 0]), d = await line([-75, -75], [75, 75]);
  const [id] = await ok("feature.sheet", { sketch: sk, name: "Paper", thickness: 0.1, radius: 0, folds: [{ line: v, angle: 180, step: 1 }], progress: "fold" });
  ids = { sk, v, h, d, sheet: id };
}

const dispatch = vi.fn(async (type: string, params: Record<string, unknown>) => {
  const r = await s.dispatch(type, params);
  useStore.setState((x) => ({ rev: x.rev + 1 }));
  return r;
});

beforeEach(async () => {
  await setup();
  dispatch.mockClear();
  useUi.setState({ openFeature: null });
  useStore.setState({
    session: s, rev: 1, solids: {}, mode: "sketch", activeSketchId: ids.sk, selection: [],
    dispatch, rebuildSolids: vi.fn(() => Promise.resolve()),
    editOperation: vi.fn(async (opId: string, params: Record<string, unknown>) => { await s.editOperation(opId, params); useStore.setState((x) => ({ rev: x.rev + 1 })); }),
  } as never);
});

describe("Folds panel", () => {
  it("shows the steps, the fold and the hint when no line is selected", () => {
    render(<FoldsPanel />);
    expect(screen.getByText("Step 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: ids.v })).toBeTruthy();
    expect(screen.getAllByText(/select a construction line of the sheet's sketch/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Folding: step 1 of 1/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "+ New step" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds the selected line as a new step (one dispatch), and keeps the fold slider at the end", async () => {
    useStore.setState({ selection: [ids.h] });
    render(<FoldsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "+ New step" }));
    await waitFor(() => expect(sheet().folds).toHaveLength(2));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toBe("feature.sheet.edit");
    expect(sheet().folds![1]).toMatchObject({ line: ids.h, step: 2, angleExpr: "180" });
    await waitFor(() => expect(s.doc.parameters.find((p) => p.name === "fold")).toMatchObject({ max: 2, expr: "2" }));
    expect(s.undoLabel()).toBe("Add a step");
    expect(useStore.getState().selection).toEqual([]);
  });

  it("marks the selected line as a cut, and shows an error by the step it names", async () => {
    useStore.setState({ selection: [ids.d] });
    const { rerender } = render(<FoldsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Mark as cut/ }));
    await waitFor(() => expect(sheet().cuts).toEqual([ids.d]));
    useStore.setState({ solids: { [ids.sheet]: { featureId: ids.sheet, name: "Paper", error: `step 1 (fold "${ids.v}"): the layer at (1, 2) would pass through the paper at crease "${ids.v}"` } } as never });
    rerender(<FoldsPanel />);
    const step = screen.getByText("Step 1").closest(".folds-step") as HTMLElement;
    expect(within(step).getByRole("alert").textContent).toMatch(/would pass through/);
  });

  it("turns a fold into a mountain and removes it", async () => {
    render(<FoldsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "V" }));
    await waitFor(() => expect(sheet().folds![0]).toMatchObject({ angleExpr: "-180", direction: "mountain" }));
    fireEvent.click(screen.getByRole("button", { name: `Remove fold ${ids.v}` }));
    await waitFor(() => expect(sheet().folds).toBeUndefined());
  });
});
