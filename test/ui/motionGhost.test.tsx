// Show motion: while a motion study runs, the store says when it started, how many poses it checks and how long the
// last run took (the viewport paces its sweep of the motion by them), and says nothing once the study ends or is
// stopped; the option is on by default, remembered, and switched in the running study's chip.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { useStore, __setGeometryBackend } from "../../src/model/store";
import { ViewChips } from "../../src/ui/ConceptShell";
import { realSession } from "../helpers";
import type { GeometryBackend } from "../../src/core/geometry/backend";

type Run = ReturnType<typeof useStore.getState>["motionRun"];
/** A study backend that records, at each check, what the store says of the running study. */
function studyBackend(during: Run[], hold?: Promise<void>): GeometryBackend {
  return {
    init: async () => {}, ready: () => true, evaluate: async () => ({ solids: {}, facePlanes: {} }), edges: async () => [], exportBytes: async () => null, dispose: () => {},
    collide: async () => { during.push(useStore.getState().motionRun); if (hold) await hold; return { maxOverlap: 0, overlaps: [] }; },
  } as never;
}

let n = 0;
beforeEach(async () => {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "turn", expression: "0" });
  await s.dispatch("parameter.add", { name: "gap", expression: String(++n) }); // a value not checked before (verdicts are kept)
  s.doc.joints.j = { id: "j", kind: "revolute", valueExpr: "turn" } as never;
  act(() => useStore.setState({ session: s, motionStatus: "idle", motionResult: null, motionPrevious: null, motionRun: null, motionGhost: true }));
});

describe("the running study, as the viewport paces its sweep by it", () => {
  it("its start and pose count while it runs, the last run's time on the next, nothing once it's done", async () => {
    const during: Run[] = [];
    __setGeometryBackend(studyBackend(during), studyBackend(during));
    const before = performance.now();
    await act(() => useStore.getState().runMotionStudy());
    expect(during).toHaveLength(8); // one drive, every 45°
    expect(during.every((r) => r === during[0])).toBe(true); // one run, not a new one per pose
    expect(during[0]).toMatchObject({ poses: 8, lastMs: null });
    expect(during[0]!.started).toBeGreaterThanOrEqual(before);
    expect(useStore.getState().motionStatus).toBe("pass");
    expect(useStore.getState().motionRun).toBeNull(); // no ghosts left behind
    // a changed value is checked again, paced by how long the last run took
    const doc = useStore.getState().session.doc;
    doc.parameters = doc.parameters.map((p) => (p.name === "gap" ? { ...p, expr: String(++n) } : p));
    during.length = 0;
    await act(() => useStore.getState().runMotionStudy());
    expect(during).toHaveLength(8);
    expect(during[0]!.lastMs).not.toBeNull();
  });

  it("nothing once the study is stopped", async () => {
    const during: Run[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    __setGeometryBackend(studyBackend(during), studyBackend(during, hold));
    let run!: Promise<void>;
    act(() => { run = useStore.getState().runMotionStudy(); });
    await act(async () => { while (!during.length) await new Promise((r) => setTimeout(r, 5)); }); // held at its first check
    expect(useStore.getState().motionRun).not.toBeNull();
    act(() => useStore.getState().cancelMotionStudy());
    expect(useStore.getState().motionRun).toBeNull();
    release();
    await act(() => run);
    expect(useStore.getState().motionRun).toBeNull();
    expect(useStore.getState().motionStatus).toBe("idle");
  });

  it("the option is remembered", () => {
    act(() => useStore.getState().setMotionGhost(false));
    expect(useStore.getState().motionGhost).toBe(false);
    expect(localStorage.getItem("vibecad.motionGhost.v1")).toBe("0");
    act(() => useStore.getState().setMotionGhost(true));
    expect(localStorage.getItem("vibecad.motionGhost.v1")).toBe("1");
  });
});

describe("the Show motion switch", () => {
  it("sits in the running study's chip and turns the ghosts off and on", () => {
    render(<ViewChips />);
    act(() => useStore.setState({ motionStatus: "running", motionProgress: 0.3, motionRun: { started: 0, poses: 8, lastMs: null } }));
    const b = screen.getByRole("button", { name: "Show motion" });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(b);
    expect(useStore.getState().motionGhost).toBe(false);
    expect(screen.getByRole("button", { name: "Show motion" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Show motion" }));
    expect(useStore.getState().motionGhost).toBe(true);
  });
});
