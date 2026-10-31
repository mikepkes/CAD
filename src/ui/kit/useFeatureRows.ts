// The feature rows every concept reads: one catalog call over the store's
// session, re-run when the document revision or the solids change. Pins, cards,
// the Ledger, the history strip and the intent line all share this.

import { useMemo } from "react";
import { useStore } from "../../model/store";
import { featureRows, type FeatureRow } from "../../model/concepts/featureCatalog";

export function useFeatureRows(): FeatureRow[] {
  const session = useStore((s) => s.session);
  const rev = useStore((s) => s.rev);
  const solids = useStore((s) => s.solids);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => featureRows(session.doc, session.timeline, session.rollbackIndex, solids), [session, rev, solids]);
}

/** The active component (root when the store has none). */
export function useActiveComponent(): string {
  const session = useStore((s) => s.session);
  const active = useStore((s) => s.activeComponentId);
  return active || session.doc.rootComponentId;
}
