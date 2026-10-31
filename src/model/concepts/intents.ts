// Design intents: the checks a design must keep passing ("the wall bends no
// more than 0.5 mm", "mass under 120 g"). An intent is a comparison between
// two expressions over the document's parameters plus a few model metrics.
// Pure: the Ledger lists and edits them, the Design Space draws them as
// frontiers, and both evaluate them through `checkIntents`.

import type { CadDocument, Material } from "../../core/document";
import type { SolidEval } from "../../core/features";
import { resolveParameters } from "../../core/parameters";
import { compileExpr } from "../../math/expr";

export type Comparator = "<=" | ">=" | "<" | ">" | "==";

export interface Intent {
  id: string;
  /** What is checked, in words ("Total mass"). */
  label: string;
  /** Left side: a parameter, a metric, or an expression of them. */
  lhs: string;
  op: Comparator;
  rhs: string;
  /** Unit the sides are read in, for display only. */
  unit?: string;
}

export interface IntentResult {
  intent: Intent;
  ok: boolean;
  lhs: number;
  rhs: number;
  /** Why it couldn't be evaluated (unknown name, bad expression). */
  error?: string;
}

/** Model metrics the intent scope offers beside the parameters. All are estimates
 *  except volume and bounds, which come from the kernel; density is the assigned
 *  material's, else aluminium (2.70 g/cm³). */
export interface Metrics {
  /** Total solid volume, mm³. */
  volume: number;
  /** Mass in grams at `density`. */
  mass: number;
  /** g/cm³ used for `mass`. */
  density: number;
  /** Bounding box of every body, mm. */
  width: number;
  depth: number;
  height: number;
  /** Number of bodies. */
  bodies: number;
}

export const METRIC_NAMES: (keyof Metrics)[] = ["volume", "mass", "density", "width", "depth", "height", "bodies"];

/** Default density (g/cm³) when nothing says otherwise: aluminium. */
export const DEFAULT_DENSITY = 2.7;

export interface Density {
  /** g/cm³ */
  density: number;
  /** Where the number came from, for the estimate's label (tenet 8). */
  source: string;
}

/**
 * The one density every mass estimate uses: a density field on the material when
 * it has one (`density`, or `mechanical.density`), else a guess from its kind
 * (wood 0.7, plastic 1.2, metal 2.7), else aluminium. The source says which.
 */
export function densityOf(m: Material | undefined): Density {
  const direct = (m as { density?: unknown } | undefined)?.density;
  if (typeof direct === "number" && direct > 0) return { density: direct, source: `${m!.name} (${direct} g/cm³)` };
  const mech = (m?.mechanical as { density?: unknown } | undefined)?.density;
  if (typeof mech === "number" && mech > 0) return { density: mech, source: `${m!.name} (${mech} g/cm³)` };
  switch (m?.kind) {
    case "wood": return { density: 0.7, source: `${m.name} (wood, 0.7 g/cm³ assumed)` };
    case "plastic": return { density: 1.2, source: `${m.name} (plastic, 1.2 g/cm³ assumed)` };
    case "metal": case "painted": return { density: DEFAULT_DENSITY, source: `${m.name} (metal, ${DEFAULT_DENSITY} g/cm³ assumed)` };
    default: return { density: DEFAULT_DENSITY, source: `no material: aluminium ${DEFAULT_DENSITY} g/cm³ assumed` };
  }
}

export function metricsOf(solids: Record<string, SolidEval>, density = DEFAULT_DENSITY): Metrics {
  let volume = 0, bodies = 0;
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const s of Object.values(solids)) {
    if (!s.mesh) continue;
    bodies++;
    volume += s.volume ?? 0;
    const b = s.bounds;
    if (b) {
      min.x = Math.min(min.x, b.min.x); min.y = Math.min(min.y, b.min.y); min.z = Math.min(min.z, b.min.z);
      max.x = Math.max(max.x, b.max.x); max.y = Math.max(max.y, b.max.y); max.z = Math.max(max.z, b.max.z);
    }
  }
  const dim = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : 0);
  return { volume, mass: (volume / 1000) * density, density, width: dim(min.x, max.x), depth: dim(min.y, max.y), height: dim(min.z, max.z), bodies };
}

/** The names an intent expression may use: every parameter and every metric. */
export function intentScope(doc: CadDocument, metrics: Metrics): Record<string, number> {
  const { scope } = resolveParameters(doc.parameters ?? []); // a document mid-load may not have them yet
  return { ...scope, ...metrics };
}

function compare(a: number, b: number, op: Comparator): boolean {
  switch (op) {
    case "<=": return a <= b + 1e-9;
    case ">=": return a >= b - 1e-9;
    case "<": return a < b;
    case ">": return a > b;
    case "==": return Math.abs(a - b) <= 1e-9;
  }
}

export function checkIntent(intent: Intent, scope: Record<string, number>): IntentResult {
  try {
    const lhs = compileExpr(intent.lhs).eval(scope), rhs = compileExpr(intent.rhs).eval(scope);
    if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) return { intent, ok: false, lhs, rhs, error: "not a number" };
    return { intent, ok: compare(lhs, rhs, intent.op), lhs, rhs };
  } catch (e) {
    return { intent, ok: false, lhs: NaN, rhs: NaN, error: e instanceof Error ? e.message : String(e) };
  }
}

export function checkIntents(intents: Intent[], scope: Record<string, number>): IntentResult[] {
  return intents.map((i) => checkIntent(i, scope));
}

/** Parse "mass <= 120" / "wall >= t_min*2" into an intent (null when it isn't one). */
export function parseIntent(text: string, id: string, label?: string): Intent | null {
  const m = text.trim().match(/^(.+?)\s*(<=|>=|==|<|>)\s*(.+)$/);
  if (!m) return null;
  return { id, label: label ?? m[1].trim(), lhs: m[1].trim(), op: m[2] as Comparator, rhs: m[3].trim() };
}

export function intentText(i: Intent): string { return `${i.lhs} ${i.op} ${i.rhs}`; }

/** The value of `rhs - lhs` (how much headroom an intent has; negative when failing), for frontiers and sorting. */
export function headroom(r: IntentResult): number {
  if (r.error) return NaN;
  return r.intent.op === ">=" || r.intent.op === ">" ? r.lhs - r.rhs : r.rhs - r.lhs;
}

// ---- persistence: intents are kept per document (not yet document commands) ----

const KEY = (docId: string) => `chisel.intents.v1.${docId}`;

export function loadIntents(docId: string): Intent[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY(docId)) : null;
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function saveIntents(docId: string, intents: Intent[]): void {
  try { localStorage.setItem(KEY(docId), JSON.stringify(intents)); } catch { /* ignore */ }
}
