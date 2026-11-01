// The 3D viewport's colours, per theme. SceneManager reads the active palette
// (`viewportColors()`) every time it builds scene objects and repaints when the
// theme changes (`onViewportTheme`); theme.ts sets it. Materials, analysis
// shaders and the lens keep their own colours (they describe the part, not the
// chrome), except the x-ray's edge lines, which must contrast with the background. Values that mirror a CSS token say so; change both together.

export type ViewportTheme = "light" | "dark";

export interface ViewportPalette {
  /** Scene background (mirrors --bg). */
  bg: number;
  grid: number;
  gridMajor: number;
  /** Axis lines X, Y, Z. */
  axisX: number;
  axisY: number;
  axisZ: number;
  /** Other (non-active) sketches, drawn dimmed. */
  ghost: number;
  /** A compared design variant (mirrors the kit's --k-ghost). */
  variant: number;
  /** Fully constrained sketch geometry. */
  geometry: number;
  /** Under-constrained sketch geometry (Fusion-style blue). */
  underConstrained: number;
  profileFill: number;
  construction: number;
  selected: number;
  hover: number;
  /** Fixed sketch points. */
  point: number;
  /** The sketch origin point and snap markers. */
  origin: number;
  /** Dimension lines, and their labels' text (CSS colour). */
  dimension: number;
  dimensionText: string;
  /** Geometric-constraint glyphs (CSS colour). */
  badgeText: string;
  /** Text-sprite plate behind dimension labels and glyphs (CSS colour). */
  labelBg: string;
  /** Rubber-band preview of the curve being drawn. */
  preview: number;
  /** Conflicting sketch geometry. */
  bad: number;
  /** Extrude: preview / handle colours for adding and cutting material. */
  extrudeJoin: number;
  extrudeCut: number;
  /** Extrude session: pickable region fills. */
  regionIdle: number;
  regionSelected: number;
  /** Datum (reference) planes. */
  datum: number;
  /** Opacity of the origin planes' fill and outline. */
  planeFill: number;
  planeLine: number;
  /** The x-ray lens's edge lines (mirrors the kit's --k-an-edge). */
  xrayEdge: number;
  /** Draw label sprites in their exact sRGB colours (else lifted by tone mapping). */
  exactLabels: boolean;
  /** The grid's opacity. */
  gridOpacity: number;
}

export const DARK_VIEWPORT: ViewportPalette = {
  bg: 0x1b1d23,
  grid: 0x2d3340,
  gridMajor: 0x3a4152,
  axisX: 0xff5555,
  axisY: 0x55ff77,
  axisZ: 0x5588ff,
  ghost: 0x5b6472,
  variant: 0xf0a44b,
  geometry: 0xdfe6f2,
  underConstrained: 0x5a8cff,
  profileFill: 0x4f8cff,
  construction: 0x8a93a6,
  selected: 0xffb454,
  hover: 0x5ac8fa,
  point: 0xbcc6d8,
  origin: 0xffd166,
  dimension: 0x5bbf84,
  dimensionText: "#8fe3ad",
  badgeText: "#9ab0e8",
  labelBg: "rgba(20,22,28,0.85)",
  preview: 0x9aa7bd,
  bad: 0xff6b6b,
  extrudeJoin: 0x5bbf84,
  extrudeCut: 0xe4564e,
  regionIdle: 0x4a7bd6,
  regionSelected: 0x5bbf84,
  datum: 0xc9a227,
  planeFill: 0.08,
  planeLine: 0.5,
  xrayEdge: 0xeceae6,
  exactLabels: false,
  gridOpacity: 0.5,
};

/** On a light ground every line colour drops to a deeper shade of the same hue,
 *  so sketch geometry and dimensions keep their meaning and their contrast. */
export const LIGHT_VIEWPORT: ViewportPalette = {
  bg: 0xe7eaee,
  grid: 0xc9ced6,
  gridMajor: 0xa9b0bb,
  axisX: 0xd93a3a,
  axisY: 0x1f9a47,
  axisZ: 0x2f62d8,
  ghost: 0x98a0ad,
  variant: 0xd9822b,
  geometry: 0x1d2330,
  underConstrained: 0x2257d6,
  profileFill: 0x2f6fe4,
  construction: 0x7a8396,
  selected: 0xc46200,
  hover: 0x0883b5,
  point: 0x4b5566,
  origin: 0xa86f00,
  dimension: 0x16834a,
  dimensionText: "#126b3b",
  badgeText: "#2f50ad",
  labelBg: "rgba(255,255,255,0.92)",
  preview: 0x6b778c,
  bad: 0xd93636,
  extrudeJoin: 0x23a05d,
  extrudeCut: 0xd9443b,
  regionIdle: 0x2f6fe4,
  regionSelected: 0x23a05d,
  datum: 0xb08a10,
  planeFill: 0.07,
  planeLine: 0.6,
  xrayEdge: 0x2a303a,
  exactLabels: true,
  gridOpacity: 0.6,
};

export const VIEWPORT_PALETTES: Record<ViewportTheme, ViewportPalette> = { dark: DARK_VIEWPORT, light: LIGHT_VIEWPORT };

let theme: ViewportTheme = "dark";
const listeners = new Set<(t: ViewportTheme) => void>();

/** The palette for the current theme. */
export function viewportColors(): ViewportPalette { return VIEWPORT_PALETTES[theme]; }
export function viewportTheme(): ViewportTheme { return theme; }

/** Switch the viewport's theme; every live scene repaints. */
export function setViewportTheme(t: ViewportTheme) {
  if (t === theme) return;
  theme = t;
  for (const fn of [...listeners]) fn(t);
}

/** Called after the theme changes; returns an unsubscribe. */
export function onViewportTheme(fn: (t: ViewportTheme) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
