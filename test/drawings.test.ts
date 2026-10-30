import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession, sessionFromDoc } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { deserializeDocument } from "../src/core/persistence";
import { resolveParameters } from "../src/core/parameters";
import { cutList, viewSegments, drawingSheetSVG } from "../src/core/drawings";
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

    const rows = cutList(doc, scope);
    // the main lumber is present and correctly grouped
    const top = rows.find((r) => r.part === "Top");
    const leg = rows.find((r) => r.part === "Leg");
    expect(top?.qty).toBe(4);
    expect(leg?.qty).toBe(4);
    expect(leg?.material).toBe("Beech");
    // a long top board is the longest part
    expect(rows[0].length).toBeGreaterThan(1000);

    // orthographic views produce real geometry
    const front = viewSegments(doc, scope, "front");
    expect(front.length).toBeGreaterThan(50);

    const svg = drawingSheetSVG(doc, scope, { title: "Roubo Workbench", units: "mm" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Cut list");
    expect(svg).toContain("Front");
    if (OUT) { writeFileSync(`${OUT}/roubo.drawing.svg`, svg); console.log(`drawing written: ${rows.length} part types`); }
  });
});
