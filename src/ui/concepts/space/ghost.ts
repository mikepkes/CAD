// The compared pin as a ghost on the part: the variant document a pin names,
// its evaluation on the sampler backend, the key it is cached under, and the
// words the pin card uses for it. No React, no store: tested in Node
// (test/space.test.ts); index.tsx drives it and writes the result to useGhost.

import type { CadDocument } from "../../../core/document";
import type { OperationRecord } from "../../../core/command/types";
import type { GeometryBackend } from "../../../core/geometry/backend";
import type { SolidEval } from "../../../core/features";
import { variantDoc } from "./sampler";
import { docSignature, formatAxisValue, type Axis, type Pin } from "./space";

/** The pin's design: the document with the pin's two parameters set to its values. */
export function variantDocForPin(doc: CadDocument, pin: Pick<Pin, "x" | "y" | "xName" | "yName">): Promise<CadDocument> {
  return variantDoc(doc, { x: { name: pin.xName }, y: { name: pin.yName } }, pin.x, pin.y);
}

/** Both of the pin's parameters still exist in the document (else the variant would be the document itself). */
export function pinApplies(doc: CadDocument, pin: Pick<Pin, "xName" | "yName">): boolean {
  const names = new Set(doc.parameters.map((p) => p.name));
  return names.has(pin.xName) && names.has(pin.yName);
}

/**
 * What a ghost depends on: the pin's parameters and values plus the recipe
 * (docSignature with the pin's own parameters blanked), so dragging the
 * current design — the very thing a compare is for — never re-evaluates it,
 * while any other edit does.
 */
export function ghostKey(pin: Pick<Pin, "x" | "y" | "xName" | "yName">, timeline: OperationRecord[], rollbackIndex: number, activeConfiguration: string | undefined): string {
  return `${pin.xName}=${pin.x}|${pin.yName}=${pin.y}|${docSignature(timeline, rollbackIndex, activeConfiguration, [pin.xName, pin.yName])}`;
}

/** "Pin A: w 20 · h 5", at the axes' precision when they are known. */
export function ghostLabel(pin: Pin, axes?: { x?: Axis; y?: Axis }): string {
  const fx = axes?.x && axes.x.name === pin.xName ? formatAxisValue(axes.x, pin.x) : String(pin.x);
  const fy = axes?.y && axes.y.name === pin.yName ? formatAxisValue(axes.y, pin.y) : String(pin.y);
  return `Pin ${pin.letter}: ${pin.xName} ${fx} · ${pin.yName} ${fy}`;
}

export type GhostStatus = "evaluating" | "shown" | "empty" | "error";

export interface GhostResult {
  solids: SolidEval[];
  status: Extract<GhostStatus, "shown" | "empty" | "error">;
  error?: string;
}

/** Evaluate the pin's variant: every body that built (surface bodies included), in feature order. */
export async function evaluateVariant(backend: GeometryBackend, doc: CadDocument, pin: Pick<Pin, "x" | "y" | "xName" | "yName">): Promise<GhostResult> {
  try {
    const { solids } = await backend.evaluate(await variantDocForPin(doc, pin));
    const built = Object.values(solids).filter((s) => s.mesh);
    const failed = Object.values(solids).find((s) => s.error && !s.mesh);
    if (!built.length) return failed ? { solids: [], status: "error", error: failed.error } : { solids: [], status: "empty" };
    return { solids: built, status: "shown" };
  } catch (e) {
    return { solids: [], status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** The line under a compared pin that says what the part shows. */
export function ghostStatusText(status: GhostStatus | null, error?: string | null): string {
  switch (status) {
    case "evaluating": return "ghost: building…";
    case "shown": return "shown as a ghost on the part";
    case "empty": return "ghost: no bodies";
    case "error": return `ghost: did not build${error ? ` (${error})` : ""}`;
    default: return "";
  }
}

/** Evaluated variants by key, bounded (three pins, a few recipes): old entries fall out least-recently-used first. */
export class GhostCache {
  private map = new Map<string, GhostResult>();
  constructor(private limit = 6) {}
  get(key: string): GhostResult | undefined {
    const v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  set(key: string, v: GhostResult): void {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
  }
  clear(): void { this.map.clear(); }
}
