// The icon set, as data. One family: a 24×24 grid, 1.75 strokes with round caps
// and joins, currentColor only. Each icon is a few path strings:
//
//   d     stroked outlines (the glyph)
//   dash  stroked dashed paths: construction lines, hidden edges, ghosts of what
//         an operation removes or replaces
//   dots  small filled dots [cx, cy, r?]: sketch points (a sketch entity shows its
//         points; a solid feature doesn't, which is how the sketch fillet tells
//         itself from the edge fillet), centres, the face a view looks at
//
// A variant is a base glyph plus a modifier badge in the bottom-right corner:
// add (+), edit (pencil) or delete (✕). The base is masked out under the badge
// (see Icon.tsx), so families share one drawing.
//
// Conventions: a dot marks a sketch point or the thing pointed at; dashes mark
// what is not (yet) there; arrows say which way the operation moves geometry.
// Solids are drawn in isometric (the cube: top vertex 12,3, sides at x 4 / 20).

export type IconMod = "add" | "edit" | "delete";
export type IconDot = readonly [number, number, number?];

export interface IconGlyph {
  d?: string;
  dash?: string;
  dots?: readonly IconDot[];
}

export interface IconBase extends IconGlyph {
  label: string;
}

export interface IconVariant {
  label: string;
  base: string;
  mod: IconMod;
}

export type IconDef = IconBase | IconVariant;

/** Default dot radius (a sketch point). */
export const DOT_R = 1.9;
/** Dash pattern for `dash` paths (round caps lengthen each dash by the stroke width). */
export const DASH = "3 4";
export const STROKE = 1.75;

/** The badge drawn over a variant, and the round area of the base masked out beneath it. */
export const MOD_BADGE: Record<IconMod, string> = {
  add: "M18 14v8M14 18h8",
  edit: "M14.5 21.5l.7-2.8 4.6-4.6a1.41 1.41 0 0 1 2 2l-4.6 4.6z",
  delete: "M15 15l6 6M21 15l-6 6",
};
export const MOD_MASK = { cx: 18, cy: 18, r: 6.5 } as const;

// ---- shared shapes ----
const CUBE = "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9";
const CUBE_OUTLINE = "M12 3l8 4.5v9L12 21l-8-4.5v-9z";
const CUBE_HIDDEN = "M4 16.5l8-4.5 8 4.5M12 12V3";
/** The cube seen from the far side (below, behind): its three hidden faces become the visible ones. */
const CUBE_BELOW = CUBE_HIDDEN;
const GEAR8 =
  "M10.31 4.95L10.93 2.31A9.75 9.75 0 0 1 13.07 2.31L13.69 4.95A7.25 7.25 0 0 1 15.79 5.82L18.1 4.39A9.75 9.75 0 0 1 19.61 5.9L18.18 8.21A7.25 7.25 0 0 1 19.05 10.31L21.69 10.93A9.75 9.75 0 0 1 21.69 13.07L19.05 13.69A7.25 7.25 0 0 1 18.18 15.79L19.61 18.1A9.75 9.75 0 0 1 18.1 19.61L15.79 18.18A7.25 7.25 0 0 1 13.69 19.05L13.07 21.69A9.75 9.75 0 0 1 10.93 21.69L10.31 19.05A7.25 7.25 0 0 1 8.21 18.18L5.9 19.61A9.75 9.75 0 0 1 4.39 18.1L5.82 15.79A7.25 7.25 0 0 1 4.95 13.69L2.31 13.07A9.75 9.75 0 0 1 2.31 10.93L4.95 10.31A7.25 7.25 0 0 1 5.82 8.21L4.39 5.9A9.75 9.75 0 0 1 5.9 4.39L8.21 5.82A7.25 7.25 0 0 1 10.31 4.95Z";
/** A circle as a path (two half arcs). */
const circle = (cx: number, cy: number, r: number) => `M${cx + r} ${cy}a${r} ${r} 0 1 1-${2 * r} 0 ${r} ${r} 0 1 1 ${2 * r} 0`;
const ellipse = (cx: number, cy: number, rx: number, ry: number) => `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0 ${rx} ${ry} 0 1 0-${2 * rx} 0`;

export const ICONS = {
  // ---------------------------------------------------------------- sketch entities
  line: { label: "Line", d: "M5 19L19 5", dots: [[5, 19], [19, 5]] },
  rectangle: { label: "Rectangle", d: "M4 6h16v12H4z", dots: [[4, 18], [20, 6]] },
  "rectangle-3pt": { label: "Rectangle (3-point)", d: "M3.5 10.5l7-7 10 10-7 7z", dots: [[3.5, 10.5], [10.5, 3.5], [20.5, 13.5]] },
  circle: { label: "Circle", d: circle(12, 12, 8.5), dots: [[12, 12, 1.5]] },
  arc: { label: "Arc", d: "M5 5a14 14 0 0 1 14 14", dots: [[5, 5], [19, 19], [5, 19, 1.5]] },
  ellipse: { label: "Ellipse", d: ellipse(12, 12, 9, 6), dots: [[12, 12, 1.5]] },
  polygon: { label: "Polygon", d: "M21 12l-4.5 7.79h-9L3 12l4.5-7.79h9z", dots: [[12, 12, 1.5]] },
  slot: { label: "Slot", d: "M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7z", dash: "M8 12h8", dots: [[8, 12, 1.5], [16, 12, 1.5]] },
  point: { label: "Point", d: "M12 3v4.5M12 16.5V21M3 12h4.5M16.5 12H21", dots: [[12, 12, 2.5]] },
  spline: { label: "Spline", d: "M3 18C6 6 10 6 12 12s6 6 9-6", dots: [[3, 18], [12, 12], [21, 6]] },
  polyline: { label: "Polyline", d: "M3 18l5-10 6 7 7-11", dots: [[3, 18], [8, 8], [14, 15], [21, 4]] },
  profile: { label: "Profile (lines + arcs)", d: "M4 20V4h6v7h4a6 6 0 0 1 6 6v3z", dots: [[14, 11, 1.5], [20, 17, 1.5]] },
  bar: { label: "Bar", d: "M2.9 16.9L16.9 2.9l4.2 4.2-14 14z", dash: "M5 19L19 5", dots: [[5, 19, 1.5], [19, 5, 1.5]] },
  ring: { label: "Ring", d: `${circle(12, 12, 9)}${circle(12, 12, 4.5)}` },
  "gear-profile": { label: "Involute gear (sketch)", d: GEAR8, dash: circle(12, 12, 3.5), dots: [[12, 12, 1.25]] },
  project: { label: "Project", d: "M9 3.5h6v5H9zM14.5 15.5h7L18 20.5H2.5L6 15.5h3", dash: "M9 8.5v9.5M15 8.5v9.5", dots: [[9, 18, 1.5], [15, 18, 1.5]] },
  move: { label: "Move", d: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" },
  construction: { label: "Construction", dash: "M5 19L19 5", dots: [[5, 19], [19, 5]] },
  trim: { label: "Trim", d: `${circle(6, 6.5, 2.5)}${circle(6, 17.5, 2.5)}M8.2 7.8L20.5 16.5M8.2 16.2L20.5 7.5` },
  extend: { label: "Extend", d: "M3 12h13M13 8.5l3.5 3.5-3.5 3.5M21 4v16", dots: [[3, 12]] },
  offset: { label: "Offset", d: "M4 20A16 16 0 0 1 20 4M10 20a10 10 0 0 1 10-10", dots: [[10, 20, 1.5], [20, 10, 1.5]] },
  "offset-loop": { label: "Offset loop", d: "M8.5 9h7v6h-7zM8.5 4.5h7A4.5 4.5 0 0 1 20 9v6a4.5 4.5 0 0 1-4.5 4.5h-7A4.5 4.5 0 0 1 4 15V9a4.5 4.5 0 0 1 4.5-4.5z" },
  "sketch-fillet": { label: "Sketch fillet", d: "M4 20v-8a8 8 0 0 1 8-8h8", dash: "M4 12V4h8", dots: [[4, 12], [12, 4]] },
  "sketch-chamfer": { label: "Sketch chamfer", d: "M4 20v-9l7-7h9", dash: "M4 11V4h7", dots: [[4, 11], [11, 4]] },
  "fillet-corners": { label: "Fillet corners", d: "M9 4h6a5 5 0 0 1 5 5v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5z", dash: "M15 4h5v5", dots: [[15, 4, 1.5], [20, 9, 1.5]] },
  "sketch-mirror": { label: "Sketch mirror", d: "M8.5 7L3.5 17h5zM15.5 7l5 10h-5z", dash: "M12 2.5v19" },
  "sketch-pattern-linear": { label: "Linear pattern (sketch)", d: `${circle(5, 8, 2.5)}${circle(12, 8, 2.5)}${circle(19, 8, 2.5)}M4 16h15M16.5 13.5L19 16l-2.5 2.5` },
  "sketch-pattern-circular": {
    label: "Circular pattern (sketch)",
    d: `${circle(12, 4.5, 2)}${circle(18.5, 8.25, 2)}${circle(18.5, 15.75, 2)}${circle(12, 19.5, 2)}${circle(5.5, 15.75, 2)}${circle(5.5, 8.25, 2)}`,
    dots: [[12, 12, 1.5]],
  },
  "sketch-pattern-grid": {
    label: "Grid pattern (sketch)",
    d: [5, 12, 19].flatMap((y) => [5, 12, 19].map((x) => circle(x, y, 2))).join(""),
  },
  dimension: { label: "Dimension", d: "M4 4v16M20 4v16M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3" },
  "sketch-delete": { label: "Delete sketch entities", base: "polyline", mod: "delete" },

  // ---------------------------------------------------------------- constraints
  coincident: { label: "Coincident", d: "M3.5 19.5L12 11l8.5 6", dots: [[12, 11, 2.6]] },
  horizontal: { label: "Horizontal", d: "M4 17h16M8.5 4v8M15.5 4v8M8.5 8h7", dots: [[4, 17], [20, 17]] },
  vertical: { label: "Vertical", d: "M17 4v16M4 6l3 8 3-8", dots: [[17, 4], [17, 20]] },
  parallel: { label: "Parallel", d: "M4 15L15 4M9 20L20 9" },
  perpendicular: { label: "Perpendicular", d: "M4 20h16M10 20V4M10 15h5v5" },
  collinear: { label: "Collinear", d: "M3 19l5.14-4M15.86 9L21 5", dash: "M8.14 15l7.72-6", dots: [[3, 19, 1.5], [8.14, 15, 1.5], [15.86, 9, 1.5], [21, 5, 1.5]] },
  equal: { label: "Equal", d: "M4 8h16M4 16h16M12 5.5v5M12 13.5v5" },
  tangent: { label: "Tangent", d: `${circle(10, 14, 6)}M3 8h18`, dots: [[10, 8, 1.75]] },
  concentric: { label: "Concentric", d: `${circle(12, 12, 9)}${circle(12, 12, 5)}`, dots: [[12, 12, 1.5]] },
  midpoint: { label: "Midpoint", d: "M3 16h18M9.5 7.5h5L12 11.5z", dots: [[3, 16, 1.5], [21, 16, 1.5], [12, 16, 2.25]] },
  "point-on-line": { label: "Point on line", d: "M3 18L21 6", dots: [[9, 14, 2.5]] },
  "point-on-circle": { label: "Point on circle", d: circle(12, 12, 7.5), dots: [[17.3, 6.7, 2.5]] },
  symmetric: { label: "Symmetric", d: "M4 19L8 6M20 19L16 6", dash: "M12 2.5v19", dots: [[4, 19, 1.6], [8, 6, 1.6], [20, 19, 1.6], [16, 6, 1.6]] },
  fix: { label: "Fix", d: "M5 11h14v10H5zM8 11V8a4 4 0 0 1 8 0v3", dots: [[12, 16, 1.5]] },
  "constraint-delete": { label: "Delete constraint", base: "perpendicular", mod: "delete" },

  // ---------------------------------------------------------------- sketch, planes, components
  sketch: { label: "Sketch", d: "M9 17l1-4 9-9a2.12 2.12 0 0 1 3 3l-9 9zM17 6l3 3M14.5 15.5h7L18 20.5H2.5L6 15.5h3" },
  plane: { label: "Plane", d: "M2.5 17l5-10h14l-5 10z" },
  "plane-offset": { label: "Offset plane", d: "M3 10l4-5h14l-4 5zM12 17v-4.5M10 14.5l2-2 2 2", dash: "M3 20l4-5h14l-4 5z" },
  component: { label: "Component", d: `${CUBE_OUTLINE}M8 9.75l4 2.25 4-2.25M12 12v4.5`, dots: [[12, 7.5, 1.4]] },
  "component-add": { label: "New component", base: "component", mod: "add" },
  "component-reference": { label: "Reference part", dash: `${CUBE_OUTLINE}M8 9.75l4 2.25 4-2.25M12 12v4.5` },
  connector: { label: "Connector", d: `${ellipse(12, 16, 7, 3)}M12 16V4M9 7l3-3 3 3`, dots: [[12, 16, 1.5]] },
  "component-up": { label: "Up to parent component", d: "M15 15h6v6h-6zM15 18H9a3 3 0 0 1-3-3V4M3 7l3-3 3 3" },
  home: { label: "Root component", d: "M3 11l9-7.5 9 7.5M5.5 9v11.5h13V9M10 20.5v-5h4v5" },

  // ---------------------------------------------------------------- solids and features
  box: { label: "Box", d: CUBE },
  cylinder: { label: "Cylinder", d: `${ellipse(12, 6, 7, 3)}M5 6v12a7 3 0 0 0 14 0V6` },
  cone: { label: "Cone", d: `M12 3L4.5 17M12 3l7.5 14${ellipse(12, 17, 7.5, 3)}` },
  sphere: { label: "Sphere", d: `${circle(12, 12, 9)}M3 12a9 3.5 0 0 0 18 0M12 3a4 9 0 0 1 0 18` },
  torus: { label: "Torus", d: `${ellipse(12, 12, 9.5, 6)}${ellipse(12, 11.5, 3.75, 1.75)}` },
  gear: { label: "Gear", d: `${GEAR8}${circle(12, 12, 3)}` },
  extrude: { label: "Extrude", d: "M4 14l8-4 8 4-8 4zM4 14v3l8 4 8-4v-3M12 18v3M12 14V3M9 6l3-3 3 3" },
  push: { label: "Push face out", d: "M4 16l8-4 8 4-8 4zM12 16V3M9 6l3-3 3 3" },
  pull: { label: "Pull face in", d: "M4 16l8-4 8 4-8 4zM12 3v11M9 11l3 3 3-3" },
  revolve: { label: "Revolve", d: "M12 3.5h5v6.5h-5M4.95 11.8A7.5 3.5 0 1 0 19.05 11.8M19.06 14.74L19.05 11.8l2.85.7", dash: "M12 2v20" },
  sweep: { label: "Sweep", d: `M6.5 19C6.5 12 11.5 7 18.5 7${ellipse(6.5, 19, 3.5, 1.5)}M18.5 3.5a1.5 3.5 0 1 1 0 7 1.5 3.5 0 1 1 0-7` },
  loft: { label: "Loft", d: `M3 18l9-3.5 9 3.5-9 3.5z${ellipse(12, 5, 5, 2)}M3 18L7 5M21 18L17 5` },
  fillet: { label: "Fillet", d: "M3 20V8h8a6 6 0 0 1 6 6v6zM3 8l4-4h8a6 6 0 0 1 6 6v6l-4 4M11 8l4-4M17 14l4-4" },
  chamfer: { label: "Chamfer", d: "M3 20V8h9l5 5v7zM3 8l4-4h9l5 5v7l-4 4M12 8l4-4M17 13l4-4" },
  "round-corners": { label: "Round corners", d: "M9 4h6a5 5 0 0 1 5 5v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5z", dash: "M15 4h5v5" },
  shell: { label: "Shell", d: `${CUBE_OUTLINE}M4 7.5l8 4.5 8-4.5M12 12v9M12 5.25l4 2.25-4 2.25-4-2.25zM8 7.5v3M12 9.75v3` },
  "pattern-linear": { label: "Linear pattern", d: "M2.5 5.5h5v5h-5zM9.5 5.5h5v5h-5zM16.5 5.5h5v5h-5zM3 16.5h17M17.5 14L20 16.5 17.5 19" },
  "pattern-circular": { label: "Circular pattern", d: "M10 2.5h4v4h-4zM17.5 10h4v4h-4zM10 17.5h4v4h-4zM2.5 10h4v4h-4z", dots: [[12, 12, 1.5]] },
  mirror: { label: "Mirror", d: "M10.5 5l3-2.5v16l-3 2.5zM8 8L3 17h5zM16 8l5 9h-5z" },
  hole: { label: "Hole", d: `${circle(12, 12, 6.5)}M12 9.5v5M9.5 12h5M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2` },
  thread: { label: "Thread", d: "M7 3h10v18H7zM7 8.5l10-3M7 13.5l10-3M7 18.5l10-3" },
  member: { label: "Structural member", d: "M5 4h14v3h-5v10h5v3H5v-3h5V7H5z" },
  sheet: { label: "Sheet metal", d: "M2 14l6-6h14l-6 6zM2 14v2.5h14V14M16 16.5l6-6V8" },
  flange: { label: "Flange", d: "M3.5 7v10a3 3 0 0 0 3 3h9M8.5 4v10a3 3 0 0 0 3 3h9M3.5 7l5-3M15.5 20l5-3" },
  fold: { label: "Fold", d: "M3 20h8V5M19 20a8 8 0 0 0-4-6.93M18 12.27l-3 .8.8 3.01", dash: "M11 20h8" },
  unfold: { label: "Unfold", d: "M3 20h18M11 12a8 8 0 0 1 6.93 4M18.74 13l-.81 3-3-.8", dash: "M11 20V7" },
  refold: { label: "Refold", d: "M3 20h8V5M19 20a8 8 0 0 0-4-6.93M18 12.27l-3 .8.8 3.01M4.6 9.4a3.2 3.2 0 1 0 .3-4.3M4.4 3.2l.5 1.9 1.9-.4" },
  surface: { label: "Surface", d: "M3 18c3-2.5 6-2.5 9 0s6 2.5 9 0M5 7c2.3-2 4.7-2 7 0s4.7 2 7 0M3 18L5 7M21 18l-2-11" },
  stitch: { label: "Stitch", d: "M10 5H4v14h6M14 5h6v14h-6M10 6.5l4 1.75-4 1.75 4 1.75-4 1.75 4 1.75-4 1.75" },
  thicken: { label: "Thicken", d: "M3 9c3-2.5 6-2.5 9 0s6 2.5 9 0M3 15c3-2.5 6-2.5 9 0s6 2.5 9 0M3 9v6M21 9v6" },
  "surface-trim": { label: "Trim surface", d: "M13 4H4v16h16v-6M13 4c0 5.5 2 9 7 10", dash: "M13 4h7v10" },
  untrim: { label: "Untrim", d: "M4 4h16v16H4z", dash: "M13 4c0 5.5 2 9 7 10" },
  condition: { label: "Switch by parameter", d: `M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7z${circle(16.5, 12, 2.75)}` },
  import: { label: "Import", d: "M12 3v12M7.5 10.5L12 15l4.5-4.5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" },
  export: { label: "Export", d: "M12 15V3M7.5 7.5L12 3l4.5 4.5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" },
  "feature-delete": { label: "Delete feature", base: "box", mod: "delete" },
  section: { label: "Section", d: "M12 4h8v16h-8zM12 9l5-5M12 14l8-8M12 19l8-8M17 20l3-3M12 2v20", dash: "M12 4H4v16h8" },
  measure: { label: "Measure", d: "M3 16L16 3l5 5L8 21zM7 12l2 2M10 9l2 2M13 6l2 2" },

  // ---------------------------------------------------------------- assembly
  "joint-rigid": { label: "Rigid joint", d: "M3 14h18v6H3zM8 4h8v10H8z", dots: [[6, 17, 1.4], [18, 17, 1.4], [12, 9, 1.4]] },
  "joint-revolute": { label: "Revolute joint", d: `${circle(12, 12, 2.5)}M5.5 15.75A7.5 7.5 0 1 1 18.5 15.75M21.48 14.58L18.5 15.75l-.48-3.17` },
  "joint-slider": { label: "Slider joint", d: "M2 19h20M7 11h10v8H7zM4 5.5h16M6.5 3L4 5.5 6.5 8M17.5 3L20 5.5 17.5 8" },
  "joint-pin-slot": { label: "Pin-slot joint", d: `M7 4h10a3 3 0 0 1 0 6H7a3 3 0 0 1 0-6zM8 7l7 11${circle(15.75, 19, 2)}`, dots: [[8, 7, 1.9]] },
  "joint-flexure": { label: "Flexure joint", d: "M3 16h6v5H3zM15 3h6v5h-6zM6 16C6 10 18 14 18 8" },
  "joint-beam": { label: "Beam joint", d: "M4 3v18M4 6L2 8M4 10l-2 2M4 14l-2 2M4 18l-2 2M4 9c6 0 11 2 16 6", dash: "M4 9h16", dots: [[20, 15, 1.5]] },
  "joint-planar": { label: "Planar joint", d: "M2 19l5-6h15l-5 6zM12 3v7M9.5 5.5L12 3l2.5 2.5M6 8h12M8.5 5.5L6 8l2.5 2.5M15.5 5.5L18 8l-2.5 2.5" },
  "assembly-pattern": { label: "Pattern components", d: "M2.5 9.5h5v5h-5zM9.5 9.5h5v5h-5zM16.5 9.5h5v5h-5zM7.5 12h2M14.5 12h2M5 4.5c4-2 10-2 14 0M16.5 2.5l2.5 2-2 2.5" },

  // ---------------------------------------------------------------- document data
  parameter: { label: "Parameter", d: "M5 20c1.5 0 2.2-.8 2.6-2.8L10 6.8C10.4 4.8 11 4 12.6 4M6.5 10h5M14 11l6 7M20 11l-6 7" },
  "parameter-add": { label: "Add parameter", base: "parameter", mod: "add" },
  "parameter-edit": { label: "Set parameter", base: "parameter", mod: "edit" },
  "parameter-delete": { label: "Delete parameter", base: "parameter", mod: "delete" },
  "parameter-bounds": { label: "Parameter extents", d: "M5 12h14M5 8v8M19 8v8", dots: [[12, 12, 2.5]] },
  intent: { label: "Design intent", d: "M5 21V4M5 4h12l-3 4.5 3 4.5H5" },
  "intent-add": { label: "Add intent", base: "intent", mod: "add" },
  "intent-edit": { label: "Edit intent", base: "intent", mod: "edit" },
  "intent-delete": { label: "Delete intent", base: "intent", mod: "delete" },
  configuration: { label: "Configuration", d: "M4 5h16v14H4zM4 10h16M4 14.5h16M10 5v14" },
  "configuration-add": { label: "Add configuration", base: "configuration", mod: "add" },
  "configuration-edit": { label: "Edit configuration", base: "configuration", mod: "edit" },
  "configuration-delete": { label: "Delete configuration", base: "configuration", mod: "delete" },
  material: { label: "Material", d: `${circle(12, 12, 9)}M7 10a5.5 5.5 0 0 1 3-3M18.1 14.25a10.5 10.5 0 0 1-3.85 3.85` },
  "material-add": { label: "Create material", base: "material", mod: "add" },
  "material-edit": { label: "Edit material", base: "material", mod: "edit" },
  "material-assign": { label: "Assign material", d: "M12.5 15.5l8-8a2.12 2.12 0 0 0-3-3l-8 8M9.5 12.5l3 3c-.5 3.5-3.5 5.5-8 5.5 1-1.5 1-3 1.5-4.5.7-2.3 2-3.5 3.5-4z" },
  drawing: { label: "Drawing", d: "M3 4h18v16H3zM13 20v-4h8M6 7h7v6H6zM6 16h4" },

  // ---------------------------------------------------------------- views
  "view-iso": { label: "View: Iso", d: CUBE, dots: [[12, 12, 2.2]] },
  "view-top": { label: "View: Top", d: CUBE, dots: [[12, 7.5, 1.9]] },
  "view-front": { label: "View: Front", d: CUBE, dots: [[8, 14.25, 1.9]] },
  "view-right": { label: "View: Right", d: CUBE, dots: [[16, 14.25, 1.9]] },
  "view-back": { label: "View: Back", d: `${CUBE_OUTLINE}${CUBE_BELOW}`, dots: [[16, 9.75, 1.9]] },
  "view-left": { label: "View: Left", d: `${CUBE_OUTLINE}${CUBE_BELOW}`, dots: [[8, 9.75, 1.9]] },
  "view-bottom": { label: "View: Bottom", d: `${CUBE_OUTLINE}${CUBE_BELOW}`, dots: [[12, 16.5, 1.9]] },
  "view-frame": { label: "Frame / fit", d: "M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8z" },
  "look-at": { label: "Look at", d: `M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z${circle(12, 12, 3)}` },

  // ---------------------------------------------------------------- panels and surfaces
  pins: { label: "Feature pins", d: "M12 21.5s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z", dots: [[12, 10.5, 2]] },
  lens: { label: "Lens", d: `${circle(10, 10, 7)}M15 15l6 6` },
  ledger: { label: "Ledger", d: "M5 3h14v18H5zM9 8h6M9 12h6M9 16h4" },
  space: { label: "Design space", d: "M4 3v17h17", dots: [[9, 14, 1.6], [12, 8, 1.6], [16, 12, 1.6], [18.5, 6, 1.6]] },
  mechanism: { label: "Mechanism", d: "M3 20h18M6 20L8 9l9-2 1 13", dots: [[8, 9], [17, 7]] },
  play: { label: "Sweep the drive", d: "M7 4.5v15L19 12z" },
  "action-ring": { label: "Action ring", d: circle(12, 12, 2.5), dots: [[12, 3.5, 1.6], [18.01, 5.99, 1.6], [20.5, 12, 1.6], [18.01, 18.01, 1.6], [12, 20.5, 1.6], [5.99, 18.01, 1.6], [3.5, 12, 1.6], [5.99, 5.99, 1.6]] },
  command: { label: "Intent line", d: "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM7 10l2.5 2L7 14M12 14h5" },

  // ---------------------------------------------------------------- editing and history
  undo: { label: "Undo", d: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" },
  redo: { label: "Redo", d: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" },
  close: { label: "Cancel", d: "M6 6l12 12M18 6L6 18" },
  check: { label: "Finish", d: "M4 12.5l5 5L20 6.5" },
  select: { label: "Select", d: "M5 3.5l5.2 16.5 2.6-7 7.2-2.6zM13 13l6 6" },
  suppress: { label: "Suppress", d: `${circle(12, 12, 8.5)}M6 6l12 12` },
  "open-card": { label: "Open feature", d: "M13 4h7v7M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" },
  "roll-to": { label: "Roll back to here", d: "M3 18h18M12 7v14M9 4h6l-3 3z", dots: [[6, 18, 1.5], [18, 18, 1.5]] },
  "history-back": { label: "Roll back one step", d: "M3 18h18M17 9H7M10.5 5.5L7 9l3.5 3.5", dots: [[6, 18, 1.5], [12, 18, 1.5], [18, 18, 1.5]] },
  "history-forward": { label: "Roll forward one step", d: "M3 18h18M7 9h10M13.5 5.5L17 9l-3.5 3.5", dots: [[6, 18, 1.5], [12, 18, 1.5], [18, 18, 1.5]] },
  "history-end": { label: "Roll to end", d: "M3 18h18M5 9h11M12.5 5.5L16 9l-3.5 3.5M20 4v10", dots: [[6, 18, 1.5], [12, 18, 1.5], [18, 18, 1.5]] },
  next: { label: "Next", d: "M9 5l7 7-7 7" },
  prev: { label: "Previous", d: "M15 5l-7 7 7 7" },

  // ---------------------------------------------------------------- lens modes
  zebra: { label: "Zebra", d: `${circle(12, 12, 9)}M6 7.8c2-1.2 4 1.2 6 0s4-1.2 6 0M4.5 12c2.5-1.5 5 1.5 7.5 0s5-1.5 7.5 0M6 16.2c2-1.2 4 1.2 6 0s4-1.2 6 0` },
  draft: { label: "Draft", d: "M5.5 20l2.5-11h8l2.5 11zM12 6.5V2.5M9.75 4.75L12 2.5l2.25 2.25" },
  curvature: { label: "Curvature", d: "M3 20Q12 8 21 20M5.7 16.94L3.29 14.36M8.85 14.73L6.26 9.18M12 14V6.5M15.15 14.73l2.59-5.55M18.3 16.94l2.41-2.58M3.29 14.36Q12 -.3 20.71 14.36" },
  xray: { label: "X-ray", d: CUBE, dash: CUBE_HIDDEN },
  overhang: { label: "Overhang", d: "M5 21V4h15v5H10v12", dash: "M14 12v5M18 12v5" },
  strain: { label: "Strain", d: "M7 9h10v6H7zM2.5 12H7M17 12h4.5M4.5 9.5L2 12l2.5 2.5M19.5 9.5L22 12l-2.5 2.5" },
  "lens-wipe": { label: "Lens / wipe", d: `${circle(12, 12, 8.5)}M12 2v20`, dash: "M14.5 8l3 4-3 4" },
  "lens-size": { label: "Lens size", d: `${circle(12, 12, 4)}M4 4l3.5 3.5M4 8.5V4h4.5M20 20l-3.5-3.5M20 15.5V20h-4.5` },

  // ---------------------------------------------------------------- app
  file: { label: "Document", d: "M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8zM14 3v5h5" },
  "file-new": { label: "New document", base: "file", mod: "add" },
  folder: { label: "Open", d: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" },
  save: { label: "Save", d: "M5 4h11l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 4v5h7V4M7.5 20v-6h9v6" },
  agent: { label: "Agent", d: "M10 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7zM18.5 14.5c.3 1.6 1.1 2.4 2.5 2.5-1.4.3-2.2 1.1-2.5 2.5-.3-1.4-1.1-2.2-2.5-2.5 1.4-.1 2.2-.9 2.5-2.5z" },
  keyboard: { label: "Keyboard shortcuts", d: "M4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6zM8 14.5h8", dots: [[7, 10, 1.1], [10.33, 10, 1.1], [13.67, 10, 1.1], [17, 10, 1.1]] },
  settings: { label: "Settings", d: `M4 7h8M16 7h4M4 17h4M12 17h8${circle(14, 7, 2)}${circle(10, 17, 2)}` },
  swap: { label: "Flip", d: "M4 8h15M16 5l3 3-3 3M20 16H5M8 13l-3 3 3 3" },

  /** The fallback for anything without its own icon. */
  action: { label: "Action", d: "M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4z", dots: [[12, 12, 2]] },
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;
export const FALLBACK_ICON: IconName = "action";
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** What to draw for an icon: the base glyph, and the modifier badge for a variant. Unknown names draw the fallback. */
export function resolveIcon(name: string): { glyph: IconGlyph; mod?: IconMod; label: string } {
  const all: Record<string, IconDef> = ICONS;
  const fallback = all[FALLBACK_ICON] as IconBase;
  const def = isIconName(name) ? all[name] : fallback;
  if ("base" in def) {
    const base = isIconName(def.base) ? all[def.base] : fallback;
    return { glyph: "base" in base ? fallback : base, mod: def.mod, label: def.label };
  }
  return { glyph: def, label: def.label };
}
