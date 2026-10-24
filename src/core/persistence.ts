// Document persistence. The canonical state is the operation recipe, so a saved
// file stores only {units, nextId, operations, rollbackIndex}; the sketches,
// features and solved geometry are rebuilt by replay + recompute on load. This
// keeps files small, forward-compatible, and independent of solver output.
//
// Versioning: a file carries a `version`. On load it is migrated up to
// CURRENT_VERSION through a chain of pure JSON→JSON steps, so old files keep
// opening as the format evolves; a file from a newer app is refused rather than
// silently misread. Register the next migration under MIGRATIONS[CURRENT_VERSION]
// and bump CURRENT_VERSION when the stored shape changes incompatibly.

import { CadDocument, createDocument, TimelineGroup } from "./document";
import { OperationRecord } from "./command/types";

export const CURRENT_VERSION = 1;

export interface SerializedDocument {
  format: "chisel-cad";
  version: number;
  id: string;
  units: string;
  nextId: number;
  rollbackIndex: number;
  operations: OperationRecord[];
  timelineGroups?: TimelineGroup[];
}

/** A parsed-but-not-yet-validated document; migrations work on this loose shape. */
export type RawDocument = Record<string, unknown> & { format?: unknown; version?: unknown };

/**
 * MIGRATIONS[v] upgrades a document from version v to v+1. Each is a pure
 * function over the raw JSON and must set `version` to v+1.
 *
 * 0 → 1: legacy files had no `version` field (and sometimes no rollbackIndex /
 * timelineGroups). Normalize them.
 */
export const MIGRATIONS: Record<number, (raw: RawDocument) => RawDocument> = {
  0: (raw) => ({
    ...raw,
    version: 1,
    units: typeof raw.units === "string" ? raw.units : "mm",
    nextId: typeof raw.nextId === "number" ? raw.nextId : 1,
    rollbackIndex:
      typeof raw.rollbackIndex === "number"
        ? raw.rollbackIndex
        : Array.isArray(raw.operations) ? raw.operations.length : 0,
    timelineGroups: Array.isArray(raw.timelineGroups) ? raw.timelineGroups : [],
  }),
};

/** Run the migration chain to bring `raw` up to `current`. Pure; throws if the
 *  file is newer than supported or a migration step is missing. */
export function runMigrations(
  raw: RawDocument,
  migrations: Record<number, (raw: RawDocument) => RawDocument> = MIGRATIONS,
  current = CURRENT_VERSION
): RawDocument {
  let v = typeof raw.version === "number" ? raw.version : 0;
  if (v > current) {
    throw new Error(`Document is version ${v}, newer than this app supports (${current}). Update the app to open it.`);
  }
  let out = raw;
  while (v < current) {
    const step = migrations[v];
    if (!step) throw new Error(`No migration from document version ${v} to ${v + 1}`);
    out = step(out);
    v++;
  }
  return out;
}

export function serializeDocument(doc: CadDocument): string {
  const out: SerializedDocument = {
    format: "chisel-cad",
    version: CURRENT_VERSION,
    id: doc.id,
    units: doc.units,
    nextId: doc.nextId,
    rollbackIndex: doc.rollbackIndex,
    operations: doc.operations,
    timelineGroups: doc.timelineGroups,
  };
  return JSON.stringify(out, null, 2);
}

export function deserializeDocument(json: string): CadDocument {
  const parsed = JSON.parse(json) as RawDocument;
  if (parsed.format !== "chisel-cad") throw new Error("Not a Chisel CAD document");
  if (!Array.isArray(parsed.operations)) throw new Error("Document has no operations");
  const d = runMigrations(parsed) as unknown as SerializedDocument;
  const doc = createDocument(d.id || "doc1");
  doc.units = (d.units as CadDocument["units"]) ?? "mm";
  doc.nextId = typeof d.nextId === "number" ? d.nextId : 1;
  doc.operations = d.operations as OperationRecord[];
  doc.rollbackIndex = typeof d.rollbackIndex === "number" ? d.rollbackIndex : doc.operations.length;
  doc.timelineGroups = Array.isArray(d.timelineGroups) ? d.timelineGroups : [];
  // Derived state (parameters/sketches/features) is reconstructed by recompute.
  return doc;
}
