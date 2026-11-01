// Which icon a command or a hotkey action shows. Commands are the registry's
// types (src/core/command/builtins.ts); a few read their params to pick the
// kind (a joint's kind, a primitive's shape, a constraint's type). Actions are
// the hotkey manager's ids (src/model/hotkeyActions.ts, the context actions,
// the intent line). Anything unmapped gets FALLBACK_ICON; the icon tests list
// what must not.

import { FALLBACK_ICON, IconName } from "./icons";

const COMMANDS: Record<string, IconName> = {
  // parameters, intents, configurations
  "parameter.add": "parameter-add",
  "parameter.set": "parameter-edit",
  "parameter.setBounds": "parameter-bounds",
  "parameter.delete": "parameter-delete",
  "intent.add": "intent-add",
  "intent.update": "intent-edit",
  "intent.delete": "intent-delete",
  "configuration.create": "configuration-add",
  "configuration.update": "configuration-edit",
  "configuration.delete": "configuration-delete",
  // assembly
  "component.create": "component-add",
  "component.connector": "connector",
  "joint.create": "joint-rigid",
  "joint.template": "joint-revolute",
  "assembly.pattern": "assembly-pattern",
  // materials, drawings
  "material.create": "material-add",
  "material.update": "material-edit",
  "material.assign": "material-assign",
  "drawing.publish": "drawing",
  // sketches and planes
  "sketch.create": "sketch",
  "plane.create": "plane-offset",
  "sketch.addPoint": "point",
  "sketch.addLine": "line",
  "sketch.addCircle": "circle",
  "sketch.addEllipse": "ellipse",
  "sketch.addRectangle": "rectangle",
  "sketch.addRectangle3": "rectangle-3pt",
  "sketch.addPolyline": "polyline",
  "sketch.addProfile": "profile",
  "sketch.addBar": "bar",
  "sketch.addRing": "ring",
  "sketch.addSpline": "spline",
  "sketch.addGear": "gear-profile",
  "sketch.addPolygon": "polygon",
  "sketch.addSlot": "slot",
  "sketch.addArc": "arc",
  "sketch.projectCurves": "project",
  "sketch.moveGeometry": "move",
  "sketch.addConstraint": "perpendicular",
  "sketch.addDimension": "dimension",
  "sketch.mirror": "sketch-mirror",
  "sketch.linearPattern": "sketch-pattern-linear",
  "sketch.circularPattern": "sketch-pattern-circular",
  "sketch.gridPattern": "sketch-pattern-grid",
  "sketch.setConstruction": "construction",
  "sketch.deleteConstraints": "constraint-delete",
  "sketch.deleteEntities": "sketch-delete",
  "sketch.fillet": "sketch-fillet",
  "sketch.chamfer": "sketch-chamfer",
  "sketch.filletCorners": "fillet-corners",
  "sketch.offsetLoop": "offset-loop",
  "sketch.offset": "offset",
  "sketch.trim": "trim",
  "sketch.extend": "extend",
  // features
  "feature.extrude": "extrude",
  "feature.revolve": "revolve",
  "feature.primitive": "box",
  "feature.gear": "gear",
  "feature.import": "import",
  "feature.member": "member",
  "feature.sheet": "sheet",
  "feature.flange": "flange",
  "feature.fold": "fold",
  "feature.unfold": "unfold",
  "feature.refold": "refold",
  "feature.surface": "surface",
  "feature.stitch": "stitch",
  "feature.thicken": "thicken",
  "feature.trim": "surface-trim",
  "feature.untrim": "untrim",
  "feature.hole": "hole",
  "feature.thread": "thread",
  "feature.loft": "loft",
  "feature.sweep": "sweep",
  "feature.fillet": "fillet",
  "feature.chamfer": "chamfer",
  "feature.shell": "shell",
  "feature.pattern": "pattern-linear",
  "feature.mirror": "mirror",
  "feature.setCondition": "condition",
};

/** joint.create / joint.template `kind` → icon. */
export const JOINT_ICONS: Record<string, IconName> = {
  rigid: "joint-rigid",
  revolute: "joint-revolute",
  slider: "joint-slider",
  "pin-slot": "joint-pin-slot",
  flexure: "joint-flexure",
  beam: "joint-beam",
  planar: "joint-planar",
};

/** feature.primitive `shape` → icon. */
export const PRIMITIVE_ICONS: Record<string, IconName> = { box: "box", cylinder: "cylinder", cone: "cone", sphere: "sphere", torus: "torus" };

/** Sketch constraint type (src/sketch/types.ts) → icon. */
export const CONSTRAINT_ICONS: Record<string, IconName> = {
  coincident: "coincident",
  horizontal: "horizontal",
  vertical: "vertical",
  parallel: "parallel",
  perpendicular: "perpendicular",
  collinear: "collinear",
  equal: "equal",
  pointOnLine: "point-on-line",
  midpoint: "midpoint",
  pointOnCircle: "point-on-circle",
  concentric: "concentric",
  tangent: "tangent",
  symmetric: "symmetric",
  fix: "fix",
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The icon for a command type; `params` refine it where the kind lives in them. */
export function iconForCommand(type: string, params?: Record<string, unknown> | null): IconName {
  const p = params ?? {};
  switch (type) {
    case "joint.create":
    case "joint.template": {
      const k = str(p.kind);
      if (k && JOINT_ICONS[k]) return JOINT_ICONS[k];
      break;
    }
    case "feature.primitive": {
      const s = str(p.shape);
      if (s && PRIMITIVE_ICONS[s]) return PRIMITIVE_ICONS[s];
      break;
    }
    case "feature.pattern":
      if (p.mode === "circular") return "pattern-circular";
      break;
    case "sketch.addConstraint": {
      const t = str(p.type);
      if (t && CONSTRAINT_ICONS[t]) return CONSTRAINT_ICONS[t];
      break;
    }
  }
  return COMMANDS[type] ?? FALLBACK_ICON;
}

const ACTIONS: Record<string, IconName> = {
  // global
  "view.frame": "view-frame",
  "view.iso": "view-iso",
  "view.front": "view-front",
  "view.top": "view-top",
  "view.right": "view-right",
  "view.back": "view-back",
  "view.left": "view-left",
  "view.bottom": "view-bottom",
  "view.workbench": "pins",
  "view.lens": "lens",
  "view.ledger": "ledger",
  "view.space": "space",
  "view.mechanism": "mechanism",
  "mechanism.sweep": "play",
  "ring.open": "action-ring",
  "intent.open": "command",
  "edit.undo": "undo",
  "edit.redo": "redo",
  "edit.cancel": "close",
  // model
  "model.sketch": "sketch",
  "model.extrude": "extrude",
  "model.component": "component-add",
  "model.exportStep": "export",
  "model.exportStl": "export",
  "model.box": "box",
  "model.cylinder": "cylinder",
  "model.gear": "gear",
  "model.drawing": "drawing",
  "model.revolve": "revolve",
  "model.fillet": "fillet",
  "model.chamfer": "chamfer",
  "model.shell": "shell",
  "model.pattern": "pattern-linear",
  "file.save": "save",
  "history.back": "history-back",
  "history.forward": "history-forward",
  "history.end": "history-end",
  // sketch
  "tool.select": "select",
  "tool.line": "line",
  "tool.rectangle": "rectangle",
  "tool.circle": "circle",
  "tool.arc": "arc",
  "tool.polygon": "polygon",
  "tool.slot": "slot",
  "tool.ellipse": "ellipse",
  "tool.point": "point",
  "tool.dimension": "dimension",
  "tool.trim": "trim",
  "tool.extend": "extend",
  "sketch.finish": "check",
  "sketch.project": "project",
  "sketch.construction": "construction",
  "sketch.lookAt": "look-at",
  "sketch.delete": "sketch-delete",
  // face
  "face.fillet": "fillet",
  "face.chamfer": "chamfer",
  "face.roundCorners": "round-corners",
  "face.sketch": "sketch",
  "face.extrude": "extrude",
  "face.push": "push",
  "face.pull": "pull",
  "face.lookAt": "look-at",
  "face.feature": "open-card",
  // feature card
  "feature.next": "next",
  "feature.prev": "prev",
  "feature.rollTo": "roll-to",
  "feature.suppress": "suppress",
  "feature.delete": "feature-delete",
  // lens
  "lens.zebra": "zebra",
  "lens.draft": "draft",
  "lens.curvature": "curvature",
  "lens.xray": "xray",
  "lens.overhang": "overhang",
  "lens.strain": "strain",
  "lens.shape": "lens-wipe",
  "lens.size": "lens-size",
  // component
  "component.up": "component-up",
  "component.root": "home",
};

/** The icon for a hotkey action id. */
export function iconForAction(actionId: string): IconName {
  return ACTIONS[actionId] ?? FALLBACK_ICON;
}

/** The icon for a camera view name ("iso", "front", …). */
export function iconForView(view: string): IconName {
  return iconForAction(`view.${view}`);
}

/** The icon for a concept panel (the intent line's "toggle …"). */
export function iconForPanel(panel: string): IconName {
  if (panel === "materials") return "material";
  if (panel === "workbench") return "pins";
  return iconForAction(`view.${panel}`);
}
