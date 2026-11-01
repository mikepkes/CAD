// The viewer frames the model in what its controls leave uncovered (V9), and
// reduced motion is respected (V14): camera moves cut, CSS animations stop.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fitTangent } from "../../src/viewport/orbitCamera";
import { coveredBy } from "../../src/ui/CustomizeApp";
import { prefersReducedMotion } from "../../src/viewport/motion";

const tan = (deg: number) => Math.tan((deg * Math.PI) / 360);

describe("framing into the free area (V9)", () => {
  it("a landscape view with nothing over it frames by the vertical field of view, as before", () => {
    expect(fitTangent(45, 1440, 900)).toBeCloseTo(tan(45));
  });
  it("a portrait phone frames by the narrower, horizontal field", () => {
    expect(fitTangent(45, 390, 844)).toBeCloseTo(tan(45) * (390 / 844));
  });
  it("the sheet over the bottom, or the card on the right, shrinks the area to fill", () => {
    // 390×844 with a 450 px sheet: 394 px left above it, less than the width allows
    expect(fitTangent(45, 390, 844, { bottom: 450 })).toBeCloseTo(tan(45) * (394 / 844));
    // a 314 px card on a 1440×900 desktop: still the height that decides
    expect(fitTangent(45, 1440, 900, { right: 314 })).toBeCloseTo(tan(45));
    expect(fitTangent(45, 1000, 900, { right: 314 })).toBeCloseTo(tan(45) * (1000 / 900) * (686 / 1000));
  });
  it("measures what the controls cover: the sheet's height on a phone, the card's width on a desktop", () => {
    const rect = (left: number, top: number) => ({ left, top } as DOMRect);
    expect(coveredBy(rect(8, 394), { width: 390, height: 844 }, true)).toEqual({ right: 0, bottom: 450 });
    expect(coveredBy(rect(1126, 14), { width: 1440, height: 900 }, false)).toEqual({ right: 314, bottom: 0 });
  });
});

describe("reduced motion (V14)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is read from the system setting", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" }));
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
  it("stops CSS animations and transitions, and the camera's own moves cut", () => {
    const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    const css = read("../../src/styles.css");
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/animation-duration: 0\.01ms !important/);
    expect(block).toMatch(/transition-duration: 0\.01ms !important/);
    const scene = read("../../src/viewport/SceneManager.ts");
    expect(scene).toMatch(/spec\.dur \?\? \(prefersReducedMotion\(\) \? 0\.001 : 0\.5\)/);
    expect(scene).toMatch(/enableDamping = !prefersReducedMotion\(\)/);
  });
});
