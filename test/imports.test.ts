import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";
import { realSession } from "./helpers";
import { initKernel, buildPrimitive, brepOfShape } from "../src/core/occ/kernel";
import { evaluateFeatures, exportFeatureBlob, SolidEval } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";
import { importRequests, fcstdBodies } from "../src/core/importers";
import { unzip } from "../src/util/zip";
import type { CadSession } from "../src/core/command/session";

// More import formats: OpenCASCADE BREP, STL (faceted), and FreeCAD documents
// (a ZIP of XML + BREP shapes), plus clear refusals for what we can't read.

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
const scopeOf = (s: CadSession) => resolveParameters(s.doc.parameters).scope;
const bodies = (s: CadSession): SolidEval[] => {
  const out = evaluateFeatures(s.doc, scopeOf(s));
  const errs = Object.values(out).filter((r) => r.error);
  if (errs.length) throw new Error(errs.map((r) => r.error).join("; "));
  return Object.values(out).filter((r) => r.mesh);
};
async function importInto(s: CadSession, name: string, bytes: Uint8Array) {
  const ids: string[] = [];
  for (const r of await importRequests(name, bytes)) {
    const res = await s.dispatch("feature.import", { data: r.data, format: r.format, name: r.name });
    if (!res.ok) throw new Error(res.error);
    ids.push(res.createdIds[0]);
  }
  return ids;
}

/** A ZIP built the way FreeCAD writes one (deflated entries). */
function zip(files: Record<string, string>, method: 0 | 8 = 8): Uint8Array {
  const enc = new TextEncoder();
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(enc.encode(text));
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameB = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameB, data); central.push(ch, nameB);
    offset += lh.length + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** A FreeCAD document: a visible Body (its tip shape), its Pad feature, a sketch, and a hidden part. */
function freecadDoc(): Uint8Array {
  const box = buildPrimitive({ shape: "box", at: { x: 0, y: 0, z: 5 }, x: 20, y: 10, z: 10 });
  const peg = buildPrimitive({ shape: "cylinder", at: { x: 40, y: 0, z: 0 }, radius: 3, height: 10 });
  const face = (box as unknown as { faces: { wrapped: unknown }[] }).faces[0];
  const doc = `<?xml version='1.0' encoding='utf-8'?>
<Document SchemaVersion="4" ProgramVersion="1.0.0" FileVersion="1">
  <Objects Count="4">
    <Object type="PartDesign::Body" name="Body" id="1"/>
    <Object type="PartDesign::Pad" name="Pad" id="2"/>
    <Object type="Sketcher::SketchObject" name="Sketch" id="3"/>
    <Object type="Part::Cylinder" name="Cylinder" id="4"/>
  </Objects>
  <ObjectData Count="4">
    <Object name="Body"><Properties Count="2">
      <Property name="Label" type="App::PropertyString"><String value="Bracket &amp; Co"/></Property>
      <Property name="Shape" type="Part::PropertyPartShape" status="1"><Part file="Body.Shape.brp"/></Property>
    </Properties></Object>
    <Object name="Pad"><Properties Count="1">
      <Property name="Shape" type="Part::PropertyPartShape"><Part file="Pad.Shape.brp"/></Property>
    </Properties></Object>
    <Object name="Sketch"><Properties Count="1">
      <Property name="Shape" type="Part::PropertyPartShape"><Part file="Sketch.Shape.brp"/></Property>
    </Properties></Object>
    <Object name="Cylinder"><Properties Count="1">
      <Property name="Shape" type="Part::PropertyPartShape"><Part file="Cylinder.Shape.brp"/></Property>
    </Properties></Object>
  </ObjectData>
</Document>`;
  const gui = `<?xml version='1.0' encoding='utf-8'?>
<Document SchemaVersion="1"><ViewProviderData Count="4">
  <ViewProvider name="Body" expanded="1"><Properties Count="1"><Property name="Visibility" type="App::PropertyBool"><Bool value="true"/></Property></Properties></ViewProvider>
  <ViewProvider name="Pad"><Properties Count="1"><Property name="Visibility" type="App::PropertyBool"><Bool value="true"/></Property></Properties></ViewProvider>
  <ViewProvider name="Sketch"><Properties Count="1"><Property name="Visibility" type="App::PropertyBool"><Bool value="true"/></Property></Properties></ViewProvider>
  <ViewProvider name="Cylinder"><Properties Count="1"><Property name="Visibility" type="App::PropertyBool"><Bool value="false"/></Property></Properties></ViewProvider>
</ViewProviderData></Document>`;
  return zip({
    "Document.xml": doc, "GuiDocument.xml": gui,
    "Body.Shape.brp": brepOfShape(box), "Pad.Shape.brp": brepOfShape(box),
    "Sketch.Shape.brp": brepOfShape(face), "Cylinder.Shape.brp": brepOfShape(peg),
  });
}

describe("imports: BREP, STL, FreeCAD", () => {
  beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

  it("reads stored and deflated ZIP entries", async () => {
    for (const method of [0, 8] as const) {
      const files = await unzip(zip({ "a.txt": "hello", "dir/b.txt": "x".repeat(5000) }, method));
      expect(new TextDecoder().decode(files["a.txt"])).toBe("hello");
      expect(files["dir/b.txt"].length).toBe(5000);
    }
    await expect(unzip(new Uint8Array(40))).rejects.toThrow(/not a ZIP/);
  });

  it("round-trips a part through BREP exactly", async () => {
    const shape = buildPrimitive({ shape: "torus", at: { x: 0, y: 0, z: 0 }, radius: 10, tube: 2 });
    const s = realSession();
    await importInto(s, "ring.brep", new TextEncoder().encode(brepOfShape(shape)));
    expect(bodies(s)[0].volume).toBeCloseTo(2 * Math.PI ** 2 * 10 * 4, 6);
  });

  it("imports an STL as a closed, faceted solid", async () => {
    const src = realSession();
    const id = (await src.dispatch("feature.primitive", { shape: "box", x: 30, y: 20, z: 10 })).createdIds[0];
    const stl = new Uint8Array(await exportFeatureBlob(src.doc, scopeOf(src), id, "stl")!.arrayBuffer());
    const s = realSession();
    const [imp] = await importInto(s, "block.stl", stl);
    const b = bodies(s)[0];
    expect(Math.abs(b.volume!)).toBeCloseTo(6000, 3);
    expect(s.doc.features[imp]).toMatchObject({ kind: "import", format: "stl", name: "block" });
  });

  it("takes each visible solid from a FreeCAD document, skipping PartDesign steps, sketches and hidden parts", async () => {
    const fc = freecadDoc();
    const found = await fcstdBodies(fc);
    expect(found.map((b) => b.name)).toEqual(["Body"]);
    expect(found[0].label).toBe("Bracket & Co");
    const s = realSession();
    const ids = await importInto(s, "bracket.FCStd", fc);
    expect(ids.length).toBe(1);
    expect(s.doc.features[ids[0]].name).toBe("Bracket & Co");
    expect(bodies(s)[0].volume).toBeCloseTo(2000, 6);
  });

  it("imports a Rhino .3dm mesh, converting its units to mm", async () => {
    const rhino = await (await import("rhino3dm")).default();
    const file = new rhino.File3dm();
    file.settings().modelUnitSystem = rhino.UnitSystem.Centimeters;
    const mesh = new rhino.Mesh();
    const vs = mesh.vertices();
    const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
    vs.setCount(8);
    corners.forEach((c, i) => vs.set(i, c));
    for (const q of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) mesh.faces().addQuadFace(q[0], q[1], q[2], q[3]);
    const attrs = new rhino.ObjectAttributes();
    attrs.name = "Cube";
    file.objects().addMesh(mesh, attrs);
    const s = realSession();
    const ids = await importInto(s, "cube.3dm", file.toByteArray());
    expect(s.doc.features[ids[0]].name).toBe("Cube");
    expect(Math.abs(bodies(s)[0].volume!)).toBeCloseTo(1000, 3); // a 1 cm cube
    // a binary STL whose header says "solid" and whose bytes all look like ASCII still reads as binary
    const [req] = await importRequests("cube.3dm", file.toByteArray());
    const stl = new Uint8Array(Buffer.from(req.data, "base64"));
    stl.set(new TextEncoder().encode("solid cube"), 0);
    const t = realSession();
    await importInto(t, "tricky.stl", stl);
    expect(Math.abs(bodies(t)[0].volume!)).toBeCloseTo(1000, 3);
    const empty = new rhino.File3dm();
    await expect(importRequests("empty.3dm", empty.toByteArray())).rejects.toThrow(/no solids, surfaces or meshes/);
  });

  it("imports Rhino Breps exactly: a NURBS sphere, a capped cylinder and a box, in cm", async () => {
    const rhino = await (await import("rhino3dm")).default();
    const file = new rhino.File3dm();
    file.settings().modelUnitSystem = rhino.UnitSystem.Centimeters;
    const named = (n: string) => { const a = new rhino.ObjectAttributes(); a.name = n; return a; };
    file.objects().addBrep(new rhino.Sphere([0, 0, 0], 1).toBrep(), named("Ball"));                                   // r 10 mm
    file.objects().addBrep(rhino.Brep.createFromCylinder(new rhino.Cylinder(new rhino.Circle(0.5), 2), true, true), named("Can")); // r 5, h 20 mm
    file.objects().addBrep(rhino.Brep.createFromBoundingBox(new rhino.BoundingBox([0, 0, 0], [3, 2, 1])), named("Box")); // 30×20×10 mm
    const reqs = await importRequests("parts.3dm", file.toByteArray());
    expect(reqs.map((r) => [r.name, r.format])).toEqual([["Ball", "nurbs"], ["Can", "nurbs"], ["Box", "nurbs"]]);
    const s = realSession();
    for (const r of reqs) expect((await s.dispatch("feature.import", { data: r.data, format: r.format, name: r.name })).ok).toBe(true);
    const by = Object.fromEntries(bodies(s).map((b) => [b.name, b]));
    const rel = (a: number, b: number) => Math.abs(a - b) / b;
    expect(by.Ball.surface).toBeUndefined();                              // closed: a solid, not a skin
    expect(rel(by.Ball.volume!, (4 / 3) * Math.PI * 1000)).toBeLessThan(1e-7);
    expect(rel(by.Ball.area!, 4 * Math.PI * 100)).toBeLessThan(1e-7);
    expect(rel(by.Can.volume!, Math.PI * 25 * 20)).toBeLessThan(1e-4);   // trimmed caps, fitted within the model tolerance
    expect(rel(by.Can.area!, 2 * Math.PI * 5 * 20 + 2 * Math.PI * 25)).toBeLessThan(1e-4);
    expect(by.Box.volume).toBeCloseTo(6000, 6);
    expect(by.Box.area).toBeCloseTo(2200, 6);
  });

  it("mixes exact Breps with meshes in one Rhino file", async () => {
    const rhino = await (await import("rhino3dm")).default();
    const file = new rhino.File3dm();
    file.objects().addBrep(new rhino.Sphere([0, 0, 0], 5).toBrep(), new rhino.ObjectAttributes());
    const mesh = new rhino.Mesh(); const vs = mesh.vertices(); vs.setCount(8);
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].forEach((c, i) => vs.set(i, c.map((x) => x * 10 + 20)));
    for (const q of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) mesh.faces().addQuadFace(q[0], q[1], q[2], q[3]);
    file.objects().addMesh(mesh, new rhino.ObjectAttributes());
    const reqs = await importRequests("mixed.3dm", file.toByteArray());
    expect(reqs.map((r) => r.format)).toEqual(["nurbs", "stl"]);
  });

  it("explains what it can't read", async () => {
    await expect(importRequests("part.iges", new Uint8Array(4))).rejects.toThrow(/no IGES reader/);
    await expect(importRequests("part.3dm", new Uint8Array(4))).rejects.toThrow(/Rhino/);
    await expect(importRequests("part.obj", new Uint8Array(4))).rejects.toThrow(/can't import \.obj/);
    const s = realSession();
    expect((await s.dispatch("feature.import", { format: "brep", data: "hello" })).error).toMatch(/not a BREP/);
  });
});
