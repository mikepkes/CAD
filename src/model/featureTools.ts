// The decisions behind the modelling panels (Revolve, Shell, Pattern, edge-pick
// Fillet/Chamfer, and the Extrude panel's profile list): which sketches can be a
// profile and what they're called, which axes a revolve can turn about, what a
// tool session commits as a command. Pure (no React, no store), tested in Node.

import type { CadDocument, BooleanOp } from "../core/document";
import type { Sketch } from "../sketch/types";
import { extractRegions } from "../core/geometry/profile";
import { resolveSketchPlane, to2d } from "../geometry/plane";
import { sketchIsEmpty } from "../ui/sketchStatus";

type V3 = { x: number; y: number; z: number };
export type WorldAxis = "X" | "Y" | "Z";
export const WORLD_AXES: Record<WorldAxis, V3> = { X: { x: 1, y: 0, z: 0 }, Y: { x: 0, y: 1, z: 0 }, Z: { x: 0, y: 0, z: 1 } };

/** What a revolve turns about: a line of its sketch (the axis follows it), or a world axis through the origin. */
export type RevolveAxis = { line: string } | { world: WorldAxis };

export type FeatureTool =
  | { kind: "revolve"; sketch: string | null; axis: RevolveAxis | null; angle: string; operation: BooleanOp }
  | { kind: "shell"; body: string | null; faces: { name: string; point: V3; normal: V3 }[]; thickness: string }
  | { kind: "pattern"; body: string | null; mode: "linear" | "circular"; count: string; direction: WorldAxis; spacing: string; axis: WorldAxis; angle: string }
  | { kind: "edges"; blend: "fillet" | "chamfer"; body: string | null; edges: string[]; size: string };

export type FeatureToolKind = FeatureTool["kind"];

/** How a sketch is listed as a profile: its browser name and where it lies ("Sketch 2 · XZ", "Sketch 3 · face"). */
export function profileLabel(sk: Pick<Sketch, "name" | "planeId" | "datumId">, doc?: Pick<CadDocument, "planes">): string {
  const where = sk.planeId === "custom" ? "face" : sk.datumId && doc?.planes[sk.datumId] ? doc.planes[sk.datumId].name : sk.planeId;
  return `${sk.name} · ${where}`;
}

/** Whether a sketch has a closed region to extrude or revolve. */
export function hasClosedRegion(sk: Sketch): boolean {
  if (sketchIsEmpty(sk)) return false;
  try { return extractRegions(sk).length > 0; } catch { return false; }
}

/** The sketches a profile picker offers: only those with a closed region, by their browser name, in history order.
 *  `keep` stays listed even when it has none (the current choice, so the picker doesn't lie about it). */
export function profileChoices(doc: CadDocument, keep?: string | null): { id: string; label: string }[] {
  return Object.values(doc.sketches)
    .filter((sk) => sk.id === keep || hasClosedRegion(sk))
    .map((sk) => ({ id: sk.id, label: profileLabel(sk, doc) }));
}

/** A world axis in a sketch's (u, v) coordinates: two points on its projection through the world origin, or null
 *  when the axis runs along the sketch's normal (it doesn't lie in the plane). */
export function worldAxisInSketch(sk: Sketch, axis: WorldAxis): { p1: { x: number; y: number }; p2: { x: number; y: number } } | null {
  const wp = resolveSketchPlane(sk), d = WORLD_AXES[axis];
  if (Math.abs(d.x * wp.normal.x + d.y * wp.normal.y + d.z * wp.normal.z) > 0.99) return null;
  const a = to2d(wp, { x: 0, y: 0, z: 0 }), b = to2d(wp, { x: 10 * d.x, y: 10 * d.y, z: 10 * d.z });
  if (Math.hypot(b.u - a.u, b.v - a.v) < 1e-6) return null;
  return { p1: { x: a.u, y: a.v }, p2: { x: b.u, y: b.v } };
}

/** The lines a revolve can turn about, construction lines first, each described ("Construction line, vertical, 40 mm"). */
export function revolveLineChoices(sk: Sketch): { id: string; label: string }[] {
  const out: { id: string; label: string; construction: boolean }[] = [];
  for (const e of Object.values(sk.entities)) {
    if (e.kind !== "line") continue;
    const a = sk.entities[e.p1], b = sk.entities[e.p2];
    if (a?.kind !== "point" || b?.kind !== "point") continue;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const dir = Math.abs(dy) < 1e-6 * Math.max(1, len) ? "horizontal" : Math.abs(dx) < 1e-6 * Math.max(1, len) ? "vertical" : "slanted";
    out.push({ id: e.id, construction: !!e.construction, label: `${e.construction ? "Construction line" : "Line"}, ${dir}, ${Math.round(len * 10) / 10} mm` });
  }
  return out.sort((p, q) => Number(q.construction) - Number(p.construction)).map(({ id, label }) => ({ id, label }));
}

/** The axis a new revolve starts with: the sketch's first construction line, else a world axis in its plane (Z, X, Y). */
export function defaultRevolveAxis(sk: Sketch): RevolveAxis | null {
  const lines = revolveLineChoices(sk);
  const c = Object.values(sk.entities).find((e) => e.kind === "line" && e.construction);
  if (c) return { line: c.id };
  for (const w of ["Z", "X", "Y"] as WorldAxis[]) if (worldAxisInSketch(sk, w)) return { world: w };
  return lines[0] ? { line: lines[0].id } : null;
}

/** The command a finished tool session runs, or why it can't run yet. */
export function toolCommand(tool: FeatureTool, doc: CadDocument): { type: string; params: Record<string, unknown> } | { problem: string } {
  switch (tool.kind) {
    case "revolve": {
      const sk = tool.sketch ? doc.sketches[tool.sketch] : undefined;
      if (!sk) return { problem: "Choose a profile sketch" };
      if (!hasClosedRegion(sk)) return { problem: `${sk.name} has no closed region to revolve` };
      if (!tool.axis) return { problem: "Choose an axis" };
      const params: Record<string, unknown> = { sketch: sk.id, angle: tool.angle.trim() || "360", ...(tool.operation !== "new" ? { operation: tool.operation } : {}) };
      if ("line" in tool.axis) params.axisLine = tool.axis.line;
      else {
        const ax = worldAxisInSketch(sk, tool.axis.world);
        if (!ax) return { problem: `The ${tool.axis.world} axis doesn't lie in ${sk.name}'s plane` };
        params.axis = ax;
      }
      return { type: "feature.revolve", params };
    }
    case "shell":
      if (!tool.faces.length) return { problem: "Click the faces to open" };
      return { type: "feature.shell", params: { thickness: tool.thickness.trim() || "2", openFaces: { names: tool.faces.map((f) => f.name) }, ...(tool.body ? { body: tool.body } : {}), requireEffect: true } };
    case "pattern": {
      const count = tool.count.trim() || "2";
      if (tool.mode === "linear") {
        const s = tool.spacing.trim() || "10";
        return { type: "feature.pattern", params: { mode: "linear", count, step: { x: tool.direction === "X" ? s : "0", y: tool.direction === "Y" ? s : "0", z: tool.direction === "Z" ? s : "0" }, ...(tool.body ? { body: tool.body } : {}) } };
      }
      return { type: "feature.pattern", params: { mode: "circular", count, axis: { origin: { x: 0, y: 0, z: 0 }, direction: WORLD_AXES[tool.axis] }, ...(tool.angle.trim() ? { angle: tool.angle.trim() } : {}), ...(tool.body ? { body: tool.body } : {}) } };
    }
    case "edges":
      if (!tool.edges.length) return { problem: `Click the edges to ${tool.blend === "fillet" ? "round" : "bevel"}` };
      return { type: `feature.${tool.blend}`, params: { [tool.blend === "fillet" ? "radius" : "distance"]: tool.size.trim() || "1", edges: { names: tool.edges }, ...(tool.body ? { body: tool.body } : {}), requireEffect: true } };
  }
}

/** The expressions a tool session holds, by field (checked against the parameters before it commits). */
export function toolExpressions(tool: FeatureTool): Record<string, string> {
  switch (tool.kind) {
    case "revolve": return { Angle: tool.angle || "360" };
    case "shell": return { Thickness: tool.thickness || "2" };
    case "pattern": return tool.mode === "linear" ? { Count: tool.count || "2", Spacing: tool.spacing || "10" } : { Count: tool.count || "2", ...(tool.angle.trim() ? { Angle: tool.angle } : {}) };
    case "edges": return { [tool.blend === "fillet" ? "Radius" : "Distance"]: tool.size || "1" };
  }
}

/** Toggle one item in a list (a picked face or edge): add it, or drop it when it's already there. */
export function toggled<T>(list: T[], item: T, same: (a: T, b: T) => boolean = (a, b) => a === b): T[] {
  return list.some((x) => same(x, item)) ? list.filter((x) => !same(x, item)) : [...list, item];
}
