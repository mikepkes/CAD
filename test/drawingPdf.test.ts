// A design can publish its shop drawing (drawing.publish), and the sheet downloads as a one-page PDF.
import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { pdfWithImage, A4_LANDSCAPE } from "../src/ui/pdf";

describe("drawing.publish", () => {
  it("marks the design as having a drawing, titled, undoably; off withdraws it", async () => {
    const s = realSession();
    expect(s.doc.drawing).toBeUndefined();
    await s.dispatch("drawing.publish", { title: "Roubo workbench" });
    expect(s.doc.drawing).toEqual({ title: "Roubo workbench" });
    await s.dispatch("drawing.publish", { off: true });
    expect(s.doc.drawing).toBeUndefined();
    s.undo();
    expect(s.doc.drawing).toEqual({ title: "Roubo workbench" });
    await s.dispatch("drawing.publish", {});
    expect(s.doc.drawing?.title).toBe("Shop drawing");
  });
});

describe("the sheet as a PDF", () => {
  it("is one A4 landscape page with the image on it, and a valid cross-reference table", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]); // stands in for the JPEG bytes
    const pdf = pdfWithImage(jpeg, 3508, 2480, A4_LANDSCAPE.w, A4_LANDSCAPE.h, "Roubo (workbench)");
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 841.89 595.28]");
    expect(text).toContain("/Width 3508 /Height 2480");
    expect(text).toContain(`/Length ${jpeg.length}`);
    expect(text).toContain("/Title (Roubo \\(workbench\\))");
    // every xref offset points at its "n 0 obj"
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const offs = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offs).toHaveLength(6);
    offs.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});
