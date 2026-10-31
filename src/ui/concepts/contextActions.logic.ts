// The decisions behind the context hotkey actions (contextActions.ts), kept
// apart from the stores: where a history step lands, which feature card opens
// next, which component is "up", the lens's next size. Pure, tested in Node
// (test/contextActions.test.ts); the installer only reads state and sends.

import type { FeatureRow } from "../../model/concepts/featureCatalog";
import type { CadDocument } from "../../core/document";
import type { OperationRecord } from "../../core/command/types";
import { crumbPath, rangeValue, rowsInScope, snapRollback, stripEntries, stripRange, type StripRange } from "./workbench/workbench";
import type { LensShape, LensSize } from "./lens/lens";

// ---- history ----

/** The history strip's range for the active component: the same stops its range input snaps to. */
export function historyRange(rows: FeatureRow[], doc: CadDocument, activeId: string, timeline: OperationRecord[], rollbackIndex: number): StripRange {
  return stripRange(stripEntries(rows, doc, activeId, timeline, rollbackIndex));
}

/** The rollback index one stop back (`dir` −1) or forward (+1) from where the strip shows the marker, or null when
 *  there is no stop that way. The marker is read the way the strip reads it (clamped to the range, snapped to a
 *  stop), so a marker between two visible entries steps to the neighbouring stops, never onto a hidden op. */
export function stepRollback(range: StripRange, rollbackIndex: number, dir: -1 | 1): number | null {
  if (!range.stops.length) return null;
  const at = snapRollback(range, rangeValue(range, rollbackIndex));
  const k = range.stops.indexOf(at);
  const next = range.stops[k + dir];
  return next == null ? null : next;
}

// ---- feature cards ----

/** The rows a card can cycle through: the active component's scope, in timeline order (the pins' and the strip's order). */
export function cycleRows(rows: FeatureRow[], doc: CadDocument, activeId: string): FeatureRow[] {
  return rowsInScope(rows, doc, activeId).rows;
}

/** The feature after (`dir` +1) or before (−1) the open one, wrapping; from none (or one outside the list) it starts
 *  at the first going forward and the last going back. Null only for an empty list. */
export function cycleFeature(ids: string[], open: string | null, dir: -1 | 1): string | null {
  if (!ids.length) return null;
  const i = open == null ? -1 : ids.indexOf(open);
  if (i < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(i + dir + ids.length) % ids.length];
}

// ---- components ----

/** The parent of the active component on its crumb path, or null at the root (or for an unknown / detached id). */
export function parentComponent(doc: CadDocument, activeId: string): string | null {
  const path = crumbPath(doc, activeId);
  return path.length > 1 ? path[path.length - 2].id : null;
}

// ---- lens ----

const SIZE_ORDER: LensSize[] = ["S", "M", "L"];

/** The lens size after `size`, wrapping L → S. */
export function nextLensSize(size: LensSize): LensSize {
  return SIZE_ORDER[(SIZE_ORDER.indexOf(size) + 1) % SIZE_ORDER.length];
}

/** The other lens shape (a circle ↔ a wipe line). */
export function otherShape(shape: LensShape): LensShape {
  return shape === "lens" ? "wipe" : "lens";
}
