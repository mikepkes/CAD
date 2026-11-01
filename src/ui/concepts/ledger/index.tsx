// The Ledger: the model read back as sentences with live numbers, the design
// intents it must keep, and the agent's suggested fixes as tracked changes.
//
// Prop contract: <LedgerPanel/> needs no props (`createBackend` is a seam for
// tests: how the sampled fix search's geometry backend is made; by default it
// shares the Design Space's sampler backend). It reads the open document
// through useStore (session, rev, solids), shared hover state through useUi,
// features only through featureRows() (the kit's useFeatureRows) and intents
// through the shared intents store, which evaluates them once for every
// concept. Mount it as the "Ledger" tab of the right side panel; it renders in
// sketch mode too (the sentences stay live). Every edit it makes goes through
// store.editOperation / setParameterExpr.

import { useMemo, useState } from "react";
import { materialForComponent } from "../../../core/document";
import type { GeometryBackend } from "../../../core/geometry/backend";
import { useStore } from "../../../model/store";
import { densityOf } from "../../../model/concepts/intents";
import { useIntents } from "../../../model/concepts/intentsStore";
import { useFeatureRows } from "../../kit/useFeatureRows";
import { Sentence } from "./Sentence";
import { IntentsSection } from "./Intents";
import { Suggestions } from "./Suggestions";
import { documentTitle } from "./ledger";
import "./ledger.css";

export { useIntents } from "../../../model/concepts/intentsStore";
export type { IntentsState } from "../../../model/concepts/intentsStore";
export { useSuggestions } from "./ledger";
export type { Suggestion } from "./ledger";
export { clearFixCache } from "./Suggestions";

export interface LedgerPanelProps {
  /** How the sampled fix search's backend is made (default: the Design Space's shared sampler backend). */
  createBackend?: () => Promise<GeometryBackend>;
}

/** More feature sentences than this start folded under the intents. */
const FOLD_AFTER = 12;

export function LedgerPanel({ createBackend }: LedgerPanelProps = {}) {
  const session = useStore((s) => s.session);
  const rev = useStore((s) => s.rev);
  const doc = session.doc;
  const docName = useStore((s) => s.docName);
  const title = documentTitle(doc, docName);
  const rows = useFeatureRows();
  const scope = useIntents((s) => s.scope);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parameterNames = useMemo(() => doc.parameters.map((p) => p.name), [doc, rev]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const exprs = useMemo(() => Object.fromEntries(doc.parameters.map((p) => [p.name, p.expr])), [doc, rev]);

  // the sentences fold away under the intents on a long model (open on a short one, or once opened)
  const [featuresOpen, setFeaturesOpen] = useState<boolean | null>(null);
  const open = featuresOpen ?? rows.length <= FOLD_AFTER;

  return (
    <div className="ledger" role="region" aria-label="Ledger">
      <header className="ledger-head">
        <span className="k-label">Ledger</span>
        <h2 className="ledger-title">{title}</h2>
      </header>
      <IntentsSection />
      <Suggestions scope={scope} parameterNames={parameterNames} exprs={exprs} createBackend={createBackend} />
      <section className="ledger-section ledger-prose" aria-label="Features">
        <h3 className="k-label ledger-fold">
          <button type="button" className="ledger-fold-btn" aria-expanded={open} onClick={() => setFeaturesOpen(!open)}>
            <span aria-hidden="true">{open ? "▾" : "▸"}</span> Features ({rows.length})
          </button>
        </h3>
        {open && (rows.length === 0 ? (
          <p className="k-dim ledger-empty">Nothing built yet. Sketch and extrude, and the model reads back here.</p>
        ) : (
          rows.map((row) => <Sentence key={row.opId} row={row} doc={doc} timeline={session.timeline} density={densityOf(materialForComponent(doc, row.componentId)).density} />)
        ))}
      </section>
    </div>
  );
}

export default LedgerPanel;
