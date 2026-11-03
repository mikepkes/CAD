import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { Fades, fadeMaterial } from "../src/viewport/fade";

/** A body as the viewport draws it: a mesh and its edges, both tagged with the body's id; the materials are shared. */
function body(id: string, mat: THREE.Material, edge: THREE.Material) {
  const g = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(g, mat), lines = new THREE.LineSegments(g, edge);
  mesh.userData.fadeKey = id; lines.userData.fadeKey = id;
  return { mesh, lines };
}

describe("display fades", () => {
  it("eases a body out over its time, on its own copy of the shared material, then stops drawing it", () => {
    const shared = new THREE.MeshStandardMaterial(), edge = new THREE.LineBasicMaterial();
    const a = body("a", shared, edge), b = body("b", shared, edge);
    const root = new THREE.Group(); root.add(a.mesh, a.lines, b.mesh, b.lines);
    const f = new Fades();
    f.set(["a"], 0, 1000, 0);
    expect(f.running(500)).toBe(true);
    f.apply([root], 500);
    expect(a.mesh.material).not.toBe(shared);
    expect((a.mesh.material as THREE.Material).transparent).toBe(true);
    expect((a.mesh.material as THREE.Material).opacity).toBeCloseTo(0.5);
    expect((a.lines.material as THREE.Material).opacity).toBeCloseTo(0.5);
    expect(b.mesh.material).toBe(shared); // the other body, and the shared material, untouched
    expect(shared.opacity).toBe(1);
    expect(f.value("a", 250)).toBeGreaterThan(0.75); // eased: slow at the start
    f.apply([root], 1000);
    expect(f.running(1000)).toBe(false);
    expect(a.mesh.visible).toBe(false);
    expect(a.lines.visible).toBe(false);
  });

  it("fades back from wherever it is, and gives the body its own material back at full opacity", () => {
    const shared = new THREE.MeshStandardMaterial(), edge = new THREE.LineBasicMaterial();
    const a = body("a", shared, edge);
    const root = new THREE.Group(); root.add(a.mesh, a.lines);
    const f = new Fades();
    f.set(["a"], 0, 1000, 0);
    f.set(["a"], 1, 1000, 500); // turned round halfway
    expect(f.value("a", 500)).toBeCloseTo(0.5);
    f.apply([root], 1000);
    expect((a.mesh.material as THREE.Material).opacity).toBeCloseTo(0.75);
    f.apply([root], 1500);
    expect(a.mesh.material).toBe(shared);
    expect(a.lines.material).toBe(edge);
    expect(a.mesh.visible).toBe(true);
    expect(f.size).toBe(0); // finished back at full: forgotten
  });

  it("applies a sketch's key to everything drawn in its group, and clear puts everything back", () => {
    const sketch = new THREE.Group(); sketch.userData.fadeKey = "sk1";
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }));
    sketch.add(line);
    const root = new THREE.Group(); root.add(sketch);
    const f = new Fades();
    f.set(["sk1"], 0.5, 0, 0);
    f.apply([root], 0);
    expect((line.material as THREE.Material).opacity).toBeCloseTo(0.3); // its own opacity times the fade
    f.clear();
    f.apply([root], 1);
    expect((line.material as THREE.Material).opacity).toBeCloseTo(0.6);
  });

  it("keeps a procedural material's shader patch and live uniforms on the see-through copy", () => {
    const m = new THREE.MeshStandardMaterial();
    m.onBeforeCompile = () => {};
    m.userData = { cached: true, woodUniforms: { uAxis: { value: new THREE.Vector3(1, 0, 0) } } };
    const c = fadeMaterial(m);
    expect(c.onBeforeCompile).toBe(m.onBeforeCompile);
    expect(c.userData.woodUniforms).toBe(m.userData.woodUniforms);
    expect(c.userData.cached).toBe(false); // disposed with its object, unlike the cached original
    const s = new THREE.ShaderMaterial({ uniforms: { k: { value: 1 } } });
    expect((fadeMaterial(s) as THREE.ShaderMaterial).uniforms).toBe(s.uniforms);
  });

  it("fades a fat line (a sweep's guide) without fading its shared material", () => {
    const mat = new LineMaterial({ color: 0xffc24a, linewidth: 2.5, transparent: true, opacity: 0.9 });
    const line = new LineSegments2(new LineSegmentsGeometry().setPositions([0, 0, 0, 1, 0, 0]), mat);
    line.userData.fadeKey = "sketch1";
    const root = new THREE.Group(); root.add(line);
    const f = new Fades();
    f.set(["sketch1"], 0.5, 0, 0);
    f.apply([root], 0);
    expect(line.material).not.toBe(mat);
    expect((line.material as LineMaterial).opacity).toBeCloseTo(0.45);
    expect((line.material as LineMaterial).linewidth).toBe(2.5);
    expect(mat.opacity).toBeCloseTo(0.9); // the original keeps its own
    f.set(["sketch1"], 1, 0, 1);
    f.apply([root], 1);
    expect(line.material).toBe(mat);
    expect(mat.opacity).toBeCloseTo(0.9);
  });
});
