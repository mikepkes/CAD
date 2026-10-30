/// <reference path="../rhino3dm-module.d.ts" />
// File import: turn a file (name + bytes) into feature.import requests, by
// type. STEP and BREP are text the kernel reads directly; STL is passed as
// base64; a FreeCAD document (.FCStd, a ZIP) yields the BREP shape of each
// visible solid it holds. Async because unzipping is; evaluation stays sync.

import { unzip } from "../util/zip";

export interface ImportRequest {
  name: string;
  format: "step" | "brep" | "stl";
  data: string;
}

const stem = (fileName: string) => (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.[^.]+$/, "") || "Imported";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface ImportOptions {
  /** Where rhino3dm's wasm is served from (a bundler URL); Node finds it beside the module. */
  rhino3dmWasmUrl?: string;
}

/** What `fileName` imports as; throws with a useful reason for formats we can't read. */
export async function importRequests(fileName: string, bytes: Uint8Array, opts: ImportOptions = {}): Promise<ImportRequest[]> {
  const ext = (fileName.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  const text = () => new TextDecoder().decode(bytes);
  switch (ext) {
    case "step": case "stp": return [{ name: stem(fileName), format: "step", data: text() }];
    case "brep": case "brp": return [{ name: stem(fileName), format: "brep", data: text() }];
    case "stl": return [{ name: stem(fileName), format: "stl", data: toBase64(bytes) }];
    case "fcstd": {
      const bodies = await fcstdBodies(bytes);
      if (!bodies.length) throw new Error("the FreeCAD file has no visible solid to import");
      return bodies.map((b) => ({ name: b.label, format: "brep" as const, data: b.brep }));
    }
    case "igs": case "iges":
      throw new Error("IGES can't be read yet: this build of OpenCASCADE has no IGES reader. Export STEP from the source program instead.");
    case "3dm": {
      const parts = await rhinoMeshes(bytes, opts.rhino3dmWasmUrl);
      if (!parts.length) throw new Error("the Rhino file has no meshes to import — save it in Rhino with render meshes (the default), or export STEP");
      return parts.map((m) => ({ name: m.name, format: "stl" as const, data: toBase64(m.stl) }));
    }
    default:
      throw new Error(`can't import .${ext || "?"} files (STEP, BREP, STL and FreeCAD .FCStd are supported)`);
  }
}

/** Millimetres per model unit, for the Rhino unit systems a CAD file uses. */
const RHINO_MM: Record<string, number> = {
  Millimeters: 1, Centimeters: 10, Decimeters: 100, Meters: 1000, Microns: 1e-3, Inches: 25.4, Feet: 304.8, Yards: 914.4, Mils: 0.0254, Microinches: 2.54e-5,
};

/** A binary STL of triangles (flat xyz triples, already in mm). */
function stlBytes(tris: number[]): Uint8Array {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12; // normal left zero: readers recompute it
    for (let k = 0; k < 9; k++) dv.setFloat32(o + k * 4, tris[t * 9 + k], true);
  }
  return new Uint8Array(buf);
}

type RhinoMesh = { vertices(): { count: number; get(i: number): number[] }; faces(): { count: number; get(i: number): number[] }; delete?(): void };

/**
 * The meshes of a Rhino file, one per object, as binary STLs in mm. A mesh
 * object is taken as is; a Brep or extrusion contributes the render mesh Rhino
 * saved with each face (rhino3dm can read meshes but not re-mesh NURBS), so a
 * file saved without render meshes yields nothing.
 */
async function rhinoMeshes(bytes: Uint8Array, wasmUrl?: string): Promise<{ name: string; stl: Uint8Array }[]> {
  const rhino3dm = (await import("rhino3dm/rhino3dm.module.js")).default; // the ESM build (no CommonJS requires)
  const rhino = await rhino3dm(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  const file = rhino.File3dm.fromByteArray(bytes);
  if (!file) throw new Error("not a readable Rhino .3dm file");
  const unit = Object.entries(rhino.UnitSystem).find(([, v]) => v === file.settings().modelUnitSystem)?.[0] ?? "Millimeters";
  const mm = RHINO_MM[unit];
  if (mm === undefined) throw new Error(`the Rhino file's unit system (${unit}) isn't supported`);
  const out: { name: string; stl: Uint8Array }[] = [];
  const objects = file.objects();
  for (let i = 0; i < objects.count; i++) {
    const obj = objects.get(i);
    const g = obj.geometry() as unknown as { objectType: unknown; faces?: () => { count: number; get(i: number): { getMesh(t: unknown): RhinoMesh | null } }; getMesh?(t: unknown): RhinoMesh | null };
    const meshes: RhinoMesh[] = [];
    if (g.objectType === rhino.ObjectType.Mesh) meshes.push(g as unknown as RhinoMesh);
    else if (g.objectType === rhino.ObjectType.Brep && g.faces) {
      const faces = g.faces();
      for (let f = 0; f < faces.count; f++) { const m = faces.get(f).getMesh(rhino.MeshType.Any); if (m) meshes.push(m); }
    } else if (g.objectType === rhino.ObjectType.Extrusion && g.getMesh) {
      const m = g.getMesh(rhino.MeshType.Any); if (m) meshes.push(m);
    }
    const tris: number[] = [];
    for (const m of meshes) {
      const vs = m.vertices(), fs = m.faces();
      const v = (k: number) => vs.get(k).map((c) => c * mm);
      for (let f = 0; f < fs.count; f++) {
        const [a, b, c, d] = fs.get(f);
        tris.push(...v(a), ...v(b), ...v(c));
        if (d !== c) tris.push(...v(a), ...v(c), ...v(d)); // a quad
      }
    }
    if (tris.length) out.push({ name: obj.attributes().name || `Rhino object ${i + 1}`, stl: stlBytes(tris) });
  }
  return out;
}

/** One <Object name="…"> … </Object> block's body per object name. */
function objectBlocks(xml: string, section: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = xml.match(new RegExp(`<${section}[^>]*>([\\s\\S]*?)</${section}>`))?.[1] ?? "";
  const re = /<(Object|ViewProvider)\s+name="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of body.matchAll(re)) out.set(m[2], m[3] ?? "");
  return out;
}

const decodeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const boolProp = (block: string, name: string): boolean | undefined => {
  const m = block.match(new RegExp(`<Property name="${name}"[^>]*>\\s*<Bool value="(true|false)"`));
  return m ? m[1] === "true" : undefined;
};

/**
 * The shapes of a FreeCAD document worth importing: each visible object whose
 * stored shape (a BREP file in the archive) contains a solid. Inside a
 * PartDesign Body only the Body itself is taken (its shape is its tip), so the
 * intermediate features aren't imported as copies.
 */
export async function fcstdBodies(bytes: Uint8Array): Promise<{ name: string; label: string; brep: string }[]> {
  const files = await unzip(bytes);
  const docXml = files["Document.xml"] && new TextDecoder().decode(files["Document.xml"]);
  if (!docXml) throw new Error("not a FreeCAD document (no Document.xml)");
  const guiXml = files["GuiDocument.xml"] ? new TextDecoder().decode(files["GuiDocument.xml"]) : "";
  const types = new Map<string, string>();
  for (const m of docXml.matchAll(/<Object\s+type="([^"]+)"\s+name="([^"]+)"/g)) types.set(m[2], m[1]);
  const data = objectBlocks(docXml, "ObjectData");
  const views = objectBlocks(guiXml, "ViewProviderData");
  const hasBody = [...types.values()].includes("PartDesign::Body");
  const out: { name: string; label: string; brep: string }[] = [];
  for (const [name, block] of data) {
    const file = block.match(/<Property name="Shape"[^>]*>\s*<Part\s+file="([^"]+)"/)?.[1];
    if (!file || !files[file]) continue;
    const type = types.get(name) ?? "";
    if (hasBody && type.startsWith("PartDesign::") && type !== "PartDesign::Body") continue;
    const visible = boolProp(views.get(name) ?? "", "Visibility") ?? boolProp(block, "Visibility") ?? true;
    if (!visible) continue;
    const brep = new TextDecoder().decode(files[file]);
    if (!/CASCADE Topology/.test(brep.slice(0, 200)) || !/\nSo\b/.test(brep)) continue; // binary, or no solid (a sketch)
    const label = decodeXml(block.match(/<Property name="Label"[^>]*>\s*<String value="([^"]*)"/)?.[1] ?? name);
    out.push({ name, label, brep });
  }
  return out;
}
