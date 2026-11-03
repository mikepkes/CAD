import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { deserializeDocument } from "../src/core/persistence";
import { resolveParameters } from "../src/core/parameters";
import { cutList, viewSegments, drawingSheetSVG, sheetLayout, drawingModel } from "../src/core/drawings";
import { evaluateFeatures, GeometryCache } from "../src/core/features";
import { placeComponentSketches } from "../src/core/recompute";
import type { CadSession } from "../src/core/command/session";

const OUT = process.env.BUILD_DRAWING || "";
const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));

async function dis(s: CadSession, type: string, params: Record<string, unknown>): Promise<string[]> {
  const r = await s.dispatch(type, params);
  if (!r.ok) throw new Error(`${type}: ${r.error}`);
  return r.createdIds ?? [];
}

async function board(s: CadSession, name: string, w: number, d: number, t: number) {
  const cmp = (await dis(s, "component.create", { name }))[0];
  const sk = (await dis(s, "sketch.create", { plane: "XY", component: cmp }))[0];
  await dis(s, "sketch.addRectangle", { sketch: sk, corner: { x: 0, y: 0 }, opposite: { x: w, y: d } });
  await dis(s, "feature.extrude", { sketch: sk, distance: String(t) });
  return cmp;
}

describe("shop drawings (cut list + orthographic views)", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("groups identical parts and reports true finished dimensions", async () => {
    const s = realSession();
    const oak = (await dis(s, "material.create", { name: "White Oak", kind: "wood", species: "white-oak" }))[0];
    await dis(s, "material.assign", { material: oak });
    await board(s, "Shelf 1", 600, 200, 18);
    await board(s, "Shelf 2", 600, 200, 18);
    await board(s, "Leg 1", 60, 60, 700);
    await s.recompute();

    const scope = resolveParameters(s.doc.parameters).scope;
    const rows = cutList(s.doc, scope);

    const shelf = rows.find((r) => r.part === "Shelf");
    expect(shelf).toBeTruthy();
    expect(shelf!.qty).toBe(2);                 // two identical shelves grouped
    expect([shelf!.thickness, shelf!.width, shelf!.length]).toEqual([18, 200, 600]);
    expect(shelf!.material).toBe("White Oak");

    const leg = rows.find((r) => r.part === "Leg");
    expect(leg!.qty).toBe(1);
    expect([leg!.thickness, leg!.width, leg!.length]).toEqual([60, 60, 700]);

    // wood sorts longest-first
    expect(rows[0].part).toBe("Leg");
  });

  it("builds a cut list and a drawing sheet from the beech Roubo example", async () => {
    const json = readFileSync(fileURLToPath(new URL("../public/examples/roubo.json", import.meta.url)), "utf8");
    const s = sessionFromDoc(deserializeDocument(json)); // replay the operation recipe
    await s.recompute();
    const doc = s.doc;
    const scope = resolveParameters(doc.parameters).scope;
    // built once, through a cache the drawing's model (its dimensions and section) replays
    const cache = new GeometryCache();
    placeComponentSketches(doc, scope);
    const built = evaluateFeatures(doc, scope, cache);

    const rows = cutList(doc, scope, built);
    // the main lumber is present and correctly grouped
    const top = rows.find((r) => r.part === "Top");
    const leg = rows.find((r) => r.part === "Leg");
    expect(top?.qty).toBe(4);
    expect(leg?.qty).toBe(4);
    expect(leg?.material).toBe("Beech");
    // a long top board is the longest part
    expect(rows[0].length).toBeGreaterThan(1000);

    // orthographic views produce real geometry
    const front = viewSegments(doc, scope, "front", built);
    expect(front.length).toBeGreaterThan(50);

    const svg = drawingSheetSVG(doc, scope, { title: "Roubo Workbench", units: "mm" }, built, drawingModel(doc, scope, cache));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Cut list");
    expect(svg).toContain("Front");
    // the example's placed dimensions, its section across the vise leg and the detail of the tenon, none broken
    expect(svg.match(/<g class="dim" data-dim=/g)?.length).toBe(10);
    expect(svg).not.toContain("dim-broken");
    expect(svg).toContain("SECTION A–A");
    expect(svg).toContain('<g class="hatch"');
    expect(svg).toContain("DETAIL B (2.5×)");
    // the sheet is used across its width, not only its left half: the views from the left margin, the long cut
    // list in a column at the right
    const views = [...svg.matchAll(/<line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)"[^>]*stroke-width="0.6"/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
    const rules = [...svg.matchAll(/<line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)"[^>]*stroke-width="(1|0.5)"/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
    expect(Math.min(...views)).toBeLessThan(0.1 * 1120);
    expect(Math.max(...rules) - Math.min(...views)).toBeGreaterThan(0.85 * 1120);
    if (OUT) { writeFileSync(`${OUT}/roubo.drawing.svg`, svg); console.log(`drawing written: ${rows.length} part types`); }
  });
});

describe("sheet layout", () => {
  const base = { sheet: { w: 1120, h: 790 }, margin: 30, gap: 40, titleH: 44 };
  const tableH = (rows: number) => 18 + 24 + (rows + 1) * 18 + 10;
  it("puts a long cut list where the views come out largest, here the corner third-angle leaves empty", () => {
    const views = { fW: 1700, fH: 850, rW: 700, tH: 700 };
    const l = sheetLayout({ ...base, tableH: tableH(16), views });
    expect(l.table.place).toBe("corner");
    // the table sits right of the top view and above the right view, inside the sheet
    expect(l.table.x).toBeCloseTo(l.right.x, 6);
    expect(l.table.x + l.table.w).toBeLessThanOrEqual(1120 - 30 + 0.001);
    expect(l.table.y).toBeLessThan(l.right.y);
    // the views end up larger than with the list squeezed under them
    const below = (790 - 60 - 44 - tableH(16) - 40 - 40) / (850 + 700);
    expect(l.scale).toBeGreaterThan(below * 1.3);
  });
  it("keeps a short list under the views, and centres the views across the sheet", () => {
    const l = sheetLayout({ ...base, tableH: tableH(2), views: { fW: 1000, fH: 300, rW: 0, tH: 0 } });
    expect(l.table.place).toBe("below");
    const w = 1000 * l.scale;
    expect(l.front.x - 30).toBeCloseTo(1120 - 30 - (l.front.x + w), 6);
  });
});
