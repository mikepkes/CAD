// The material library the Materials tab adds from: real-world finishes with
// plausible colours (metals are their reflectance, so brighter than you'd
// guess) and, for prints and rubber, the mechanical properties the strain
// studies use. Each is exactly a material.create call.

export interface MaterialPreset {
  name: string;
  group: "Metal" | "Plastic" | "3D print" | "Rubber" | "Paint" | "Wood" | "Paper";
  params: Record<string, unknown>;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { group: "Metal", name: "Polished brass", params: { kind: "metal", finish: "polished", color: "#e3c46e" } },
  { group: "Metal", name: "Bronze", params: { kind: "metal", finish: "satin", color: "#caa07c" } },
  { group: "Metal", name: "Brushed steel", params: { kind: "metal", finish: "brushed", color: "#c9cdd2", textureAxis: "x" } },
  { group: "Metal", name: "Aluminium", params: { kind: "metal", finish: "satin", color: "#d8dbde", roughness: 0.32 } },
  { group: "Metal", name: "Chrome", params: { kind: "metal", finish: "polished", color: "#f0f1f3", roughness: 0.04 } },
  { group: "Metal", name: "Copper", params: { kind: "metal", finish: "polished", color: "#eda57c" } },
  { group: "Metal", name: "Gold", params: { kind: "metal", finish: "polished", color: "#f6d06e" } },
  { group: "Metal", name: "Cast iron", params: { kind: "metal", finish: "matte", color: "#6a6c70", roughness: 0.55 } },
  { group: "Metal", name: "Black anodised", params: { kind: "metal", finish: "satin", color: "#34363b", roughness: 0.36 } },
  { group: "Plastic", name: "Gloss ABS", params: { kind: "plastic", finish: "gloss", color: "#f2f1ee" } },
  { group: "Plastic", name: "Matte black", params: { kind: "plastic", finish: "matte", color: "#202124" } },
  { group: "3D print", name: "PLA", params: { kind: "printed", finish: "satin", color: "#e8e4dc", layerHeight: 0.2, printAxis: "z", youngsModulus: 3500, allowableStrain: 0.02, layerFactor: 0.5 } },
  { group: "3D print", name: "PETG", params: { kind: "printed", finish: "silk", color: "#3a78c9", layerHeight: 0.2, printAxis: "z", youngsModulus: 2100, allowableStrain: 0.035, layerFactor: 0.6 } },
  { group: "3D print", name: "Silk PLA", params: { kind: "printed", finish: "silk", color: "#d8b25a", layerHeight: 0.16, printAxis: "z", youngsModulus: 3000, allowableStrain: 0.02, layerFactor: 0.5 } },
  { group: "3D print", name: "TPU", params: { kind: "printed", finish: "matte", color: "#2b2d31", layerHeight: 0.2, printAxis: "z", youngsModulus: 26, allowableStrain: 0.3, layerFactor: 0.8 } },
  { group: "Rubber", name: "Black rubber", params: { kind: "rubber", color: "#232427" } },
  { group: "Rubber", name: "Grip rubber", params: { kind: "rubber", color: "#26282b", texture: "knurl", textureScale: 2 } },
  { group: "Rubber", name: "Ribbed rubber", params: { kind: "rubber", color: "#2a2b2e", texture: "ribs", textureScale: 2.5, textureAxis: "x" } },
  { group: "Paint", name: "Red paint", params: { kind: "painted", color: "#b8322c" } },
  { group: "Paint", name: "Satin black", params: { kind: "painted", finish: "matte", color: "#1e1f22" } },
  { group: "Wood", name: "Oak", params: { kind: "wood", species: "white-oak" } },
  { group: "Wood", name: "Walnut", params: { kind: "wood", species: "walnut" } },
  { group: "Wood", name: "Maple", params: { kind: "wood", species: "maple" } },
];
