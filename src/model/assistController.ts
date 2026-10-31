// Organizational assist wired to the app: an AssistService over the store's
// session, fed after every change, and — when the user has an agent (an API
// key) and the assist is on — answered in the background by one short naming
// request per quiet spell. The request goes through agent.ts's client hook
// (`agentClient`), so a stand-in client (the tutorial video's replay) answers
// it too. Names are applied with the store's `editOperation` on the op that
// made the sketch or feature: undoable, and on the one command path.
//
// UI state (the setting, a snapshot of the items, whether a request is out)
// lives in `useAssist`, not in store.ts.

import { create } from "zustand";
import { useStore } from "./store";
import { agentClient } from "./agent";
import {
  AssistService, assistContext, buildNamingRequest, parseNamingResponse, renameViaEdit, setAssistHost,
  type AssistBy, type AssistItem, type ResolveResult,
} from "./assist";

export const ASSIST_LS = "chisel.assist.enabled";
/** How long the document must be quiet before the agent is asked (a sketch and the extrude that uses it go together). */
export const ASSIST_QUIET_MS = 2500;
/** Items named per request. */
const BATCH = 8;

function loadEnabled(): boolean {
  try { return typeof localStorage === "undefined" || localStorage.getItem(ASSIST_LS) !== "0"; } catch { return true; }
}

export interface AssistUiState {
  /** Organizational assist on (Settings). On by default; it does anything automatic only with an agent. */
  enabled: boolean;
  /** Every item (pending first in the inbox UI), refreshed on each inbox change. */
  items: AssistItem[];
  /** A naming request is out. */
  busy: boolean;
  setEnabled: (on: boolean) => void;
}

export const useAssist = create<AssistUiState>((set) => ({
  enabled: loadEnabled(),
  items: [],
  busy: false,
  setEnabled: (on) => {
    try { localStorage.setItem(ASSIST_LS, on ? "1" : "0"); } catch { /* ignore */ }
    set({ enabled: on });
    if (!on) service?.inbox.drop((i) => i.status === "pending");
    else schedule();
  },
}));

let service: AssistService | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let renames: Promise<unknown> = Promise.resolve();

/** The live service (null before startAssist). */
export function assistService(): AssistService | null { return service; }

/** Whether the embedded agent names items automatically right now. */
export function agentNaming(): boolean {
  return useAssist.getState().enabled && !!useStore.getState().apiKey;
}

function schedule(ms = ASSIST_QUIET_MS) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void runAuto(); }, ms);
}

/** Ask the agent to name pending items it hasn't tried yet (all of `ids` when given, tried or not). */
export async function nameWithAgent(ids?: string[]): Promise<void> {
  if (!service) return;
  if (ids) for (const id of ids) service.inbox.patch(id, { attempted: false, error: undefined });
  await runAuto(true);
}

async function runAuto(now = false): Promise<void> {
  if (!service) return;
  const st = useStore.getState();
  const ui = useAssist.getState();
  if (!ui.enabled || !st.apiKey || ui.busy) return;
  const todo = service.inbox.pending().filter((i) => !i.attempted);
  if (!todo.length) return;
  // Never in the user's way: wait while they drag, edit a dimension, or the agent is building.
  if (!now && (st.agentRunning || st.dragging || st.inlineEdit)) { schedule(); return; }
  const batch = todo.slice(0, BATCH);
  for (const i of batch) service.inbox.patch(i.id, { attempted: true });
  useAssist.setState({ busy: true });
  try {
    const doc = st.session.doc;
    const req = buildNamingRequest(batch.map((i) => ({ id: i.id, targetKind: i.targetKind, from: i.from, context: assistContext(doc, i, st.solids) })));
    const names = parseNamingResponse(await agentClient(st.apiKey).messages.create(req));
    for (const i of batch) {
      const cur = service.inbox.get(i.id);
      if (!cur || cur.status !== "pending") continue;
      if (!names[i.id]) { service.inbox.patch(i.id, { error: "no name suggested" }); continue; }
      await resolveAssist({ id: i.id, name: names[i.id] }, "agent");
    }
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    for (const i of batch) if (service.inbox.get(i.id)?.status === "pending") service.inbox.patch(i.id, { error: msg });
  } finally {
    useAssist.setState({ busy: false });
    if (service.inbox.pending().some((i) => !i.attempted)) schedule();
  }
}

/** Resolve an item (UI, tools): renames are serialized so two never edit history at once. */
export function resolveAssist(args: { id: string; name?: string; dismiss?: boolean }, by: AssistBy = "user"): Promise<ResolveResult> {
  if (!service) return Promise.resolve({ ok: false, error: "Organizational assist is not running" });
  const s = service;
  const next = renames.then(() => s.resolve(args, by));
  renames = next.catch(() => undefined);
  return next;
}

/** Start the assist over the store: returns a stop function (App mounts it once). */
export function startAssist(): () => void {
  const svc = new AssistService({
    doc: () => useStore.getState().session.doc,
    solids: () => useStore.getState().solids,
    rename: (target, name) => renameViaEdit(useStore.getState().session.doc, target, name, (opId, params) => useStore.getState().editOperation(opId, params), () => useStore.getState().session.doc),
    status: () => ({ enabled: useAssist.getState().enabled, agent: agentNaming() }),
  });
  service = svc;
  const observe = () => {
    const s = useStore.getState();
    svc.observe({ scope: s.session, doc: s.session.doc, openSketchId: s.mode === "sketch" ? s.activeSketchId : null });
  };
  observe();
  const unStore = useStore.subscribe((s, prev) => {
    if (s.rev !== prev.rev || s.session !== prev.session || s.mode !== prev.mode || s.activeSketchId !== prev.activeSketchId) observe();
    if (s.apiKey && !prev.apiKey) schedule();
  });
  const unInbox = svc.subscribe(() => {
    useAssist.setState({ items: [...svc.inbox.all()] });
    if (svc.inbox.pending().some((i) => !i.attempted)) schedule();
  });
  // Tools and MCP reach the inbox through the host; the UI resolves through the serialized path above.
  setAssistHost({ view: (o) => svc.view(o), resolve: (a, by) => resolveAssist(a as { id: string }, by), subscribe: (fn) => svc.subscribe(fn) });
  useAssist.setState({ items: [...svc.inbox.all()] });
  return () => {
    unStore(); unInbox();
    if (timer) clearTimeout(timer);
    timer = null;
    setAssistHost(null);
    if (service === svc) service = null;
  };
}
