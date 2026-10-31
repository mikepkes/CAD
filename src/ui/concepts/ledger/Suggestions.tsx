// The agent's proposed fixes for failing intents, shown as tracked changes:
// one dashed card per suggestion with Accept / Not now, and an Undo under each
// accepted one for the rest of the session. Two searches feed it, both in
// ledger.ts: the instant one over an intent's own parameters (suggestFixes),
// and, for intents that read a model metric (mass, height…), a sampled one
// (findMetricFixes) that builds candidate values of each bounded parameter on
// the Design Space's sampler backend, off the render path: async, cancelled
// when the document changes, its builds cached per document revision, and
// never touching the live document (the sampler clones it). A suggestion is
// applied through store.setParameterExpr.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../../model/store";
import { useIntents } from "../../../model/concepts/intentsStore";
import type { GeometryBackend } from "../../../core/geometry/backend";
import { Button, Card } from "../../kit/primitives";
import { evaluateVariant, getSamplerBackend } from "../space/sampler";
import {
  FixSearchStatus, Suggestion, VariantCache, findMetricFixes, fixSearchText, mergeSuggestions, needsMetricSearch, suggestFixes, suggestionText,
  useSuggestions, visibleSuggestions,
} from "./ledger";

export interface SuggestionsProps {
  /** The intent scope (parameters + metrics) the results were checked in. */
  scope: Record<string, number>;
  /** Names of the document's parameters (what a suggestion may move). */
  parameterNames: string[];
  /** Current expression of each parameter, remembered for Undo. */
  exprs: Record<string, string>;
  /** How the sampling backend is made (default: the Design Space's shared sampler backend). A seam for tests. */
  createBackend?: () => Promise<GeometryBackend>;
}

const variantCache = new VariantCache();
/** Forget every built variant (tests, or after the kernel is swapped). */
export function clearFixCache(): void { variantCache.clear(); }

interface FixSearch { status: FixSearchStatus; fixes: Suggestion[]; error: string | null }
const IDLE: FixSearch = { status: "idle", fixes: [], error: null };

export function Suggestions({ scope, parameterNames, exprs, createBackend }: SuggestionsProps) {
  const session = useStore((s) => s.session);
  const rev = useStore((s) => s.rev);
  const doc = session.doc;
  const intents = useIntents((s) => s.intents);
  const results = useIntents((s) => s.results);
  const bodies = useIntents((s) => s.metrics.bodies);
  const density = useIntents((s) => s.density);
  const dismissed = useSuggestions((s) => s.dismissed);
  const accepted = useSuggestions((s) => s.accepted);
  const { dismiss, accept, forget } = useSuggestions.getState();
  const instant = useMemo(() => suggestFixes(results, scope, parameterNames), [results, scope, parameterNames]);

  // ---- the sampled search for metric intents ----
  const docKey = `${doc.id}:${rev}`;
  const run = needsMetricSearch(results, bodies, doc.parameters);
  const [search, setSearch] = useState<FixSearch>(IDLE);
  const token = useRef(0);
  useEffect(() => {
    const t = ++token.current;
    if (!run) { setSearch(IDLE); return; }
    setSearch({ status: "searching", fixes: [], error: null });
    const snapshot = doc;
    (async () => {
      try {
        const backend = await getSamplerBackend(createBackend);
        if (t !== token.current) return;
        const evaluate = (overrides: Record<string, number>) => variantCache.get(docKey, overrides, (o) => evaluateVariant(backend, snapshot, o, density));
        const fixes = await findMetricFixes(intents, results, scope, snapshot.parameters, evaluate, { cancelled: () => t !== token.current });
        if (t !== token.current || !fixes) return;
        setSearch({ status: "done", fixes, error: null });
      } catch (e) {
        if (t !== token.current) return;
        setSearch({ status: "error", fixes: [], error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { token.current++; };
  }, [run, docKey, intents, results, scope, density]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(() => mergeSuggestions(instant, search.fixes, search.status), [instant, search]);
  const open = visibleSuggestions(all, { dismissed, accepted });
  const done = Object.values(accepted);
  const line = fixSearchText(search.status, search.fixes.length, search.error);
  if (open.length === 0 && done.length === 0 && !line) return null;

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
      {line && <p className="k-dim ledger-searching" role="status" aria-live="polite" data-status={search.status}>{line}</p>}
      {open.map((s) => (
        <Card key={s.id} variant="agent" className="ledger-suggestion" role="group" ariaLabel={`Suggestion for ${s.label}`}>
          <span className="ledger-suggestion-text">
            <span className="k-dim">{s.label}: </span>{suggestionText(s)}
            {s.confirm && <span className="k-dim ledger-confirm" title="This intent reads a model metric; the kernel must rebuild before the result is known."> · re-evaluate to confirm</span>}
            {s.note && <span className="k-dim ledger-confirm" title="Measured on a build of the document with this change; mass is an estimate from the material's density."> · built</span>}
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
