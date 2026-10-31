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

import { useMemo } from "react";
import { materialForComponent } from "../../../core/document";
import type { GeometryBackend } from "../../../core/geometry/backend";
import { useStore } from "../../../model/store";
import { densityOf } from "../../../model/concepts/intents";
import { useIntents } from "../../../model/concepts/intentsStore";
import { useFeatureRows } from "../../kit/useFeatureRows";
import { Sentence } from "./Sentence";
import { IntentsSection } from "./Intents";
import { Suggestions } from "./Suggestions";
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

export function LedgerPanel({ createBackend }: LedgerPanelProps = {}) {
  const session = useStore((s) => s.session);
  const rev = useStore((s) => s.rev);
  const doc = session.doc;
  const title = doc.components[doc.rootComponentId]?.name ?? doc.id;
  const rows = useFeatureRows();
  const scope = useIntents((s) => s.scope);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parameterNames = useMemo(() => doc.parameters.map((p) => p.name), [doc, rev]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const exprs = useMemo(() => Object.fromEntries(doc.parameters.map((p) => [p.name, p.expr])), [doc, rev]);

  return (
    <div className="ledger" role="region" aria-label="Ledger">
      <header className="ledger-head">
        <span className="k-label">Ledger</span>
        <h2 className="ledger-title">{title}</h2>
      </header>
      <section className="ledger-section ledger-prose" aria-label="Features">
        {rows.length === 0 ? (
          <p className="k-dim ledger-empty">Nothing built yet. Sketch and extrude, and the model reads back here.</p>
        ) : (
          rows.map((row) => <Sentence key={row.opId} row={row} doc={doc} density={densityOf(materialForComponent(doc, row.componentId)).density} />)
        )}
      </section>
      <IntentsSection />
      <Suggestions scope={scope} parameterNames={parameterNames} exprs={exprs} createBackend={createBackend} />
    </div>
  );
}

export default LedgerPanel;
