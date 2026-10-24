// Document persistence. The canonical state is the operation recipe, so a saved
// file stores only {units, nextId, operations, rollbackIndex}; the sketches,
// features and solved geometry are rebuilt by replay + recompute on load. This
// keeps files small, forward-compatible, and independent of solver output.

import { CadDocument, createDocument, TimelineGroup } from "./document";
import { OperationRecord } from "./command/types";

export interface SerializedDocument {
  format: "chisel-cad";
  version: 1;
  id: string;
  units: string;
  nextId: number;
  rollbackIndex: number;
  operations: OperationRecord[];
  timelineGroups?: TimelineGroup[];
}

export function serializeDocument(doc: CadDocument): string {
  const out: SerializedDocument = {
    format: "chisel-cad",
    version: 1,
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
  const d = JSON.parse(json) as Partial<SerializedDocument>;
  if (d.format !== "chisel-cad") throw new Error("Not a Chisel CAD document");
  if (!Array.isArray(d.operations)) throw new Error("Document has no operations");
  const doc = createDocument(d.id || "doc1");
  doc.units = (d.units as CadDocument["units"]) ?? "mm";
  doc.nextId = typeof d.nextId === "number" ? d.nextId : 1;
  doc.operations = d.operations as OperationRecord[];
  doc.rollbackIndex = typeof d.rollbackIndex === "number" ? d.rollbackIndex : doc.operations.length;
  doc.timelineGroups = Array.isArray(d.timelineGroups) ? d.timelineGroups : [];
  // Derived state (parameters/sketches/features) is reconstructed by recompute.
  return doc;
}
