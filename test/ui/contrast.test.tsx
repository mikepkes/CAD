// WCAG AA in both themes for what the review measured (V10): the call to
// action's text, the edges of fields you type into or pick from (3:1 against
// every surface they sit on), the focus ring, and a sheet opaque enough to read.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const STYLES = read("../../src/styles.css");
const KIT = read("../../src/ui/kit/kit.css");
function tokens(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(selector + " {");
  const body = css.slice(at, css.indexOf("\n}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
function luminance(h: string) {
  const c = h.replace("#", "");
  const full = c.length === 3 ? [...c].map((x) => x + x).join("") : c;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** A rule's declarations, by its exact selector. */
const rule = (css: string, selector: string) => { const at = css.indexOf(`${selector} {`); expect(at, selector).toBeGreaterThanOrEqual(0); return css.slice(at, css.indexOf("}", at)); };

const themes = { dark: tokens(STYLES, ":root"), light: { ...tokens(STYLES, ":root"), ...tokens(STYLES, ':root[data-theme="light"]') } };
const resolve = (t: Record<string, string>, v: string): string => (v.startsWith("var(") ? resolve(t, t[v.slice(4, -1).trim()]) : v);

describe.each(Object.entries(themes))("%s theme", (_, t) => {
  const c = (k: string) => resolve(t, t[k]);
  it("Save's text reads on its fill at 4.5:1", () => {
    expect(contrast(c("--on-cta"), c("--cta"))).toBeGreaterThanOrEqual(4.5);
  });
  it("field edges are 3:1 against the panel, the raised panel and the field itself", () => {
    for (const s of ["--panel", "--panel-2", "--field"]) expect(contrast(c("--field-line"), c(s)), s).toBeGreaterThanOrEqual(3);
  });
  it("the focus ring is 3:1 against the surfaces", () => {
    for (const s of ["--panel", "--panel-2", "--bg"]) expect(contrast(c("--focus"), c(s)), s).toBeGreaterThanOrEqual(3);
  });
});

describe("where the tokens are used", () => {
  it("Save is filled with --cta, and the field edges use --field-line", () => {
    expect(rule(STYLES, ".cz-share")).toMatch(/background: var\(--cta\)/);
    expect(rule(STYLES, ".cz-share")).toMatch(/color: var\(--on-cta\)/);
    for (const sel of [".field-input", ".cz-select", ".cz-num"]) expect(rule(STYLES, sel)).toMatch(/var\(--field-line\)/);
    expect(rule(KIT, ".k-input, .k-select")).toMatch(/border: 1px solid var\(--field-line\)/);
  });
  it("everything the keyboard reaches shows a focus ring", () => {
    expect(STYLES).toMatch(/:where\(button, a, input, select, textarea, summary, \[tabindex\]\):focus-visible \{ outline: 2px solid var\(--focus\)/);
  });
  it("the viewer's sheet is opaque enough to read over the model", () => {
    const pct = Number(/color-mix\(in srgb, var\(--panel\) (\d+)%/.exec(rule(STYLES, ".cz-panel"))![1]);
    expect(pct).toBeGreaterThanOrEqual(92);
  });
});
