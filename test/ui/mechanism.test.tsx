// The Mechanism tab (src/ui/concepts/mechanism) and its store's Sweep, in jsdom:
// what the chart marks, what the strain bars say, and what Sweep sends.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MechanismPanel } from "../../src/ui/concepts/mechanism";
import { PanelToggles, RightPanel, ViewChips } from "../../src/ui/ConceptShell";
import { useMechanism } from "../../src/model/concepts/mechanismStore";
import { useStore } from "../../src/model/store";
import { useUi } from "../../src/model/concepts/uiState";
import type { MechanismCurve } from "../../src/model/concepts/mechanism";
import { realSession } from "../helpers";

const travel = (value: number) => ({ id: "p1", name: "travel", expr: String(value), value, min: 0, max: 10, step: 0.1 });
const compliantDoc = (value = 0) => ({
  ...useStore.getState().session.doc,
  id: "bistable-test",
  parameters: [travel(value)],
  joints: {
    j1: { id: "j1", name: "Shuttle", kind: "planar", planar: { y: "-travel" }, valueExpr: "0" },
    j2: { id: "j2", name: "Beam lower left", kind: "beam", beam: { width: 6, thickness: 1, profile: "cosine" }, valueExpr: "0" },
    j3: { id: "j3", name: "Beam upper left", kind: "beam", beam: { width: 6, thickness: 1, profile: "cosine" }, valueExpr: "0" },
  },
});
const plainDoc = () => ({ ...useStore.getState().session.doc, parameters: [], joints: {} });
const setDoc = (doc: object) => act(() => useStore.setState({ session: { ...useStore.getState().session, doc } as never, rev: useStore.getState().rev + 1 }));

const CURVE: MechanismCurve = {
  param: "travel", angular: false, unit: "mm", effortUnit: "N", min: 0, max: 10,
  points: Array.from({ length: 21 }, (_, k) => { const x = k / 2; return { x, y: 12 * Math.sin((x / 6.8) * 2 * Math.PI) * (x < 6.8 ? 1 : 0.6) }; }),
  stable: [{ x: 0, y: 0 }, { x: 6.8, y: 0 }], unstable: [{ x: 4.9, y: 0 }], multistable: true, snap: { x: 1.5, y: 11.8 },
};
const POSE = {
  rev: 1, drive: "travel", value: 3, effort: 9.5, segments: [],
  state: { flexures: [
    { joint: "j2", name: "Beam lower left", beam: true, angle: 0, strain: 0.0166, allowable: 0.04, moment: NaN },
    { joint: "j3", name: "Beam upper left", beam: true, angle: 0, strain: 0.05, allowable: 0.04, moment: NaN },
  ], energy: 5, utilisation: 1.25, beams: [] },
};

let follow: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  follow = vi.spyOn(useMechanism.getState(), "follow").mockReturnValue(() => {});
  useMechanism.setState({ drive: null, pose: null, curves: {}, studying: false, sweeping: null, watchers: 0 });
  useUi.setState({ panels: { workbench: true, ledger: false, space: false, lens: false, intent: true, mechanism: false }, rightTab: "inspector" });
  useStore.setState({ mode: "model" });
});
afterEach(() => { follow.mockRestore(); setDoc(plainDoc()); });

describe("MechanismPanel", () => {
  it("says so when the model is not a compliant mechanism", () => {
    setDoc(plainDoc());
    render(<MechanismPanel />);
    expect(screen.getByTestId("mechanism-empty")).toBeTruthy();
  });

  it("follows the mechanism while shown and waits for the curve", () => {
    setDoc(compliantDoc());
    useMechanism.setState({ studying: true });
    render(<MechanismPanel />);
    expect(follow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("curve-pending").textContent).toBe("Sweeping the range…");
    expect(screen.getByRole("region", { name: "Mechanism" })).toBeTruthy();
  });

  it("charts force against travel with both rests, the tipping point, the snap force and where it stands", () => {
    setDoc(compliantDoc(3));
    useMechanism.setState({ curves: { travel: { key: "k", curve: CURVE } }, pose: POSE });
    render(<MechanismPanel />);
    const chart = screen.getByRole("img", { name: "Force against travel" });
    expect(within(chart).getAllByTestId("rest-marker")).toHaveLength(2);
    expect(within(chart).getAllByTestId("unstable-marker")).toHaveLength(1);
    expect(within(chart).getByTestId("snap-marker").textContent).toBe("snap 11.8 N");
    expect(within(chart).getByTestId("current-marker").getAttribute("data-x")).toBe("3");
    expect(screen.getByTestId("rest-sentence").textContent).toBe("Bistable: rests at 0 mm and 6.8 mm; tips over at 4.9 mm; snaps over at 11.8 N.");
    expect(screen.getByText("Force").nextSibling?.textContent).toBe("9.5 N");
    // the rests sit on the zero line, the tipping point between them
    const xs = [...within(chart).getAllByTestId("rest-marker"), within(chart).getByTestId("unstable-marker")].map((c) => Number(c.getAttribute("cx")));
    expect(xs[0]).toBeLessThan(xs[2]);
    expect(xs[2]).toBeLessThan(xs[1]);
  });

  it("moves the marker as the drive changes", () => {
    setDoc(compliantDoc(3));
    useMechanism.setState({ curves: { travel: { key: "k", curve: CURVE } }, pose: POSE });
    render(<MechanismPanel />);
    const x3 = Number(screen.getByTestId("current-marker").querySelector("line")!.getAttribute("x1"));
    setDoc(compliantDoc(7.5));
    expect(screen.getByTestId("current-marker").getAttribute("data-x")).toBe("7.5");
    expect(Number(screen.getByTestId("current-marker").querySelector("line")!.getAttribute("x1"))).toBeGreaterThan(x3);
    expect(screen.getByText("travel").nextSibling?.textContent).toBe("7.5 mm");
  });

  it("bars each flexure against its limit, flagging one over it", () => {
    setDoc(compliantDoc(3));
    useMechanism.setState({ pose: POSE });
    render(<MechanismPanel />);
    const list = screen.getByRole("list", { name: "Flexure strain" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(["Beam lower left: 42% of its limit", "Beam upper left: 125% of its limit"]);
    expect(items[1].className).toBe("over");
    expect(screen.getByText("of the limit (4%)")).toBeTruthy();
  });

  it("sweeps the drive from its button, and stops it", async () => {
    setDoc(compliantDoc());
    const sweep = vi.spyOn(useMechanism.getState(), "sweep").mockResolvedValue();
    const stop = vi.spyOn(useMechanism.getState(), "stopSweep").mockImplementation(() => {});
    render(<MechanismPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Sweep travel" }));
    expect(sweep).toHaveBeenCalledWith("travel");
    act(() => useMechanism.setState({ sweeping: "travel" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop sweep" }));
    expect(stop).toHaveBeenCalled();
    sweep.mockRestore(); stop.mockRestore();
  });
});

describe("Sweep", () => {
  it("steps the drive through the store up, down and back, and ends on a finished rebuild", async () => {
    setDoc(compliantDoc(0));
    const sent: string[] = [];
    const setParameterExpr = vi.fn(async (_n: string, v: string) => { sent.push(v); setDoc(compliantDoc(Number(v))); });
    const rebuildSolids = vi.fn(async () => {});
    const keep = { setParameterExpr: useStore.getState().setParameterExpr, rebuildSolids: useStore.getState().rebuildSolids };
    useStore.setState({ setParameterExpr, rebuildSolids });
    await useMechanism.getState().sweep("travel", { perLeg: 4, stepMs: 0 });
    expect(sent).toEqual(["2.5", "5", "7.5", "10", "7.5", "5", "2.5", "0"]);
    expect(setParameterExpr).toHaveBeenCalledWith("travel", "2.5");
    expect(rebuildSolids).toHaveBeenCalledTimes(1);
    expect(useMechanism.getState().sweeping).toBeNull();
    useStore.setState(keep);
  });

  it("stops on request and puts the drive back where it started (a sweep is a preview)", async () => {
    setDoc(compliantDoc(0));
    const sent: string[] = [];
    const keep = { setParameterExpr: useStore.getState().setParameterExpr, rebuildSolids: useStore.getState().rebuildSolids };
    useStore.setState({
      setParameterExpr: async (_n: string, v: string) => { sent.push(v); setDoc(compliantDoc(Number(v))); if (sent.length === 2) useMechanism.getState().stopSweep(); },
      rebuildSolids: async () => {},
    });
    await useMechanism.getState().sweep("travel", { perLeg: 4, stepMs: 0 });
    expect(sent).toEqual(["2.5", "5", "0"]);
    expect(useMechanism.getState().sweeping).toBeNull();
    useStore.setState(keep);
  });

  it("leaves the undo history as it was: a sweep commits nothing", async () => {
    const s = realSession();
    await s.dispatch("parameter.add", { name: "travel", expression: "0", min: 0, max: 10, step: 0.1 });
    s.doc.joints = compliantDoc(0).joints as never;
    const keep = { session: useStore.getState().session, rebuildSolids: useStore.getState().rebuildSolids };
    useStore.setState({ session: s, rebuildSolids: async () => {}, rev: useStore.getState().rev + 1 });
    const before = s.undoDepth;
    await useMechanism.getState().sweep("travel", { perLeg: 4, stepMs: 0 });
    expect(s.doc.parameters.find((p) => p.name === "travel")?.value).toBe(0);
    expect(s.undoDepth).toBe(before);
    useStore.setState(keep);
  });

  it("a sweep nobody watches (started from the ring) shows a Stop chip over the viewport", async () => {
    const stop = vi.spyOn(useMechanism.getState(), "stopSweep").mockImplementation(() => {});
    render(<ViewChips />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    act(() => useMechanism.setState({ sweeping: "travel", watchers: 0 }));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalled();
    act(() => useMechanism.setState({ watchers: 1 }));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    stop.mockRestore();
  });

  it("stops when the Mechanism tab goes away (switching tabs ends the preview)", async () => {
    const stop = vi.spyOn(useMechanism.getState(), "stopSweep").mockImplementation(() => {});
    setDoc(compliantDoc(0));
    const r = render(<MechanismPanel />);
    act(() => useMechanism.setState({ sweeping: "travel" }));
    r.unmount();
    expect(stop).toHaveBeenCalled();
    stop.mockRestore();
  });
});

describe("shell", () => {
  it("offers the Mechanism switch only on a compliant model, and opens its tab", async () => {
    setDoc(plainDoc());
    const { rerender } = render(<><PanelToggles /><RightPanel /></>);
    const bar = screen.getByRole("toolbar", { name: "Concept panels" });
    expect(within(bar).queryByRole("button", { name: "Mechanism" })).toBeNull();
    setDoc(compliantDoc());
    rerender(<><PanelToggles /><RightPanel /></>);
    await userEvent.click(within(bar).getByRole("button", { name: "Mechanism" }));
    expect(useUi.getState().panels.mechanism).toBe(true);
    expect(useUi.getState().rightTab).toBe("mechanism");
    expect(within(screen.getByRole("group", { name: "Right panel" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["Inspector", "Mechanism"]);
    expect(screen.getByRole("region", { name: "Mechanism" })).toBeTruthy();
  });
});
