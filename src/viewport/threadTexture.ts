// Procedural thread textures — the "cosmetic thread" appearance. A cosmetic
// thread is a plain cylinder (so the solid and its export stay simple); the
// thread is drawn by shading, via a normal map wrapped around the cylinder. The
// map bakes in the helix (the groove advances by the lead per turn) and takes
// its flank profile from the same thread section library the modelled threads
// use, so a metric V, an ACME trapezoid, a square groove and a ballscrew's
// round track each read correctly.

import * as THREE from "three";
import { ThreadForm, threadSection } from "../core/geometry/thread";
import type { ThreadDecal } from "../core/document";

/** A radial-height sampler h(a) for one pitch of the section (a in [-p/2, p/2]).
 *  rib → height ≥ 0 (material above the minor radius); groove → height ≤ 0. */
function heightSampler(form: ThreadForm, pitch: number, custom?: { x: number; y: number }[]): { h: (a: number) => number; depth: number; groove: boolean } {
  const sec = threadSection(form, pitch, { custom });
  const pts = sec.poly;
  const sign = sec.mode === "groove" ? -1 : 1;
  // Upper envelope of the tooth as an open polyline left-base → crest → right-base.
  const h = (a: number): number => {
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const lo = Math.min(p.a, q.a), hi = Math.max(p.a, q.a);
      if (a >= lo && a <= hi && hi > lo) {
        const t = (a - p.a) / (q.a - p.a);
        return sign * (p.r + t * (q.r - p.r));
      }
    }
    return 0; // flat (root) between teeth
  };
  return { h, depth: sec.depth, groove: sec.mode === "groove" };
}

/** Build a tangent-space normal map for a thread. It is exactly ONE lead tall
 *  (one full turn — `starts` grooves) and tiles seamlessly: the caller repeats
 *  it `length / lead` times up the cylinder via `texture.repeat`. Baking a
 *  single periodic tile at high resolution (rather than the whole length at low
 *  resolution) keeps every groove identical and evenly spaced — no quantisation
 *  jitter — and shows the true helix (the groove shears by one lead across the
 *  width). The flank slopes come from the thread-section library. */
export function makeThreadNormalMap(d: ThreadDecal): THREE.DataTexture {
  const starts = Math.max(1, Math.floor(d.starts ?? 1));
  const lead = d.pitch * starts;
  const dir = d.leftHand ? -1 : 1;
  const { h, depth } = heightSampler(d.form, d.pitch, d.profilePoints);
  const sinLead = Math.sin(Math.atan2(lead, 2 * Math.PI * Math.max(d.radius, 0.1))); // helix angle
  const flip = d.internal ? -1 : 1;

  const W = 512;                                   // around the cylinder (one turn)
  const H = Math.min(1024, 128 * starts);          // one lead tall, ~128 texels per pitch
  const data = new Uint8Array(W * H * 4);
  const da = d.pitch * 0.01;                        // slope sample step

  for (let j = 0; j < H; j++) {
    const axialLocal = (j / H) * lead;              // 0 .. lead within the tile
    for (let i = 0; i < W; i++) {
      const u = i / W;
      // Groove phase: advances by one lead per turn → sheared diagonally across
      // the tile; `mod pitch` yields the `starts` grooves per lead.
      const phase = axialLocal - dir * lead * u;
      const a = (((phase % d.pitch) + d.pitch) % d.pitch) - d.pitch / 2;
      const slope = (h(a + da) - h(a - da)) / (2 * da); // dh/da
      const inv2 = 1 / Math.hypot(1, slope);
      // Tangent space: x = circumferential (U), y = axial (V), z = radial (out).
      let ny = -slope * inv2 * flip;
      const nz = inv2;
      let nx = -ny * sinLead * dir;                 // flank tilts along the helix
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv;
      const k = (i + j * W) * 4;
      data[k] = Math.round((nx * 0.5 + 0.5) * 255);
      data[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[k + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping; // seamless around (shear over a turn = one lead)
  tex.wrapT = THREE.RepeatWrapping; // tiles up the length; the pattern is periodic in lead
  tex.repeat.set(1, d.length / lead);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  tex.userData = { depth };
  return tex;
}
