// The printable crease pattern (pure, no kernel): a 100 × 80 sheet with a valley folded
// in step 1, a mountain in step 2 and a slit, as SVG and as a true-size vector PDF.

import { describe, expect, it } from "vitest";
import { flatPatternSvg, flatPatternPdf, flatPatternDxf, stepLabels, type FlatPattern } from "../../src/core/sheet";

const pt = (x: number, y: number) => ({ x, y });
function card(): FlatPattern {
  const c = [pt(0, 0), pt(100, 0), pt(100, 80), pt(0, 80)];
  return {
    outline: c.map((a, i) => ({ kind: "line" as const, a, b: c[(i + 1) % 4] })),
    folds: [
      { id: "Valley", a: pt(50, 0), b: pt(50, 80), angle: 90, radius: 0, allowance: 0, step: 1 },
      { id: "Mountain", a: pt(0, 40), b: pt(100, 40), angle: -180, radius: 0, allowance: 0, step: 2 },
    ],
    cuts: [{ id: "Slit", a: pt(40, 20), b: pt(60, 20) }],
    min: pt(0, 0), max: pt(100, 80), thickness: 0.1, kFactor: 0.5,
  };
}

describe("crease pattern", () => {
  it("draws valley, mountain, cut and step numbers in the SVG at true size", () => {
    const svg = flatPatternSvg(card());
    expect(svg).toContain('class="valley"');
    expect(svg).toContain('class="mountain"');
    expect(svg).toMatch(/<line class="cut-line"[^>]*><title>Slit: cut<\/title>/);
    expect(svg).toContain(">1</text>");
    expect(svg).toContain(">2</text>");
    expect(svg).toContain('width="110mm" height="90mm" viewBox="0 0 110 90"'); // 5 mm margin each side
  });

  it("numbers a step once where its creases meet", () => {
    const fp = card();
    // the valley cut in two by the slit: two pieces, labels 40 mm apart, both get a number; a third piece on top of one does not
    fp.folds = [
      { id: "a", a: pt(50, 0), b: pt(50, 40), angle: 90, radius: 0, allowance: 0, step: 1 },
      { id: "b", a: pt(50, 40), b: pt(50, 80), angle: 90, radius: 0, allowance: 0, step: 1 },
      { id: "c", a: pt(50, 1), b: pt(50, 39), angle: 90, radius: 0, allowance: 0, step: 1 },
      { id: "d", a: pt(0, 40), b: pt(100, 40), angle: -90, radius: 0, allowance: 0 },
    ];
    expect(stepLabels(fp).map((l) => l.step)).toEqual([1, 1]);
  });

  it("writes a true-size vector PDF", () => {
    const pdf = flatPatternPdf(card(), "Pop-up (card)");
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text.startsWith("%PDF")).toBe(true);
    const W = ((100 + 20) * 72 / 25.4).toFixed(2), H = ((80 + 20) * 72 / 25.4).toFixed(2);
    expect(text).toContain(`/MediaBox [0 0 ${W} ${H}]`);
    expect(text).toContain("[3 1.5] 0 d");
    expect(text).toContain("[4 1 0.6 1] 0 d");
    expect(text).toContain("BT /F1");
    expect(text).toContain("(1) Tj");
    expect(text).toContain("(2) Tj");
    expect(text).toContain("(Pop-up \\(card\\)");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // the cross-reference table points at each object
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const offs = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(text.slice(o, o + 8)).toBe(`${i + 1} 0 obj\n`));
    // the content stream's /Length is its byte length
    const len = Number(/\/Length (\d+) >>\nstream\n/.exec(text)![1]);
    const start = text.indexOf("stream\n") + 7;
    expect(text.slice(start + len, start + len + 10)).toBe("\nendstream");
  });

  it("puts slits on the DXF's CUT layer", () => {
    const dxf = flatPatternDxf(card());
    expect(dxf.match(/\nLINE\n8\nCUT/g)!.length).toBe(5);
    expect(dxf.match(/\nLINE\n8\nBEND_UP/g)!.length).toBe(1);
    expect(dxf.match(/\nLINE\n8\nBEND_DOWN/g)!.length).toBe(1);
  });
});
