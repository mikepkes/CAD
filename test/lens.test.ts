import { describe, it, expect } from "vitest";
import {
  lensRadius, initialPosition, clampLens, frameOf, inLens, countInside, handlePos, dragTo, orientUp, overhangClass,
  hudPlacement, HUD_TOP_KEEPOUT, supportArea, shapeChoice, stepTo, STRIPES, toLensSpec, legendFor, readoutsFor, arrowDelta, boundsCentre, bodyCentres, hasCurvature, MODES, useLens, DEFAULT_LENS, strainSummary,
} from "../src/ui/concepts/lens/lens";
import { curvatureColors, OVERHANG_RED_SIN, STRAIN_COLORS, packStrain } from "../src/viewport/lensPass";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const B = { w: 800, h: 600 };
const A = { stripes: 12, draftDeg: 1, pull: { x: 0, y: 0, z: 1 }, quantity: "mean" as const };

describe("lens geometry", () => {
  it("sizes the circle from the shorter side and never beyond half of it", () => {
    expect(lensRadius("S", B)).toBe(72);
    expect(lensRadius("M", B)).toBe(120);
    expect(lensRadius("L", B)).toBe(180);
    expect(lensRadius("L", { w: 100, h: 100 })).toBe(40); // 30 px would be too small to grab: the 40px floor
    expect(lensRadius("S", { w: 60, h: 60 })).toBe(26); // the half-side cap wins over the floor
  });

  it("first appears centred and clamps so the circle stays inside the viewport", () => {
    expect(initialPosition(B)).toEqual({ x: 400, y: 300, wipeX: 400 });
    expect(clampLens({ x: 10, y: 590, wipeX: 900 }, 100, B)).toEqual({ x: 100, y: 500, wipeX: 800 });
    expect(clampLens({ x: 400, y: 300, wipeX: -5 }, 100, B)).toEqual({ x: 400, y: 300, wipeX: 0 });
    expect(clampLens({ x: 0, y: 0, wipeX: 0 }, 400, { w: 300, h: 300 })).toEqual({ x: 150, y: 150, wipeX: 0 });
  });

  it("frameOf places an unset lens and keeps a set one", () => {
    const f = frameOf({ ...DEFAULT_LENS }, B);
    expect(f).toEqual({ shape: "lens", r: 120, x: 400, y: 300, wipeX: 400 });
    const g = frameOf({ ...DEFAULT_LENS, x: 50, y: 50, wipeX: 10, size: "S" }, B);
    expect(g).toEqual({ shape: "lens", r: 72, x: 72, y: 72, wipeX: 10 });
  });

  it("hit-tests the circle and the wipe", () => {
    const circle = { shape: "lens" as const, x: 400, y: 300, r: 100, wipeX: 400 };
    expect(inLens(circle, { x: 400, y: 300 })).toBe(true);
    expect(inLens(circle, { x: 500, y: 300 })).toBe(true);
    expect(inLens(circle, { x: 501, y: 300 })).toBe(false);
    expect(inLens(circle, { x: 471, y: 371 })).toBe(false);
    const wipe = { ...circle, shape: "wipe" as const };
    expect(inLens(wipe, { x: 399, y: 0 })).toBe(false);
    expect(inLens(wipe, { x: 400, y: 599 })).toBe(true);
  });

  it("counts only visible points under the lens", () => {
    const f = { shape: "lens" as const, x: 400, y: 300, r: 100, wipeX: 400 };
    expect(countInside(f, [
      { x: 400, y: 300, visible: true }, { x: 420, y: 320, visible: false }, { x: 10, y: 10, visible: true }, { x: 480, y: 300, visible: true },
    ])).toBe(2);
  });

  it("puts the handle on the rim at 45° below right, or mid-way down the wipe line", () => {
    const f = { shape: "lens" as const, x: 400, y: 300, r: 100, wipeX: 400 };
    const h = handlePos(f, B);
    expect(h.x).toBeCloseTo(470.71, 1);
    expect(h.y).toBeCloseTo(370.71, 1);
    expect(handlePos({ ...f, shape: "wipe", wipeX: 250 }, B)).toEqual({ x: 250, y: 300 });
  });

  it("drags by the pointer's travel from the grab point, clamped", () => {
    const f = { shape: "lens" as const, x: 400, y: 300, r: 100, wipeX: 400 };
    expect(dragTo(f, { x: 470, y: 370 }, { x: 500, y: 350 }, B)).toEqual({ x: 430, y: 280, wipeX: 430 });
    expect(dragTo(f, { x: 470, y: 370 }, { x: 1470, y: 370 }, B)).toEqual({ x: 700, y: 300, wipeX: 800 });
    expect(arrowDelta("ArrowLeft")).toEqual({ x: -10, y: 0 });
    expect(arrowDelta("ArrowDown", 50)).toEqual({ x: 0, y: 50 });
    expect(arrowDelta("Enter")).toBeNull();
  });

  it("places the HUD beside the lens, never over it: right rim, else left rim, else below", () => {
    const f = { shape: "lens" as const, x: 400, y: 300, r: 100, wipeX: 400 };
    const card = { w: 300, h: 200 };
    expect(hudPlacement({ ...f, x: 300 }, card, B)).toEqual({ x: 416, y: 242 });
    const left = hudPlacement({ ...f, x: 450 }, card, B); // 450 + 100 + 16 + 300 would run past 800
    expect(left.x).toBe(350 - 16 - 300); // so it hangs off the LEFT rim (x − r), clear of the lens
    const below = hudPlacement({ ...f, x: 400, r: 300 }, card, { w: 800, h: 900 }); // no room either side
    expect(below.y).toBe(600 + 16);
    expect(below.x + card.w).toBeLessThanOrEqual(800 - 8);
    const above = hudPlacement({ ...f, x: 400, y: 600, r: 300 }, card, { w: 800, h: 900 }); // only the top is free
    expect(above.y).toBe(300 - 16 - 200);
    const docked = hudPlacement({ ...f, x: 448, y: 325, r: 130 }, { w: 320, h: 255 }, { w: 896, h: 649 }); // nothing fits: far corner
    expect(docked).toEqual({ x: 8, y: 8 }); // dead centre: the top-left corner is as far as any
    const wipe = hudPlacement({ ...f, shape: "wipe", wipeX: 600 }, card, B);
    expect(wipe.x + card.w).toBeLessThanOrEqual(B.w - 8);
    expect(wipe.y).toBe(8);
  });
});

describe("HUD keep-out", () => {
  it("keeps the card out of the top band where the panel switches and the crumb sit", () => {
    const B = { w: 800, h: 600 };
    const card = { w: 300, h: 200 };
    const wipe = hudPlacement({ shape: "wipe", x: 400, y: 300, r: 100, wipeX: 100 }, card, B, HUD_TOP_KEEPOUT);
    expect(wipe.y).toBeGreaterThanOrEqual(HUD_TOP_KEEPOUT);
    const high = hudPlacement({ shape: "lens", x: 200, y: 60, r: 50, wipeX: 400 }, card, B, HUD_TOP_KEEPOUT);
    expect(high.y).toBeGreaterThanOrEqual(HUD_TOP_KEEPOUT);
    // a view too short for the band and the card: the band gives way rather than the card leaving the view
    const short = hudPlacement({ shape: "wipe", x: 400, y: 100, r: 50, wipeX: 100 }, card, { w: 800, h: 240 }, HUD_TOP_KEEPOUT);
    expect(short.y + card.h).toBeLessThanOrEqual(240);
  });
  it("reads a wipe at the left edge as the whole view, and steps settings within their range", () => {
    expect(shapeChoice("wipe", 0)).toBe("whole");
    expect(shapeChoice("wipe", 300)).toBe("wipe");
    expect(shapeChoice("wipe", -1)).toBe("wipe"); // not placed yet
    expect(shapeChoice("lens", 0)).toBe("lens");
    expect(stepTo(12, 1, STRIPES)).toBe(14);
    expect(stepTo(60, 1, STRIPES)).toBe(60);
    expect(stepTo(2, -1, STRIPES)).toBe(2);
  });
});

describe("overhang", () => {
  it("sums the area that needs support for the print orientation, never the face on the bed", () => {
    // a 10 × 10 slab from z 0 to 5 as two triangles per face: the bottom on the bed, the top facing up
    const P = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5];
    const bottom = [0, 2, 1, 0, 3, 2], top = [4, 5, 6, 4, 6, 7];
    const mesh = { positions: new Float32Array(P), indices: new Uint32Array([...bottom, ...top]) };
    const standing = supportArea([mesh], { x: 0, y: 0, z: 1 });
    expect(standing.steep).toBe(0); // the bottom is on the bed
    expect(standing.total).toBeCloseTo(200);
    // a shelf's underside 20 mm up faces down: it needs support
    const shelf = { positions: new Float32Array([0, 0, 20, 10, 0, 20, 10, 10, 20, 0, 10, 20]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
    const withShelf = supportArea([mesh, shelf], { x: 0, y: 0, z: 1 });
    expect(withShelf.steep).toBeCloseTo(100);
    expect(readoutsFor("overhang", A, { bodiesInside: 0, orient: "standing", hasCurvature: false, support: withShelf })[1]).toMatchObject({ label: "Needs support", value: "100 mm² · 33%", state: "bad" });
    // upside down, the slab's top is on the bed and its old bottom faces up: nothing needs support
    expect(supportArea([mesh], { x: 0, y: 0, z: -1 }).steep).toBe(0);
    expect(readoutsFor("overhang", A, { bodiesInside: 0, orient: "standing", hasCurvature: false, support: standing })[1]).toMatchObject({ value: "none", state: "ok" });
  });

  it("maps orientation to the build direction", () => {
    expect(orientUp("standing")).toEqual({ x: 0, y: 0, z: 1 });
    expect(orientUp("back")).toEqual({ x: 0, y: -1, z: 0 });
    expect(orientUp("upsideDown")).toEqual({ x: 0, y: 0, z: -1 });
  });
  it("classes faces as the shader does", () => {
    expect(overhangClass(1, 10)).toBe("neutral"); // facing up
    expect(overhangClass(0, 10)).toBe("neutral"); // vertical wall
    expect(overhangClass(-0.01, 10)).toBe("neutral"); // within the 2° dead band
    expect(overhangClass(-0.5, 10)).toBe("mild"); // 30° overhang
    expect(overhangClass(-OVERHANG_RED_SIN - 0.01, 10)).toBe("steep"); // just past 45°
    expect(overhangClass(-1, 10)).toBe("steep"); // a ceiling
    expect(overhangClass(-1, 0)).toBe("bed"); // the face on the bed
    expect(overhangClass(-1, 0.005)).toBe("bed");
  });
});

describe("spec, legend and readouts", () => {
  it("builds the pass spec from state, frame and analysis", () => {
    const f = { shape: "wipe" as const, x: 1, y: 2, r: 3, wipeX: 4 };
    const spec = toLensSpec({ mode: "overhang", orient: "back" }, f, A);
    expect(spec).toEqual({ mode: "overhang", shape: "wipe", x: 1, y: 2, r: 3, wipeX: 4, up: { x: 0, y: -1, z: 0 }, stripes: 12, draftDeg: 1, pull: { x: 0, y: 0, z: 1 }, quantity: "mean" });
  });
  it("offers six modes: strain (read off the flexure model) but no stress", () => {
    // Strain is honest where a stress mode would not be: it paints only compliant
    // mechanisms' flexures, with the strain the flexure solver already computes.
    expect(MODES.map((m) => m.key)).toEqual(["zebra", "draft", "curvature", "xray", "overhang", "strain"]);
    expect(MODES.some((m) => /stress/i.test(m.label))).toBe(false);
  });
  it("puts the strain field in the spec only in strain mode", () => {
    const f = { shape: "lens" as const, x: 1, y: 2, r: 3, wipeX: 4 };
    const seg = [{ joint: "j", a: { x: 0, y: 0, z: 0 }, b: { x: 1, y: 0, z: 0 }, n: { x: 0, y: 0, z: 1 }, radius: 2, axial: 7, ua: 0.2, ub: 0.4 }];
    expect(toLensSpec({ mode: "strain", orient: "standing" }, f, A, seg).strain).toBe(seg);
    expect(toLensSpec({ mode: "strain", orient: "standing" }, f, A).strain).toEqual([]);
    expect("strain" in toLensSpec({ mode: "zebra", orient: "standing" }, f, A, seg)).toBe(false);
  });
  it("packs strain segments three texels each, a missing limit as -1", () => {
    const seg = { joint: "j", a: { x: 1, y: 2, z: 3 }, b: { x: 4, y: 5, z: 6 }, n: { x: 0, y: 0, z: 1 }, radius: 2, axial: 7, ua: 0.5, ub: NaN };
    expect(Array.from(packStrain([seg]))).toEqual([1, 2, 3, 0.5, 4, 5, 6, -1, 0, 0, 7, 2]);
    expect(packStrain([]).length).toBe(12); // never an empty texture
  });
  it("reads out the worst flexure for the strain lens", () => {
    const o = { bodiesInside: 0, orient: "standing" as const, hasCurvature: false };
    expect(readoutsFor("strain", A, o)[0]).toMatchObject({ label: "Flexures", value: "none in this model" });
    expect(readoutsFor("strain", A, { ...o, strain: strainSummary(4, undefined) }).map((r) => r.value)).toEqual(["4", "reading…"]);
    const st = { flexures: [
      { joint: "a", name: "Hinge A", angle: 10, strain: 0.012, allowable: 0.04, moment: 0 },
      { joint: "b", name: "Hinge B", angle: 20, strain: 0.05, allowable: 0.04, moment: 0 },
    ] };
    const r = readoutsFor("strain", A, { ...o, strain: strainSummary(2, st) });
    expect(r.map((x) => [x.label, x.value])).toEqual([["Worst flexure", "Hinge B"], ["Peak strain", "5.00%"], ["Of its limit", "125%"]]);
    expect(r[2].state).toBe("bad");
    expect(readoutsFor("strain", A, { ...o, strain: strainSummary(1, { flexures: [st.flexures[0]] }) })[2]).toMatchObject({ value: "30%", state: "ok" });
  });
  it("mirrors the strain shader's colours in the kit's legend tokens", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/ui/kit/kit.css", import.meta.url)), "utf8");
    const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
    const ramp = css.match(/--k-an-strain:\s*linear-gradient\(90deg,([^)]*)\)/)![1].split(",").map((x) => x.trim());
    expect(ramp).toEqual(STRAIN_COLORS.ramp.map(hex));
    expect(css).toMatch(new RegExp(`--k-an-strain-over:[^;]*${hex(STRAIN_COLORS.over)}`));
    expect(css).toMatch(new RegExp(`--k-an-strain-rigid:\\s*${hex(STRAIN_COLORS.rigid)}`));
  });
  it("has a legend for every mode", () => {
    for (const m of MODES) {
      const l = legendFor(m.key);
      expect(!!l.rows || !!l.ramp, m.key).toBe(true);
    }
    expect(legendFor("overhang").rows?.length).toBe(4);
    // every swatch is a kit token, never a literal
    for (const m of MODES) {
      const l = legendFor(m.key);
      for (const r of l.rows ?? []) expect(r.color).toMatch(/^var\(--k-an-/);
      if (l.ramp) expect(l.ramp.css).toMatch(/^var\(--k-an-/);
    }
  });
  it("reads out per mode", () => {
    const o = { bodiesInside: 3, orient: "standing" as const, hasCurvature: false };
    expect(readoutsFor("xray", A, o)[0]).toMatchObject({ label: "Bodies under the lens", value: "3" });
    expect(readoutsFor("overhang", A, o)[0]).toMatchObject({ value: "Standing" });
    expect(readoutsFor("draft", A, o).map((r) => r.value)).toEqual(["1°", "0, 0, 1"]);
    expect(readoutsFor("zebra", A, o)[0].value).toBe("12");
    expect(readoutsFor("curvature", A, o).map((r) => r.label)).toEqual(["Quantity", "Data"]);
    expect(readoutsFor("curvature", A, { ...o, hasCurvature: true }).map((r) => r.label)).toEqual(["Quantity"]);
  });
  it("centres bounds, collects the built bodies' centres and knows whether curvature data exists", () => {
    expect(boundsCentre({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 30 } })).toEqual({ x: 5, y: 10, z: 15 });
    const b = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 30 } };
    expect(bodyCentres({ a: { mesh: {} as never, bounds: b }, b: { mesh: undefined, bounds: b }, c: { mesh: {} as never, bounds: undefined } })).toEqual([{ x: 5, y: 10, z: 15 }]);
    expect(hasCurvature({})).toBe(false);
    expect(hasCurvature({ f1: { curvature: new Float32Array(0) } })).toBe(true);
  });
});

describe("curvature colours (pass)", () => {
  it("colours convex red, concave blue, flat white, scaled to the 98th percentile", () => {
    const k = new Float32Array([1, 1, -1, -1, 0, 0, 0.5, 0.5]);
    const c = curvatureColors(k, "mean");
    expect(Array.from(c.slice(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(c.slice(3, 6))).toEqual([0, 0, 1]);
    expect(Array.from(c.slice(6, 9))).toEqual([1, 1, 1]);
    expect(c[9]).toBe(1); expect(c[10]).toBeCloseTo(0.5); expect(c[11]).toBeCloseTo(0.5);
    expect(curvatureColors(new Float32Array([2, 0.5]), "gaussian")[0]).toBe(1);
  });
});

describe("lens store", () => {
  it("keeps mode/shape/size/orient/position, and nothing about being shown (that is useUi.panels.lens)", () => {
    const s = useLens.getState();
    expect("on" in s).toBe(false);
    s.setMode("xray"); s.setShape("wipe"); s.setSize("L"); s.setOrient("back"); s.moveTo({ x: 10, y: 20, wipeX: 30 });
    expect(useLens.getState()).toMatchObject({ mode: "xray", shape: "wipe", size: "L", orient: "back", x: 10, y: 20, wipeX: 30 });
  });
});
