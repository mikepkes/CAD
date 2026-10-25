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

/** Build a tangent-space normal map that wraps once around the cylinder (U) and
 *  spans the threaded length (V), with the helix and flank slopes baked in. */
export function makeThreadNormalMap(d: ThreadDecal): THREE.DataTexture {
  const starts = Math.max(1, Math.floor(d.starts ?? 1));
  const lead = d.pitch * starts;
  const dir = d.leftHand ? -1 : 1;
  const { h, depth } = heightSampler(d.form, d.pitch, d.profilePoints);
  const leadAngle = Math.atan2(lead, 2 * Math.PI * Math.max(d.radius, 0.1)); // helix angle
  const sinLead = Math.sin(leadAngle);

  const W = 256;
  const H = Math.min(2048, Math.max(128, Math.round((d.length / d.pitch) * 16)));
  const data = new Uint8Array(W * H * 4);
  const da = d.pitch * 0.02; // slope sample step
  const flip = d.internal ? -1 : 1;

  for (let j = 0; j < H; j++) {
    const v = j / (H - 1);
    const axial = v * d.length;
    for (let i = 0; i < W; i++) {
      const u = i / W;
      // Phase along the groove: advances by the lead per full turn (the helix).
      const phase = axial - dir * lead * u;
      const a = ((((phase % d.pitch) + d.pitch) % d.pitch) - d.pitch / 2); // local axial in [-p/2, p/2]
      const slope = (h(a + da) - h(a - da)) / (2 * da); // dh/da
      // Tangent space: x = circumferential (U), y = axial (V), z = radial (out).
      let ny = (-slope / Math.hypot(1, slope)) * flip;
      const nz = 1 / Math.hypot(1, slope);
      let nx = -ny * sinLead * dir; // flank tilts slightly circumferentially along the helix
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv;
      const nzf = nz * inv;
      const k = (i + j * W) * 4;
      data[k] = Math.round((nx * 0.5 + 0.5) * 255);
      data[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[k + 2] = Math.round((nzf * 0.5 + 0.5) * 255);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;  // seamless around (lead is an integer number of pitches)
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  tex.userData = { depth };
  return tex;
}
