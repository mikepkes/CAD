import * as THREE from "three";

/**
 * Display-only see-through: bodies and sketches drawn at a lowered opacity, eased over time, without touching the
 * document (nothing re-evaluates, nothing rebuilds). The viewport tags what it draws with `userData.fadeKey` (a body's
 * id on its mesh and edges, a sketch's id on its group); a key's opacity applies to every drawn object under the
 * tagged one. A faded object draws with its own copy of its material (the shared, cached one stays as it was), put
 * back when it returns to full opacity; at zero it isn't drawn at all.
 */
export class Fades {
  private fades = new Map<string, { from: number; to: number; t0: number; ms: number }>();

  /** Fade `keys` from where they are now to `opacity` (0…1) over `ms` (eased in and out). */
  set(keys: Iterable<string>, opacity: number, ms: number, now: number) {
    const to = Math.min(1, Math.max(0, opacity));
    for (const k of keys) this.fades.set(k, { from: this.value(k, now), to, t0: now, ms: Math.max(0, ms) });
  }

  /** A key's opacity at `now` (1 when it was never faded). */
  value(key: string, now: number): number {
    const f = this.fades.get(key);
    if (!f) return 1;
    const k = f.ms > 0 ? Math.min(1, Math.max(0, (now - f.t0) / f.ms)) : 1;
    return f.from + (f.to - f.from) * k * k * (3 - 2 * k);
  }

  /** Whether a fade is still under way at `now` (the view must keep drawing). */
  running(now: number): boolean {
    for (const f of this.fades.values()) if (f.ms > 0 && now - f.t0 < f.ms) return true;
    return false;
  }

  /** Forget every fade (a new document's ids mean other things); the next `apply` puts everything back. */
  clear() { this.fades.clear(); }

  get size() { return this.fades.size; }

  /** Draw what's under `roots` at its keys' opacities now; forget fades that have finished back at full opacity. */
  apply(roots: THREE.Object3D[], now: number) {
    const walk = (o: THREE.Object3D, key: string | undefined) => {
      const own = o.userData.fadeKey as string | undefined;
      key = own ?? key;
      if (key != null && (o as THREE.Mesh).material) setOpacity(o as THREE.Mesh, this.value(key, now));
      for (const c of o.children) walk(c, key);
    };
    for (const r of roots) walk(r, undefined);
    for (const [k, f] of this.fades) if (f.to >= 1 && !(f.ms > 0 && now - f.t0 < f.ms)) this.fades.delete(k);
  }
}

/** A see-through copy of a material to fade: the same look, drawn in the transparent pass. */
export function fadeMaterial(orig: THREE.Material): THREE.Material {
  const m = orig.clone();
  // what `copy` leaves out: the shader patch (a procedural material: wood, a wrapped texture) and the live uniforms
  m.onBeforeCompile = orig.onBeforeCompile;
  m.customProgramCacheKey = orig.customProgramCacheKey;
  m.userData = { ...orig.userData, cached: false }; // the copy is its object's own: disposed with it
  // (not a fat line's: its opacity IS a uniform, so sharing them would fade the original too; the copy keeps its own)
  if ((orig as THREE.ShaderMaterial).isShaderMaterial && !(orig as { isLineMaterial?: boolean }).isLineMaterial) (m as THREE.ShaderMaterial).uniforms = (orig as THREE.ShaderMaterial).uniforms;
  m.transparent = true;
  return m;
}

/** Draw one object at `k` times its material's opacity: its own copy of the material while faded, its own again at 1. */
export function setOpacity(o: THREE.Mesh | THREE.LineSegments | THREE.Line, k: number) {
  const ud = o.userData;
  if (k >= 0.999) {
    if (ud.fadeOrig) { (o.material as THREE.Material).dispose(); o.material = ud.fadeOrig; delete ud.fadeOrig; }
    if (ud.fadeHidden) { o.visible = true; delete ud.fadeHidden; }
    return;
  }
  if (Array.isArray(o.material)) return;
  if (!ud.fadeOrig) {
    ud.fadeOrig = o.material;
    o.material = fadeMaterial(o.material as THREE.Material);
  }
  (o.material as THREE.Material).opacity = (ud.fadeOrig as THREE.Material).opacity * k;
  const shown = k > 0.002;
  if (!shown && o.visible) { o.visible = false; ud.fadeHidden = true; }
  else if (shown && ud.fadeHidden) { o.visible = true; delete ud.fadeHidden; }
}
