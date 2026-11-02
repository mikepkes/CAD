// Show motion: while a motion study runs, the store keeps the last few poses checked (the viewport draws them as
// see-through ghosts), drops them when the study ends or is stopped, keeps none with the option off; the option
// is on by default, remembered, and switched in the running study's chip.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { useStore, __setGeometryBackend, MOTION_TRAIL } from "../../src/model/store";
import { ViewChips } from "../../src/ui/ConceptShell";
import { realSession } from "../helpers";
import type { GeometryBackend } from "../../src/core/geometry/backend";

/** A study backend that records, at each check, the poses the store is showing. */
function studyBackend(during: Record<string, string>[][], hold?: Promise<void>): GeometryBackend {
  return {
    init: async () => {}, ready: () => true, evaluate: async () => ({ solids: {}, facePlanes: {} }), edges: async () => [], exportBytes: async () => null, dispose: () => {},
    collide: async () => { during.push(useStore.getState().motionPoses); if (hold) await hold; return { maxOverlap: 0, overlaps: [] }; },
  } as never;
}

let n = 0;
beforeEach(async () => {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "turn", expression: "0" });
  await s.dispatch("parameter.add", { name: "gap", expression: String(++n) }); // a value not checked before (verdicts are kept)
  s.doc.joints.j = { id: "j", kind: "revolute", valueExpr: "turn" } as never;
  act(() => useStore.setState({ session: s, motionStatus: "idle", motionResult: null, motionPrevious: null, motionPoses: [], motionGhost: true }));
});

describe("the poses a running study shows", () => {
  it("the pose being checked first, a trail of the ones before, none once it's done", async () => {
    const during: Record<string, string>[][] = [];
    __setGeometryBackend(studyBackend(during), studyBackend(during));
    await act(() => useStore.getState().runMotionStudy());
    expect(during[0]).toEqual([{ turn: "0" }]);
    expect(during[1]).toEqual([{ turn: "90" }, { turn: "0" }]);
    expect(Math.max(...during.map((d) => d.length))).toBe(MOTION_TRAIL);
    expect(useStore.getState().motionStatus).toBe("pass");
    expect(useStore.getState().motionPoses).toEqual([]); // no ghosts left behind
  });

  it("none left when the study is stopped", async () => {
    const during: Record<string, string>[][] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    __setGeometryBackend(studyBackend(during), studyBackend(during, hold));
    let run!: Promise<void>;
    act(() => { run = useStore.getState().runMotionStudy(); });
    await act(async () => { while (!during.length) await new Promise((r) => setTimeout(r, 5)); }); // held at its first check
    expect(useStore.getState().motionPoses.length).toBe(1);
    act(() => useStore.getState().cancelMotionStudy());
    expect(useStore.getState().motionPoses).toEqual([]);
    release();
    await act(() => run);
    expect(useStore.getState().motionPoses).toEqual([]);
    expect(useStore.getState().motionStatus).toBe("idle");
  });

  it("none with the option off", async () => {
    const during: Record<string, string>[][] = [];
    __setGeometryBackend(studyBackend(during), studyBackend(during));
    act(() => useStore.getState().setMotionGhost(false));
    await act(() => useStore.getState().runMotionStudy());
    expect(during.every((d) => d.length === 0)).toBe(true);
    expect(localStorage.getItem("vibecad.motionGhost.v1")).toBe("0");
    act(() => useStore.getState().setMotionGhost(true));
    expect(localStorage.getItem("vibecad.motionGhost.v1")).toBe("1");
  });
});

describe("the Show motion switch", () => {
  it("sits in the running study's chip and turns the ghosts off and on", () => {
    render(<ViewChips />);
    act(() => useStore.setState({ motionStatus: "running", motionProgress: 0.3, motionPoses: [{ turn: "90" }] }));
    const b = screen.getByRole("button", { name: "Show motion" });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(b);
    expect(useStore.getState().motionGhost).toBe(false);
    expect(useStore.getState().motionPoses).toEqual([]);
    expect(screen.getByRole("button", { name: "Show motion" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Show motion" }));
    expect(useStore.getState().motionGhost).toBe(true);
  });
});
