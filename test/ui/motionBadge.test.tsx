// The motion badge (V8, V16): an estimate while it runs, the coarse result while
// the rest is checked, the last verdict kept as "before your change", verdicts
// worded by joint type, and a live region that speaks verdicts, not percents.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useStore, __setGeometryBackend } from "../../src/model/store";
import { MotionBadge, etaText } from "../../src/ui/CustomizeControls";
import { realSession } from "../helpers";

const pass = { status: "pass" as const, worstOverlap: 0 };
beforeEach(async () => {
  const s = realSession();
  await s.dispatch("parameter.add", { name: "turn", expression: "0", label: "Knob" });
  s.doc.joints.j = { id: "j", kind: "revolute", valueExpr: "turn" } as never;
  act(() => useStore.setState({ session: s, hasMotionStudy: true, motionStatus: "idle", motionResult: null, motionPrevious: null, motionCoarse: null, motionEta: null, motionProgress: 0 }));
});

describe("<MotionBadge/>", () => {
  it("while running: how far, about how long, and — once the coarse pass is clear — that it's refining", () => {
    render(<MotionBadge />);
    act(() => useStore.setState({ motionStatus: "running", motionProgress: 0.25, motionEta: 42 }));
    expect(screen.getByText("Checking the motion", { selector: ".cz-badge-text" })).toBeTruthy();
    expect(screen.getByText("25% · about 40 s left")).toBeTruthy();
    act(() => useStore.setState({ motionProgress: 0.5, motionEta: 130, motionCoarse: { checked: 4, total: 8 } }));
    expect(screen.getByText("Clear at 4 of 8 positions · checking the rest")).toBeTruthy();
    expect(screen.getByText("50% · about 2 min left")).toBeTruthy();
  });

  it("words the verdict by the joint, and keeps it as \"before your change\" after an edit", () => {
    render(<MotionBadge />);
    act(() => useStore.setState({ motionStatus: "pass", motionResult: pass }));
    expect(screen.getByText("Knob turns a full circle with nothing in the way")).toBeTruthy();
    expect(screen.queryByText(/Rotates freely/)).toBeNull();
    act(() => useStore.getState().cancelMotionStudy()); // a slider moved
    expect(useStore.getState().motionPrevious).toEqual(pass);
    expect(screen.getByText(/Before your change: ✓ Knob turns a full circle/)).toBeTruthy();
    expect(screen.getByText("Will check again when you stop")).toBeTruthy();
    act(() => useStore.setState({ motionStatus: "running", motionProgress: 0.1 }));
    expect(screen.getByText(/Before your change/)).toBeTruthy(); // still shown while the new check runs
  });

  it("tells a screen reader the verdicts, not every percent", () => {
    render(<MotionBadge />);
    const live = screen.getByRole("status");
    act(() => useStore.setState({ motionStatus: "running", motionProgress: 0.3 }));
    expect(live.textContent).toBe("Checking the motion");
    act(() => useStore.setState({ motionProgress: 0.6 }));
    expect(live.textContent).toBe("Checking the motion");
    act(() => useStore.setState({ motionStatus: "fail", motionResult: { status: "fail", reason: "Ring 2 hits Frame at Knob = 90°", worstOverlap: 4 } }));
    expect(live.textContent).toBe("Motion check: Ring 2 hits Frame at Knob = 90°");
  });

  it("a set of values checked before answers at once; turning the drive itself needs no new check", async () => {
    let poses = 0;
    const fake = { init: async () => {}, ready: () => true, collide: async () => { poses++; return { maxOverlap: 0, overlaps: [] }; } } as never;
    __setGeometryBackend(fake, fake);
    await act(() => useStore.getState().runMotionStudy());
    expect(useStore.getState().motionStatus).toBe("pass");
    expect(poses).toBe(8); // coarse 4, then the 4 between
    const doc = useStore.getState().session.doc;
    act(() => useStore.getState().cancelMotionStudy());
    doc.parameters[0].expr = "120"; // the knob moved: the study poses it anyway, so the verdict stands
    await act(() => useStore.getState().runMotionStudy());
    expect(useStore.getState().motionStatus).toBe("pass");
    expect(useStore.getState().motionPrevious).toBeNull();
    expect(poses).toBe(8); // nothing re-checked
    act(() => useStore.getState().cancelMotionStudy());
    await act(async () => { await useStore.getState().session.dispatch("parameter.add", { name: "gap", expression: "3" }); });
    useStore.getState().session.doc.joints.j = { id: "j", kind: "revolute", valueExpr: "turn" } as never; // (set by hand above, so put back after the replay)
    await act(() => useStore.getState().runMotionStudy());
    expect(poses).toBe(16); // a new value: checked afresh
  });

  it("says the time left in round numbers", () => {
    expect(etaText(null)).toBe("estimating time");
    expect(etaText(3)).toBe("about 5 s left");
    expect(etaText(42)).toBe("about 40 s left");
    expect(etaText(129)).toBe("about 2 min left");
  });
});
