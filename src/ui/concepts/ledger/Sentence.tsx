// One feature read back as a paragraph: its number, the catalog's sentence with
// live numbers where the parameters are, and the estimated mass of the body it
// made. Hovering it makes the feature hot everywhere; hovering a number makes
// that parameter hot. Edits go through store.editOperation, one in flight.

import { useMemo } from "react";
import type { CadDocument } from "../../../core/document";
import { useUi } from "../../../model/concepts/uiState";
import { FeatureRow, nameOf, paramsWith, unitLabel } from "../../../model/concepts/featureCatalog";
import { LiveNumber } from "../../kit/LiveNumber";
import { useEditQueue } from "../../kit/useEditQueue";
import { formatMass, massGrams, mergeSegments, paramToken, rowClasses } from "./ledger";

export interface SentenceProps {
  row: FeatureRow;
  doc: CadDocument;
  /** g/cm³ used for the mass estimate beside the paragraph. */
  density: number;
}

export function Sentence({ row, doc, density }: SentenceProps) {
  const hotFeature = useUi((s) => s.hotFeature);
  const hotParam = useUi((s) => s.hotParam);
  const { setHotFeature, setHotParam } = useUi.getState();
  const edit = useEditQueue();
  const segments = useMemo(() => mergeSegments(row.spec.sentence(row.op, (id) => nameOf(doc, id))), [row.spec, row.op, doc]);
  const mass = massGrams(row.solid?.volume, density);
  const title = [row.name, row.error && `Error: ${row.error}`, row.rolledBack && "Rolled back", row.suppressed && "Suppressed"].filter(Boolean).join(" · ");

  return (
    <p
      className={rowClasses(row, hotFeature === row.featureId)}
      data-feature={row.featureId}
      title={title}
      onMouseEnter={() => setHotFeature(row.featureId)}
      onMouseLeave={() => setHotFeature(null)}
    >
      <span className="k-num ledger-num">{row.num}</span>
      <span className="ledger-text">
        {segments.map((s, i) => {
          if ("ref" in s) return <span key={i} className="ledger-ref" data-ref={s.ref} title={s.ref}>{s.text}</span>;
          if ("text" in s) return <span key={i}>{s.text}</span>;
          const tok = paramToken(row, s.param);
          if (tok.kind === "text") return <span key={i} className="k-mono k-dim">{tok.text}</span>;
          return (
            <LiveNumber
              key={i}
              value={tok.value}
              spec={tok.spec}
              unit={unitLabel(tok.spec.unit)}
              name={`${row.name} ${tok.spec.label.toLowerCase()}`}
              hot={hotParam?.featureId === row.featureId && hotParam.key === s.param}
              onChange={(v) => edit.live(row.opId, paramsWith(row, s.param, v))}
              onCommit={(v) => edit.commit(row.opId, paramsWith(row, s.param, v))}
              onHover={(hot) => setHotParam(hot ? { featureId: row.featureId, key: s.param } : null)}
            />
          );
        })}
      </span>
      {mass != null && (
        <span className="k-num k-dim ledger-mass" title={`Estimated from the body's volume at ${density} g/cm³ (est.)`}>{formatMass(mass)}</span>
      )}
    </p>
  );
}
