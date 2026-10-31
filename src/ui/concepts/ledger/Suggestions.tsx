// The agent's proposed fixes for failing intents, shown as tracked changes:
// one dashed card per suggestion with Accept / Not now, and an Undo under each
// accepted one for the rest of the session. The search is in ledger.ts; a
// suggestion is applied through store.setParameterExpr.

import { useMemo } from "react";
import { useStore } from "../../../model/store";
import { useIntents } from "../../../model/concepts/intentsStore";
import { Button, Card } from "../../kit/primitives";
import { Suggestion, suggestFixes, suggestionText, useSuggestions, visibleSuggestions } from "./ledger";

export interface SuggestionsProps {
  /** The intent scope (parameters + metrics) the results were checked in. */
  scope: Record<string, number>;
  /** Names of the document's parameters (what a suggestion may move). */
  parameterNames: string[];
  /** Current expression of each parameter, remembered for Undo. */
  exprs: Record<string, string>;
}

export function Suggestions({ scope, parameterNames, exprs }: SuggestionsProps) {
  const results = useIntents((s) => s.results);
  const dismissed = useSuggestions((s) => s.dismissed);
  const accepted = useSuggestions((s) => s.accepted);
  const { dismiss, accept, forget } = useSuggestions.getState();
  const all = useMemo(() => suggestFixes(results, scope, parameterNames), [results, scope, parameterNames]);
  const open = visibleSuggestions(all, { dismissed, accepted });
  const done = Object.values(accepted);
  if (open.length === 0 && done.length === 0) return null;

  const onAccept = (s: Suggestion) => {
    accept(s, exprs[s.param] ?? String(s.from));
    void useStore.getState().setParameterExpr(s.param, String(s.to));
  };
  const onUndo = (id: string) => {
    const a = accepted[id];
    if (!a) return;
    forget(id);
    void useStore.getState().setParameterExpr(a.suggestion.param, a.prevExpr);
  };

  return (
    <section className="ledger-section" aria-label="Suggestions">
      <h3 className="k-label">Suggestions</h3>
      {open.map((s) => (
        <Card key={s.id} variant="agent" className="ledger-suggestion" role="group" ariaLabel={`Suggestion for ${s.label}`}>
          <span className="ledger-suggestion-text">
            <span className="k-dim">{s.label}: </span>{suggestionText(s)}
            {s.confirm && <span className="k-dim ledger-confirm" title="This intent reads a model metric; the kernel must rebuild before the result is known."> · re-evaluate to confirm</span>}
          </span>
          <span className="ledger-suggestion-actions">
            <Button size="sm" accent onClick={() => onAccept(s)}>Accept</Button>
            <Button size="sm" ghost onClick={() => dismiss(s.id)}>Not now</Button>
          </span>
        </Card>
      ))}
      {done.map((a) => (
        <Card key={a.suggestion.id} variant="inline" className="ledger-suggestion" role="group" ariaLabel={`Accepted suggestion for ${a.suggestion.label}`}>
          <span className="ledger-suggestion-text"><span className="k-dim">{a.suggestion.label}: </span>{suggestionText(a.suggestion)}</span>
          <span className="ledger-suggestion-actions">
            <Button size="sm" ghost onClick={() => onUndo(a.suggestion.id)} title={`Back to ${a.prevExpr}`}>Undo</Button>
          </span>
        </Card>
      ))}
    </section>
  );
}
