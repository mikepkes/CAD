// How a sketch's solve state reads wherever it shows (status bar, Inspector,
// Browser dot): one sentence and one class, so they never disagree. A sketch
// with nothing drawn in it isn't "fully constrained": there is nothing to
// constrain yet.

import type { Sketch } from "../sketch/types";

export type SketchStatusClass = "ok" | "bad" | "warn" | "empty";

/** Whether the sketch has no geometry of its own (only its origin point). */
export function sketchIsEmpty(sk: Pick<Sketch, "entities" | "originPointId">): boolean {
  return Object.keys(sk.entities).every((id) => id === sk.originPointId);
}

/** The sketch's state in words, and its class: "Nothing to constrain yet", "Fully constrained", "Conflicting", "3 DOF". */
export function sketchStatus(sk: Pick<Sketch, "entities" | "originPointId" | "status">, long = false): { cls: SketchStatusClass; text: string } {
  if (sketchIsEmpty(sk)) return { cls: "empty", text: long ? "Nothing to constrain yet: draw something" : "Nothing to constrain yet" };
  if (sk.status.conflicting) return { cls: "bad", text: long ? "Over-constrained / conflicting" : "Conflicting" };
  if (sk.status.fullyConstrained) return { cls: "ok", text: "Fully constrained" };
  const dof = sk.status.dof;
  return { cls: "warn", text: long ? `${dof} degree${dof === 1 ? "" : "s"} of freedom` : `${dof} DOF` };
}
