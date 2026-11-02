// The Mechanism panel's logic (src/model/concepts/mechanism.ts) and the strain
// field the Strain lens paints (strainField in src/sim/flexure.ts), on the
// committed bistable switch and four-bar examples.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sessionFromDoc } from "./helpers";
import { deserializeDocument } from "../src/core/persistence";
import { flexureEquilibria, flexureState, flexureSweep, strainField, isAngularDrive, type FlexureState } from "../src/sim/flexure";
import { barFill, buildCurve, chartGeometry, drivesOf, effortAt, fmt, fmtDrive, fmtEffort, labelSide, niceTicks, restSentence, strainBars, sweepPlan, worstFlexure, zeroLabels, type MechanismCurve } from "../src/model/concepts/mechanism";
import type { CadDocument } from "../src/core/document";

async function example(name: string): Promise<CadDocument> {
  const json = readFileSync(fileURLToPath(new URL(`../public/examples/${name}.json`, import.meta.url)), "utf8");
  const s = sessionFromDoc(deserializeDocument(json));
  await s.recompute();
  return s.doc;
}

describe("mechanism logic", () => {
  it("snaps sweep plans to the step and goes up, down and back", () => {
    expect(sweepPlan(0, 0, 10, 5, 0.1)).toEqual([2, 4, 6, 8, 10, 8, 6, 4, 2, 0]);
    expect(sweepPlan(5, 0, 10, 4)).toEqual([7.5, 10, 7.5, 5, 2.5, 0, 2.5, 5]);
    expect(sweepPlan(20, 0, 10, 2)).toEqual([5, 0, 5, 10]); // clamped into range: starts at the top
    expect(sweepPlan(0, 3, 3)).toEqual([]);
  });

  it("formats numbers, efforts and drive values", () => {
    expect(fmt(10)).toBe("10");
    expect(fmt(2.5)).toBe("2.5");
    expect(fmt(-0.0001)).toBe("0");
    expect(fmtEffort(12.34, false)).toBe("12.3 N");
    expect(fmtEffort(0.456, false)).toBe("0.46 N");
    expect(fmtEffort(123.4, true)).toBe("123 N·mm");
    expect(fmtDrive(4.25, false)).toBe("4.25 mm");
    expect(fmtDrive(-7.5, true)).toBe("-7.5°");
  });

  it("makes round ticks", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(-3.2, 7.9, 4)).toEqual([-2.5, 0, 2.5, 5, 7.5]);
    expect(niceTicks(-12, 30, 4)).toEqual([-10, 0, 10, 20, 30]);
  });

  it("reads the effort off the curve and lays the chart out with zero inside", () => {
    const curve = { points: [{ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 10, y: -10 }], min: 0, max: 10 };
    expect(effortAt(curve, 2.5)).toBe(5);
    expect(effortAt(curve, 7.5)).toBe(0);
    expect(effortAt(curve, 99)).toBe(-10);
    const g = chartGeometry(curve, { w: 200, h: 100, left: 20, right: 10, top: 10, bottom: 20 });
    expect(g.sx(0)).toBe(20);
    expect(g.sx(10)).toBe(190);
    expect(g.zeroY).toBeCloseTo(45);
    expect(g.yLo).toBeLessThan(-10);
    expect(g.yHi).toBeGreaterThan(10);
    expect(g.path.startsWith("M20,45")).toBe(true);
    expect(g.path.match(/L/g)?.length).toBe(2);
  });

  it("scales a bistable curve to the stretch between its rests, not the steep climb past them", () => {
    const points = [{ x: 0, y: 0 }, { x: 2, y: 12 }, { x: 5, y: 0 }, { x: 6, y: -4 }, { x: 7, y: 0 }, { x: 10, y: 90 }];
    const curve = { points, min: 0, max: 10, stable: [{ x: 0, y: 0 }, { x: 7, y: 0 }], multistable: true };
    const g = chartGeometry(curve, { w: 200, h: 100, left: 20, right: 10, top: 10, bottom: 20 });
    expect(g.yHi).toBeLessThan(20);
    expect(g.yHi).toBeGreaterThan(12);
    expect(chartGeometry({ ...curve, multistable: false }, { w: 200, h: 100, left: 20, right: 10, top: 10, bottom: 20 }).yHi).toBeGreaterThan(90);
  });

  it("says where it rests, where it tips and what snaps it, and fills a bar with the ramp up to its value", () => {
    const base = { param: "travel", angular: false, unit: "mm", effortUnit: "N", min: 0, max: 10, points: [] };
    expect(restSentence({ ...base, stable: [{ x: 0, y: 0 }, { x: 6.8, y: 0 }], unstable: [{ x: 4.9, y: 0 }], multistable: true, snap: { x: 1.5, y: 11.8 } }))
      .toBe("Bistable: rests at 0 mm and 6.8 mm; tips over at 4.9 mm; snaps over at 11.8 N.");
    expect(restSentence({ ...base, stable: [{ x: 0, y: 0 }], unstable: [], multistable: false })).toBe("Rests at 0 mm.");
    expect(restSentence({ ...base, stable: [], unstable: [], multistable: false })).toMatch(/^No rest position/);
    expect(restSentence({ ...base, stable: [{ x: 0, y: 0 }, { x: 6.8, y: 0 }], unstable: [{ x: 4.9, y: 0 }], multistable: true, snap: { x: 1.6, y: 11.9 }, pullBack: { x: 6.2, y: -4.6 } }))
      .toBe("Bistable: rests at 0 mm and 6.8 mm; tips over at 4.9 mm; snaps over at 11.9 N and back at -4.6 N.");
    expect(restSentence({ ...base, stable: [{ x: 0, y: 0 }, { x: 6.5, y: 0, limit: true }], unstable: [{ x: 4.9, y: 0 }], multistable: true }))
      .toBe("Bistable: rests at 0 mm and 6.5 mm (end of range); tips over at 4.9 mm.");
    expect(barFill(50)).toEqual({ width: "50%", background: "var(--k-an-strain)", backgroundSize: "200% 100%" });
    expect(barFill(130).background).toBe("var(--k-an-strain-over)");
    expect(barFill(NaN).width).toBe("0%");
    expect(labelSide(150, 0, 200)).toBe("end");
    expect(labelSide(50, 0, 200)).toBe("start");
  });

  it("labels the points on the zero line where the curve leaves room, clear of each other and inside the plot", () => {
    // a rest below-right, a tipping point below-left (the curve is above the line there)
    const [rest, tip] = zeroLabels([{ px: 40, stable: true, width: 20 }, { px: 140, stable: false, width: 30 }], 100, 40, 246);
    expect(rest).toEqual({ x: 44, y: 115, anchor: "start" });
    expect(tip).toEqual({ x: 136, y: 115, anchor: "end" });
    // a rest at the right edge goes above-left; one crowding the label before it, likewise
    expect(zeroLabels([{ px: 240, stable: true, width: 30 }], 100, 40, 246)[0]).toEqual({ x: 236, y: 91, anchor: "end" });
    const crowd = zeroLabels([{ px: 60, stable: true, width: 40 }, { px: 110, stable: false, width: 30 }], 100, 40, 246);
    expect(crowd[1]).toEqual({ x: 114, y: 91, anchor: "start" });
    // nowhere to go: left unlabelled (its tooltip says it)
    expect(zeroLabels([{ px: 100, stable: true, width: 400 }], 100, 40, 246)[0]).toBeNull();
  });

  it("leaves room under the pull-back's dip and the zero line for their labels", () => {
    const box = { w: 200, h: 100, left: 20, right: 10, top: 10, bottom: 20 };
    const points = [{ x: 0, y: 0 }, { x: 2, y: 12 }, { x: 5, y: 0 }, { x: 6, y: -4 }, { x: 7, y: 0 }, { x: 10, y: 20 }];
    const g = chartGeometry({ points, min: 0, max: 10, stable: [{ x: 0, y: 0 }, { x: 7, y: 0 }], multistable: true, pullBack: { x: 6, y: -4 } }, box);
    expect(box.h - box.bottom - g.sy(-4)).toBeGreaterThanOrEqual(18 - 1e-9);
    const up = chartGeometry({ points: [{ x: 0, y: 0 }, { x: 10, y: 30 }], min: 0, max: 10, stable: [{ x: 0, y: 0 }] }, box);
    expect(box.h - box.bottom - up.zeroY).toBeGreaterThanOrEqual(18 - 1e-9);
  });

  it("bars each flexure against its limit and picks the worst", () => {
    const st = { flexures: [
      { joint: "a", name: "A", angle: 0, strain: 0.01, allowable: 0.04, moment: 0 },
      { joint: "b", name: "B", beam: true, angle: 0, strain: 0.05, allowable: 0.04, moment: 0 },
      { joint: "c", name: "C", angle: 0, strain: 0.02, moment: 0 },
    ] } as Pick<FlexureState, "flexures">;
    const bars = strainBars(st);
    expect(bars.map((b) => [b.name, Math.round(b.pct), b.over])).toEqual([["A", 25, false], ["B", 125, true], ["C", NaN, false]]);
    expect(worstFlexure(st)?.name).toBe("B");
  });
});

describe("bistable switch", () => {
  let doc: CadDocument;
  let curve: MechanismCurve;
  let study: ReturnType<typeof flexureEquilibria>;
  beforeAll(async () => {
    doc = await example("bistable");
    study = flexureEquilibria(doc, "travel", 0, 10, 40);
    curve = buildCurve(study, "travel", isAngularDrive(doc, "travel"), 0, 10);
  }, 240_000);

  it("is driven by travel", () => {
    expect(drivesOf(doc).map((p) => p.name)).toEqual(["travel"]);
    expect(curve.angular).toBe(false);
    expect(curve.effortUnit).toBe("N");
  });

  it("has two stable rests with one unstable equilibrium between them", () => {
    expect(curve.multistable).toBe(true);
    expect(curve.stable.length).toBe(2);
    const [a, b] = curve.stable;
    const between = curve.unstable.filter((u) => u.x > a.x && u.x < b.x);
    expect(between.length).toBe(1);
    expect(a.x).toBeLessThan(0.5); // the as-made pose
    expect(b.x).toBeGreaterThan(4);
    // stable = effort rising through zero: below on the left, above on the right
    expect(effortAt(curve, b.x - 0.5)).toBeLessThan(0);
    expect(effortAt(curve, b.x + 0.5)).toBeGreaterThan(0);
    expect(effortAt(curve, between[0].x - 0.5)).toBeGreaterThan(0);
    expect(effortAt(curve, between[0].x + 0.5)).toBeLessThan(0);
  });

  // the example's numbers (TPU 68D, span 60, arch 4): the rests at 0 and just
  // short of the mirror shape, the tipping point between, 11.9 N to snap over
  // and 4.6 N to pull it back
  it("finds both rests and the tipping point at the right travels, each an extremum of the energy", () => {
    const at = (kind: boolean) => study.states.filter((s) => s.stable === kind).map((s) => s.value);
    expect(at(true).length).toBe(2);
    expect(at(true)[0]).toBeCloseTo(0, 6);
    expect(at(true)[1]).toBeCloseTo(6.8, 1);
    expect(at(false).length).toBe(1);
    expect(at(false)[0]).toBeCloseTo(4.89, 1);
    expect(study.states.some((s) => s.limit)).toBe(false); // the flexures hold both, not the ends of the range
    // a rest is a minimum of the stored energy, the tipping point its maximum
    const U = (v: number) => flexureSweep(doc, "travel", [v])[0].energy;
    for (const s of study.states) {
      const lo = Math.max(0, s.value - 0.1), hi = s.value + 0.1;
      if (s.stable) { expect(U(hi)).toBeGreaterThan(s.energy); if (s.value > 0.1) expect(U(lo)).toBeGreaterThan(s.energy); }
      else { expect(U(hi)).toBeLessThan(s.energy); expect(U(lo)).toBeLessThan(s.energy); }
    }
    expect(study.snap!.effort).toBeCloseTo(11.9, 1);
    expect(study.snap!.value).toBeGreaterThan(1.25);
    expect(study.snap!.value).toBeLessThan(1.75);
    expect(study.pullBack!.effort).toBeCloseTo(-4.6, 1);
    expect(study.pullBack!.value).toBeGreaterThan(at(false)[0]);
    expect(study.pullBack!.value).toBeLessThan(at(true)[1]);
    // the refinements beat the samples, and are drawn with them
    const sampled = study.poses.filter((p) => Math.abs(p.value * 4 - Math.round(p.value * 4)) < 1e-9);
    expect(study.snap!.effort).toBeGreaterThanOrEqual(Math.max(...sampled.map((p) => p.effort).filter((e, i) => sampled[i].value < at(true)[1])));
    expect(study.pullBack!.effort).toBeLessThanOrEqual(Math.min(...sampled.filter((p) => p.value < at(true)[1]).map((p) => p.effort)));
    expect(curve.pullBack).toEqual({ x: study.pullBack!.value, y: study.pullBack!.effort });
    expect(curve.points.some((p) => p.x === study.pullBack!.value && p.y === study.pullBack!.effort)).toBe(true);
    flexureState(doc); // leave it as it stands
  });

  it("rests against an end of the range the energy still falls into", () => {
    // cut short of its second rest, it sits against the end of travel
    const short = flexureEquilibria(doc, "travel", 0, 6.5, 13);
    expect(short.states.filter((s) => s.stable).map((s) => [+s.value.toFixed(6), !!s.limit])).toEqual([[0, false], [6.5, true]]);
    expect(short.multistable).toBe(true);
    expect(short.pullBack).toBeDefined();
    // started part-way in, the start of the range is pressed on the same way
    const late = flexureEquilibria(doc, "travel", 1, 10, 18);
    expect(late.states.filter((s) => s.stable).map((s) => [+s.value.toFixed(1), !!s.limit])).toEqual([[1, true], [6.8, false]]);
    flexureState(doc);
  }, 120_000);

  it("labels the snap force flexureEquilibria found, the peak of the curve between the rests", () => {
    expect(curve.snap).toBeDefined();
    expect(curve.snap!.y).toBe(study.snap!.effort);
    expect(curve.snap!.x).toBe(study.snap!.value);
    const [a, b] = curve.stable;
    const peak = Math.max(...curve.points.filter((p) => p.x > a.x && p.x < b.x).map((p) => p.y));
    expect(curve.snap!.y).toBeCloseTo(peak, 6);
    expect(curve.snap!.y).toBeGreaterThan(0);
    expect(curve.points.length).toBeGreaterThan(30);
  });

  it("lays out the strain field along the deformed beams", () => {
    const st = flexureState(doc, { travel: "3" });
    const seg = strainField(doc, st, { travel: "3" });
    const beams = new Set(seg.map((s) => s.joint));
    expect(beams.size).toBe(Object.values(doc.joints).filter((j) => j.kind === "beam").length);
    expect(seg.every((s) => Number.isFinite(s.ua) && s.ua >= 0 && s.radius > 0 && Math.abs(Math.hypot(s.n.x, s.n.y, s.n.z) - 1) < 1e-9)).toBe(true);
    // the curved beams work hardest at 3 mm in: their worst element is the worst flexure
    const worst = worstFlexure(st)!;
    const peak = Math.max(...seg.filter((s) => s.joint === worst.joint).flatMap((s) => [s.ua, s.ub]));
    expect(peak * 100).toBeCloseTo(worst.pct, 6);
    // a beam's field runs from its base end to its moved end: the first point is the clamp
    const j = Object.values(doc.joints).find((q) => q.name === "Beam lower left")!;
    const first = seg.find((s) => s.joint === j.id)!;
    expect(first.a.x).toBeCloseTo(j.baseOrigin.x, 0); // (the wall it hangs from gives a little)
    expect(first.a.y).toBeCloseTo(j.baseOrigin.y, 0);
    flexureState(doc); // leave it as it stands
  });
});

describe("four-bar", () => {
  it("is monostable: one rest, as made, no tipping point, nothing to snap", async () => {
    const doc = await example("fourbar");
    const study = flexureEquilibria(doc, "theta", -20, 20, 40);
    expect(study.states).toEqual([{ value: 0, stable: true, energy: 0 }]);
    expect(study.multistable).toBe(false);
    expect(study.snap).toBeUndefined();
    expect(study.pullBack).toBeUndefined();
    const curve = buildCurve(study, "theta", true, -20, 20);
    expect(curve.stable).toEqual([{ x: 0, y: 0 }]);
    expect(curve.unstable).toEqual([]);
    expect(restSentence(curve)).toBe("Rests at 0°.");
  }, 60_000);

  it("places each hinge's disc at its pivot, with its strain", async () => {
    const doc = await example("fourbar");
    const st = flexureState(doc, { theta: "15" });
    const seg = strainField(doc, st, { theta: "15" });
    expect(seg.length).toBe(4);
    for (const s of seg) {
      expect(s.a).toEqual(s.b);
      expect(Math.abs(s.n.z)).toBeCloseTo(1, 9);
      const f = st.flexures.find((q) => q.joint === s.joint)!;
      expect(s.ua).toBeCloseTo(f.strain / f.allowable!, 12);
    }
    expect(seg.find((s) => s.ua > 0)).toBeTruthy();
    expect(isAngularDrive(doc, "theta")).toBe(true);
  }, 60_000);
});
