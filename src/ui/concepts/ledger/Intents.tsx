// The design intents: each as "label: lhs op rhs" with a pass/fail glyph, a
// scrubbable limit when the rhs is a plain number, and its current value.
// Reads and edits the list through the shared intents store, whose results
// follow the document.

import { FormEvent, useState } from "react";
import { useIntents } from "../../../model/concepts/intentsStore";
import { Button, Input } from "../../kit/primitives";
import { LiveNumber } from "../../kit/LiveNumber";
import { formatNow, intentGlyph, plainNumber, rhsStep, uncheckedResult } from "./ledger";

export function IntentsSection() {
  const intents = useIntents((s) => s.intents);
  const results = useIntents((s) => s.results);
  const { add, remove, update } = useIntents.getState();
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [rejected, setRejected] = useState(false);

  const commit = () => {
    const made = add(text, label);
    setRejected(!made);
    if (made) { setText(""); setLabel(""); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); commit(); };

  return (
    <section className="ledger-section" aria-label="Design intents">
      <h3 className="k-label">Intents</h3>
      {intents.length === 0 && <p className="k-dim ledger-empty">No intents yet. Add one like “mass &lt;= 120”.</p>}
      <ul className="ledger-intents">
        {intents.map((intent, i) => {
          const r = results[i] ?? uncheckedResult(intent);
          const g = intentGlyph(r);
          const rhs = plainNumber(intent.rhs);
          const unit = intent.unit ? ` ${intent.unit}` : "";
          return (
            <li key={intent.id} className={`ledger-intent ${g.state}`}>
              <span className={`ledger-glyph ${g.state}`} role="img" aria-label={g.label}>{g.glyph}</span>
              <span className="ledger-intent-text">
                <span className="ledger-intent-label">{intent.label}: </span>
                <span className="k-mono">{intent.lhs} {intent.op} </span>
                {rhs != null ? (
                  <LiveNumber
                    value={rhs}
                    spec={{ step: rhsStep(rhs) }}
                    unit={intent.unit}
                    name={`${intent.label} limit`}
                    onChange={(v) => update(intent.id, { rhs: String(v) })}
                  />
                ) : (
                  <span className="k-mono">{intent.rhs}</span>
                )}
              </span>
              <span className="k-num k-dim ledger-now" title={r.error ?? undefined}>now {formatNow(r.lhs)}{unit}</span>
              <Button icon ghost size="sm" ariaLabel={`Remove ${intent.label}`} onClick={() => remove(intent.id)}>×</Button>
            </li>
          );
        })}
      </ul>
      <form className="ledger-add" onSubmit={submit} aria-label="Add intent">
        <Input mono ariaLabel="Intent" placeholder="mass <= 120" value={text} invalid={rejected} onChange={(v) => { setText(v); setRejected(false); }} />
        <Input ariaLabel="Label" placeholder="Label" value={label} onChange={setLabel} />
        {/* a real submit button, so Enter in either field adds the intent */}
        <Button size="sm" type="submit" disabled={!text.trim()} title="Add intent">Add</Button>
        {rejected && <span className="ledger-reject" role="alert">Write a comparison: name &lt;= value.</span>}
      </form>
    </section>
  );
}
