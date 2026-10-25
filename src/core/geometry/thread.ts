// Thread profiles — the axial cross-section of one thread, as a function of the
// pitch, for every standard form plus ballscrew and a custom profile. Pure
// geometry (no kernel): the OCC side sweeps this section along a helix. The
// section is kept under one pitch tall axially so adjacent turns never collide
// (which makes the helical boolean robust).

export type ThreadForm = "metric" | "unified" | "acme" | "trapezoidal" | "square" | "buttress" | "ballscrew" | "custom";

export interface ThreadSection {
  /** Radial thread height (crest − root). */
  depth: number;
  /** "rib" = material added outward from the minor radius (swept + fused to a
   *  minor-diameter core); "groove" = material cut inward from the major radius
   *  (swept + cut from a major-diameter shaft, e.g. a ballscrew's ball track). */
  mode: "rib" | "groove";
  /** Closed section: a = axial (centred on 0, |a| < pitch/2), r = radial offset
   *  (rib: 0 at the minor radius → depth at the crest; groove: 0 at the major
   *  radius → depth inward). */
  poly: { a: number; r: number }[];
}

const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);

/** A symmetric trapezoidal tooth: flanks at `halfAngle` from radial, a flat crest. */
function trapezoid(pitch: number, depth: number, halfAngleDeg: number, crestFrac: number): ThreadSection {
  const crest = crestFrac * pitch;
  const run = depth * tan(halfAngleDeg);           // axial run of each flank
  const ext = Math.min(2 * run + crest, 0.96 * pitch); // keep under a pitch
  const c = Math.min(crest, ext);
  const flank = (ext - c) / 2;
  return {
    depth, mode: "rib",
    poly: [
      { a: -(c / 2 + flank), r: 0 },
      { a: -c / 2, r: depth },
      { a: c / 2, r: depth },
      { a: c / 2 + flank, r: 0 },
    ],
  };
}

/** The thread section for a form + pitch. `depth` / `custom` override as needed. */
export function threadSection(form: ThreadForm, pitch: number, opts: { depth?: number; custom?: { x: number; y: number }[] } = {}): ThreadSection {
  switch (form) {
    case "metric":
    case "unified":
      return trapezoid(pitch, opts.depth ?? 0.6134 * pitch, 30, 0.125); // 60° included
    case "trapezoidal":
      return trapezoid(pitch, opts.depth ?? 0.5 * pitch, 15, 0.366);    // 30° included
    case "acme":
      return trapezoid(pitch, opts.depth ?? 0.5 * pitch, 14.5, 0.3707); // 29° included
    case "square": {
      const depth = opts.depth ?? 0.5 * pitch, w = 0.5 * pitch;
      return { depth, mode: "rib", poly: [{ a: -w / 2, r: 0 }, { a: -w / 2, r: depth }, { a: w / 2, r: depth }, { a: w / 2, r: 0 }] };
    }
    case "buttress": {
      // Asymmetric: a near-radial 7° load flank, a 45° trailing flank.
      const depth = opts.depth ?? 0.5 * pitch, crest = 0.12 * pitch;
      const run1 = depth * tan(7), run2 = depth * tan(45);
      const ext = Math.min(run1 + crest + run2, 0.96 * pitch);
      const c = Math.max(0.02 * pitch, crest - Math.max(0, run1 + crest + run2 - ext));
      return {
        depth, mode: "rib",
        poly: [
          { a: -(run1 + c / 2), r: 0 },
          { a: -c / 2, r: depth },
          { a: c / 2, r: depth },
          { a: c / 2 + run2, r: 0 },
        ],
      };
    }
    case "ballscrew": {
      // A circular ball groove cut into the shaft; depth ≈ its radius.
      const rg = (opts.depth ?? 0.31 * pitch);
      const n = 12;
      const poly: { a: number; r: number }[] = [];
      for (let i = 0; i <= n; i++) {
        const t = -Math.PI / 2 + (Math.PI * i) / n; // a semicircle opening toward the surface
        poly.push({ a: rg * Math.cos(t), r: rg + rg * Math.sin(t) });
      }
      return { depth: rg, mode: "groove", poly };
    }
    case "custom": {
      const pts = opts.custom ?? [];
      if (pts.length < 3) throw new Error("custom thread needs at least 3 profilePoints");
      const depth = Math.max(...pts.map((p) => Math.abs(p.x)));
      return { depth, mode: "rib", poly: pts.map((p) => ({ a: p.y, r: Math.abs(p.x) })) };
    }
  }
}

/** Lead = axial advance per full turn (pitch × starts). */
export const threadLead = (pitch: number, starts = 1) => pitch * Math.max(1, Math.floor(starts));
