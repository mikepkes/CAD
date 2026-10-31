// The hotkey / ring contexts and the one function that says which are active.
//
// Contexts stack bottom → top: "global" always, then the mode ("model" or
// "sketch"), then whatever the user is focused on in model mode, most specific
// last. A key or ring slot resolves top-down through this stack, so a face's
// "f" (look at the face) wins over the model's "f" (frame), and an empty ring
// slot in a context inherits the slot below it.
//
// Pure: the installer in hotkeyActions.ts feeds it the store and useUi state;
// tests feed it plain objects.

export type ContextId = "global" | "model" | "sketch" | "component" | "lens" | "feature" | "face";

/** Every context, in stacking order (bottom → top). */
export const CONTEXTS: ContextId[] = ["global", "model", "sketch", "component", "lens", "feature", "face"];

export const CONTEXT_LABELS: Record<ContextId, string> = {
  global: "Everywhere",
  model: "Model",
  sketch: "Sketch",
  component: "Inside a component",
  lens: "Lens on",
  feature: "Feature card open",
  face: "Face selected",
};

/** The contexts each one always sits on (what its ring may borrow actions from). */
export const CONTEXT_BASE: Record<ContextId, ContextId[]> = {
  global: [],
  model: ["global"],
  sketch: ["global"],
  component: ["global", "model"],
  lens: ["global", "model"],
  feature: ["global", "model"],
  face: ["global", "model"],
};

export interface ContextInput {
  mode: "model" | "sketch";
  /** A face is selected (the face verbs are showing). */
  face: boolean;
  /** A feature card is open (useUi.openFeature) with the workbench panel on. */
  feature: boolean;
  /** The lens panel is on. */
  lens: boolean;
  /** The active component is not the root. */
  component: boolean;
}

/** The active stack, bottom → top. The focus contexts exist only in model mode. */
export function contextStack(i: ContextInput): ContextId[] {
  if (i.mode === "sketch") return ["global", "sketch"];
  const out: ContextId[] = ["global", "model"];
  if (i.component) out.push("component");
  if (i.lens) out.push("lens");
  if (i.feature) out.push("feature");
  if (i.face) out.push("face");
  return out;
}

/** Contexts whose actions a ring in `ctx` may hold: its own and those it sits on. */
export function ringSources(ctx: ContextId): ContextId[] {
  return [...CONTEXT_BASE[ctx], ctx];
}

export function isContextId(s: string): s is ContextId {
  return (CONTEXTS as string[]).includes(s);
}
