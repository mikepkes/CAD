// Print materials for flat-printed flexure hinges, shared by the compliant
// examples (four-bar, gripper, bistable switch). Each hinge is a strip that
// bends IN the print layers. Its peak strain is ε = t·φ/2L, so per material the
// strip is sized to stay at ~80% of that material's limit when it turns ~21°:
// stiff plastics get the thinnest strip that prints well (0.8 mm, two
// perimeters) and a longer one; strain-tolerant ones keep the short 1 mm strip.
// Hinge stiffness k = E·w·t³/12L then lands within 2× of the TPU part's for
// every one but soft TPU 95A, which gets a thicker strip so it still springs
// back. Typical FDM values in the layer plane (E, MPa; strain limit for repeated
// flexing): tune to your filament. PLA hinges fatigue: expect hundreds of
// flexes, not thousands.

export type HingeMaterial = { name: string; E: number; strain: number; t: number; L: number; color: string; finish: string };

export const HINGE_MATERIALS: HingeMaterial[] = [
  { name: "PLA", E: 3000, strain: 0.02, t: 0.8, L: 8.5, color: "#5b8def", finish: "matte" },
  { name: "PETG", E: 1900, strain: 0.03, t: 0.8, L: 6, color: "#3fb6a8", finish: "gloss" },
  { name: "ABS / ASA", E: 2000, strain: 0.025, t: 0.8, L: 7, color: "#e05a4f", finish: "satin" },
  { name: "Nylon", E: 1200, strain: 0.05, t: 1, L: 4.5, color: "#e8e2d0", finish: "satin" },
  { name: "PP (polypropylene)", E: 1000, strain: 0.1, t: 1, L: 4, color: "#d9dde3", finish: "satin" },
  // Bambu "TPU for AMS" printed flat: E from the datasheet; 8% is a conservative
  // service limit (elongation at break is > 650%).
  { name: "TPU 68D (TPU for AMS)", E: 1190, strain: 0.08, t: 1, L: 4, color: "#e9b949", finish: "matte" },
  { name: "TPU 95A", E: 26, strain: 0.15, t: 2.4, L: 4, color: "#f28c4e", finish: "matte" },
];
export const DEFAULT_HINGE_MATERIAL = 5; // TPU 68D

export const num = (v: number) => String(Number(v.toPrecision(12)));

/** `pick(material, …)` of one value per material. */
export const pickBy = (f: (m: HingeMaterial) => number, list: HingeMaterial[] = HINGE_MATERIALS) => `pick(material, ${list.map((m) => num(f(m))).join(", ")})`;
