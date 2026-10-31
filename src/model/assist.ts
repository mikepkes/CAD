// Organizational assist: the app noticing housekeeping an agent can do for the
// user, starting with names. A sketch finished as "Sketch 25" or a feature
// left as "Extrude" goes into an inbox with the context needed to name it well
// (its plane or face, its entities and dimensions, what uses it). The embedded
// agent, when the user has one, answers the inbox in the background with one
// short, cheap request; external agents read the same inbox over MCP
// (`get_assist_inbox`, the `chisel://assist/inbox` resource) and answer it with
// `resolve_assist`. Every name is applied as an edit of the operation that made
// the sketch or feature (its `name` param), so it is undoable, replays, and
// survives a rollback.
//
// Pure: no React, no store. The store wiring is assistController.ts; the stdio
// MCP server builds its own AssistService over its headless session.

import type Anthropic from "@anthropic-ai/sdk";
import type { CadDocument } from "../core/document";
import type { OperationRecord } from "../core/command/types";
import type { SolidEval } from "../core/features";
import { isDimension } from "../sketch/types";

// ---------------------------------------------------------------- the inbox

export type AssistStatus = "pending" | "done" | "dismissed";
export type AssistTargetKind = "sketch" | "feature";
/** Who resolved an item: the embedded agent, an external (MCP) agent, or the user. */
export type AssistBy = "agent" | "external" | "user";

export interface AssistItem {
  id: string;
  /** What is asked for. Only naming so far. */
  kind: "name";
  /** The sketch or feature id. */
  target: string;
  targetKind: AssistTargetKind;
  status: AssistStatus;
  /** When it was queued (ms since epoch). */
  created: number;
  /** The default name it had when queued ("Sketch 3", "Extrude"). */
  from: string;
  /** The name it was given (done items). */
  name?: string;
  by?: AssistBy;
  resolved?: number;
  /** The last automatic attempt failed with this. */
  error?: string;
  /** The embedded agent has already been asked about it (so a failure isn't retried in a loop). */
  attempted?: boolean;
}

export class AssistInbox {
  private items: AssistItem[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  /** Bumped on every change (for React snapshots). */
  version = 0;

  all(): AssistItem[] { return this.items; }
  get(id: string): AssistItem | undefined { return this.items.find((i) => i.id === id); }
  pending(): AssistItem[] { return this.items.filter((i) => i.status === "pending"); }
  /** Done items, newest first. */
  recent(n = 5): AssistItem[] { return this.items.filter((i) => i.status === "done").sort((a, b) => (b.resolved ?? 0) - (a.resolved ?? 0)).slice(0, n); }

  /** Queue a naming item; null when one is already pending for that target. */
  enqueue(target: string, targetKind: AssistTargetKind, from: string, now = Date.now()): AssistItem | null {
    if (this.items.some((i) => i.target === target && i.status === "pending")) return null;
    const item: AssistItem = { id: `as${++this.seq}`, kind: "name", target, targetKind, status: "pending", created: now, from };
    this.items.push(item);
    // Keep the inbox small: forget the oldest resolved items beyond 50.
    const resolved = this.items.filter((i) => i.status !== "pending");
    if (resolved.length > 50) { const drop = new Set(resolved.slice(0, resolved.length - 50)); this.items = this.items.filter((i) => !drop.has(i)); }
    this.changed();
    return item;
  }

  patch(id: string, p: Partial<AssistItem>): void {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.items = this.items.map((x, k) => (k === i ? { ...x, ...p } : x));
    this.changed();
  }

  markDone(id: string, name: string, by: AssistBy, now = Date.now()): void { this.patch(id, { status: "done", name, by, resolved: now, error: undefined }); }
  dismiss(id: string, now = Date.now()): void { this.patch(id, { status: "dismissed", resolved: now }); }
  /** Drop items (a target that no longer exists). */
  drop(pred: (i: AssistItem) => boolean): void {
    const next = this.items.filter((i) => !pred(i));
    if (next.length !== this.items.length) { this.items = next; this.changed(); }
  }
  clear(): void { if (this.items.length) { this.items = []; this.changed(); } }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() { this.version++; for (const fn of [...this.listeners]) fn(); }
}

// ---------------------------------------------------------------- targets and default names

/** The operation that made a sketch or feature (its params carry the name). */
export function creatingOp(timeline: OperationRecord[], id: string): OperationRecord | undefined {
  return timeline.find((o) => o.createdIds[0] === id && (o.type === "sketch.create" || o.type.startsWith("feature.")));
}

/** The current name of a sketch or feature, or undefined when it isn't in the document. */
export function currentName(doc: CadDocument, id: string): string | undefined {
  return doc.sketches[id]?.name ?? (doc.features[id] as { name?: string } | undefined)?.name;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A name the app made up rather than one somebody chose: "Sketch 12", "Extrude", "Fillet 3",
 *  or any name the creating op didn't set. */
export function isDefaultName(doc: CadDocument, timeline: OperationRecord[], id: string): boolean {
  const name = currentName(doc, id);
  if (name === undefined) return false;
  if (/^Sketch \d+$/i.test(name)) return true;
  const f = doc.features[id] as { kind?: string } | undefined;
  if (f?.kind && new RegExp(`^${capital(f.kind)}( \\d+)?$`, "i").test(name)) return true;
  const op = creatingOp(timeline, id);
  return !!op && !(typeof op.params.name === "string" && op.params.name.trim());
}

/** The op params that rename the thing `op` created. */
export function renameParams(op: OperationRecord, name: string): Record<string, unknown> {
  return { ...op.params, name };
}

/** A usable name: one line, no quotes or trailing punctuation, at most 48 characters. Empty when nothing is left. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let s = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^["'`“‘]+|["'`”’]+$/g, "").replace(/[.;:,]+$/, "").trim();
  if (s.length > 48) s = s.slice(0, 48).replace(/\s+\S*$/, "").trim() || s.slice(0, 48);
  return s;
}

// ---------------------------------------------------------------- the watcher (when to queue)

/** What the watcher looks at after each change. */
export interface AssistSnapshot {
  /** Identity of the open document (a new one, or a load, re-baselines: nothing in it is queued). */
  scope: unknown;
  doc: CadDocument;
  /** The sketch being edited (app: in sketch mode, the active sketch; null when none). Undefined in a
   *  headless session: then the newest sketch no feature uses yet counts as still open. */
  openSketchId?: string | null;
}

export interface AssistTarget { target: string; targetKind: AssistTargetKind; from: string }

const usesSketch = (f: unknown, sketchId: string): boolean => {
  let hit = false;
  const walk = (v: unknown, key: string) => {
    if (hit) return;
    if (typeof v === "string") { if (v === sketchId && /sketch/i.test(key)) hit = true; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(f, "");
  return hit;
};

/** Features that read a sketch (any field naming a sketch that holds its id). */
export function featuresUsing(doc: CadDocument, sketchId: string): string[] {
  return Object.values(doc.features).filter((f) => usesSketch(f, sketchId)).map((f) => f.id);
}

/** Decides what to queue: a feature when it first appears with a default name; a sketch with a
 *  default name once it is finished (no longer the open sketch). Nothing already in a document when it
 *  is opened is queued, and an undo/redo or rollback never queues the same operation twice. */
export class AssistWatcher {
  private scope: unknown = Symbol("none");
  private seen = new Set<string>();
  /** New sketches waiting to be finished. */
  private waiting = new Set<string>();

  /** Returns the targets to queue now; `reset` when the document changed under it. */
  observe(s: AssistSnapshot): { reset: boolean; targets: AssistTarget[] } {
    const { doc } = s;
    const ops = doc.operations;
    const keyOf = (op: OperationRecord) => `${op.createdIds[0]}@${op.opId}@${op.at}`;
    const made = ops.filter((op) => {
      const id = op.createdIds[0];
      if (!id) return false;
      return op.type === "sketch.create" ? !!doc.sketches[id] : op.type.startsWith("feature.") && !!doc.features[id];
    });
    if (s.scope !== this.scope) {
      this.scope = s.scope;
      this.seen = new Set(made.map(keyOf));
      this.waiting.clear();
      return { reset: true, targets: [] };
    }
    const targets: AssistTarget[] = [];
    for (const op of made) {
      const key = keyOf(op);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const id = op.createdIds[0];
      if (!isDefaultName(doc, ops, id)) continue;
      if (op.type === "sketch.create") this.waiting.add(id);
      else targets.push({ target: id, targetKind: "feature", from: currentName(doc, id) ?? id });
    }
    if (this.waiting.size) {
      const open = s.openSketchId !== undefined ? s.openSketchId : headlessOpenSketch(doc);
      for (const id of [...this.waiting]) {
        if (!doc.sketches[id]) { this.waiting.delete(id); continue; }
        if (id === open) continue;
        this.waiting.delete(id);
        if (isDefaultName(doc, ops, id)) targets.push({ target: id, targetKind: "sketch", from: doc.sketches[id].name });
      }
    }
    // Sketches before features, in history order (a sketch finished by the feature that uses it reads first).
    targets.sort((a, b) => (a.targetKind === b.targetKind ? 0 : a.targetKind === "sketch" ? -1 : 1));
    return { reset: false, targets };
  }
}

/** Without an editor, the newest sketch that no feature reads yet is the one still being drawn. */
function headlessOpenSketch(doc: CadDocument): string | null {
  for (let i = doc.operations.length - 1; i >= 0; i--) {
    const op = doc.operations[i];
    if (op.type !== "sketch.create") continue;
    const id = op.createdIds[0];
    if (!id || !doc.sketches[id]) continue;
    return featuresUsing(doc, id).length ? null : id;
  }
  return null;
}

// ---------------------------------------------------------------- context (what a namer needs)

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function sketchSummary(doc: CadDocument, sketchId: string) {
  const sk = doc.sketches[sketchId];
  if (!sk) return undefined;
  const counts: Record<string, number> = {};
  let construction = 0;
  const xs: number[] = [], ys: number[] = [];
  for (const e of Object.values(sk.entities)) {
    if (e.kind === "point") { xs.push(e.x); ys.push(e.y); continue; }
    if ((e as { construction?: boolean }).construction) { construction++; continue; }
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  for (const e of Object.values(sk.entities)) {
    if ((e.kind === "circle" || e.kind === "arc") && sk.entities[e.center]?.kind === "point") {
      const c = sk.entities[e.center] as { x: number; y: number };
      xs.push(c.x - e.r, c.x + e.r); ys.push(c.y - e.r, c.y + e.r);
    }
  }
  const dims = Object.values(sk.constraints).filter(isDimension).map((d) => ({
    type: d.type,
    expr: d.expr,
    value: d.type === "angle" ? r3((d.value * 180) / Math.PI) : r3(d.value),
    ...(d.driven ? { driven: true } : {}),
  }));
  const geometric = Object.values(sk.constraints).filter((c) => !isDimension(c)).map((c) => c.type);
  const place: Record<string, unknown> = {};
  if (sk.faceRef) {
    place.onFace = sk.faceRef.name ?? true;
    const fid = sk.faceRef.name?.split(":")[0];
    const f = fid ? (doc.features[fid] as { name?: string; kind?: string } | undefined) : undefined;
    if (f) place.faceOfFeature = { id: fid, name: f.name, kind: f.kind };
  } else if (sk.datumId) {
    place.datumPlane = doc.planes[sk.datumId]?.name ?? sk.datumId;
  } else {
    place.plane = sk.planeId;
  }
  if (sk.componentId && sk.componentId !== doc.rootComponentId) place.component = doc.components[sk.componentId]?.name ?? sk.componentId;
  return {
    id: sk.id,
    name: sk.name,
    ...place,
    entities: counts,
    ...(construction ? { constructionEntities: construction } : {}),
    ...(xs.length ? { size: { width: r3(Math.max(...xs) - Math.min(...xs)), height: r3(Math.max(...ys) - Math.min(...ys)) } } : {}),
    dimensions: dims,
    constraints: geometric,
  };
}

/** A feature's defining fields, compact: its kind, the names of sketches/bodies it reads, small params. */
function featureSummary(doc: CadDocument, id: string): Record<string, unknown> | undefined {
  const f = doc.features[id] as unknown as Record<string, unknown> | undefined;
  if (!f) return undefined;
  const out: Record<string, unknown> = { id, kind: f.kind, name: f.name };
  for (const [k, v] of Object.entries(f)) {
    if (k === "id" || k === "kind" || k === "name" || /Values?$/.test(k) || v == null) continue;
    if (typeof v === "string" && doc.sketches[v]) { out[k] = { sketch: v, name: doc.sketches[v].name }; continue; }
    if (typeof v === "string" && doc.features[v]) { out[k] = { feature: v, name: (doc.features[v] as { name?: string }).name }; continue; }
    if (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 80)) { out[k] = v; continue; }
    const json = JSON.stringify(v);
    if (json && json.length <= 200) out[k] = v;
  }
  return out;
}

/** Everything a namer should know about one item's target, fresh from the document. */
export function assistContext(doc: CadDocument, item: Pick<AssistItem, "target" | "targetKind">, solids?: Record<string, SolidEval>): Record<string, unknown> {
  const ops = doc.operations;
  const params = (refs: string[]) => {
    const text = JSON.stringify(refs);
    const used = doc.parameters.filter((p) => new RegExp(`\\b${p.name.replace(/[^A-Za-z0-9_]/g, "")}\\b`).test(text));
    return used.length ? { parameters: used.map((p) => ({ name: p.name, expr: p.expr, value: r3(p.value) })) } : {};
  };
  const otherNames = () => {
    // Names already in use, so the namer can be consistent and avoid duplicates.
    const names = [...Object.values(doc.sketches).map((s) => s.name), ...Object.values(doc.features).map((f) => (f as { name?: string }).name ?? "")]
      .filter((n) => n && !/^Sketch \d+$/.test(n));
    return names.length ? { namesInUse: [...new Set(names)].slice(0, 30) } : {};
  };
  if (item.targetKind === "sketch") {
    const sk = sketchSummary(doc, item.target);
    if (!sk) return { missing: true };
    const usedBy = featuresUsing(doc, item.target).map((fid) => featureSummary(doc, fid)!).filter(Boolean);
    return { sketch: sk, usedBy, ...params(sk.dimensions.map((d) => d.expr)), ...otherNames() };
  }
  const f = featureSummary(doc, item.target);
  if (!f) return { missing: true };
  const sketches = Object.values(f).flatMap((v) => (v && typeof v === "object" && "sketch" in (v as object) ? [sketchSummary(doc, (v as { sketch: string }).sketch)] : [])).filter(Boolean);
  const idx = ops.findIndex((o) => o.createdIds[0] === item.target);
  const before = ops.slice(0, Math.max(0, idx)).filter((o) => o.type.startsWith("feature.") && doc.features[o.createdIds[0]]).slice(-3)
    .map((o) => (doc.features[o.createdIds[0]] as { name?: string }).name);
  const solid = solids?.[item.target];
  return {
    feature: f,
    ...(sketches.length ? { sketches } : {}),
    ...(before.length ? { previousFeatures: before } : {}),
    ...(solid?.bounds ? { bounds: { min: solid.bounds.min, max: solid.bounds.max } } : {}),
    ...params(Object.values(f).filter((v): v is string => typeof v === "string")),
    ...otherNames(),
  };
}

/** A plain, deterministic guess at a name from the context (the offline fallback and the video's mock). */
export function heuristicName(item: Pick<AssistItem, "targetKind" | "from">, ctx: Record<string, unknown>): string {
  const op = (f: Record<string, unknown> | undefined) => String(f?.operation ?? "new");
  const roleOf = (f: Record<string, unknown> | undefined): string | null => {
    if (!f) return null;
    const k = String(f.kind);
    if (k === "extrude") return op(f) === "cut" ? (f.extent === "throughAll" ? "Through cut" : "Pocket") : op(f) === "join" ? "Boss" : "Base";
    if (k === "revolve") return op(f) === "cut" ? "Revolved cut" : "Revolved body";
    if (k === "loft") return "Loft";
    if (k === "sweep") return "Sweep";
    return capital(k);
  };
  if (item.targetKind === "sketch") {
    const sk = ctx.sketch as { entities?: Record<string, number>; onFace?: unknown } | undefined;
    const e = sk?.entities ?? {};
    const n = (k: string) => e[k] ?? 0;
    const shape = n("circle") && !n("line") && !n("arc") ? (n("circle") > 1 ? "Circles" : "Circle")
      : n("line") === 4 && !n("arc") && !n("circle") ? "Rectangle"
        : n("line") && n("arc") && !n("circle") ? "Rounded outline"
          : n("spline") ? "Curve" : n("line") === 1 && Object.keys(e).length === 1 ? "Line" : "Outline";
    const used = (ctx.usedBy as Record<string, unknown>[] | undefined)?.[0];
    const role = roleOf(used);
    if (role) return `${role} ${shape === "Line" ? "path" : "profile"}`;
    return sk?.onFace ? `${shape} on face` : `${shape} sketch`;
  }
  const f = ctx.feature as Record<string, unknown> | undefined;
  const k = String(f?.kind ?? "");
  if (k === "fillet") return "Edge rounds";
  if (k === "chamfer") return "Edge chamfers";
  if (k === "shell") return "Shell wall";
  if (k === "hole") return "Hole";
  if (k === "pattern") return `${capital(String(f?.mode ?? "linear"))} array`;
  if (k === "mirror") return "Mirrored half";
  return roleOf(f) ?? (cleanName(item.from) || "Feature");
}

/** The inbox as the UI shows it: pending items oldest first, and the last few named (newest first). */
export function inboxSections(items: AssistItem[], recentCount = 5): { pending: AssistItem[]; recent: AssistItem[] } {
  return {
    pending: items.filter((i) => i.status === "pending").sort((a, b) => a.created - b.created),
    recent: items.filter((i) => i.status === "done").sort((a, b) => (b.resolved ?? 0) - (a.resolved ?? 0)).slice(0, recentCount),
  };
}

/** The name the UI offers for a pending item before any agent has answered. */
export function suggestName(doc: CadDocument, item: Pick<AssistItem, "target" | "targetKind" | "from">): string {
  return heuristicName(item, assistContext(doc, item));
}

// ---------------------------------------------------------------- the naming request

/** A small, cheap current model for naming. */
export const ASSIST_MODEL = "claude-haiku-5-5";

/** The naming request's system prompt; also how a stand-in client (the video's mock) recognises one. */
export const ASSIST_SYSTEM = `You name the sketches and features of a parametric CAD model so the history reads like a designer wrote it.
For each item you get its current default name and its context (the plane or face a sketch sits on and the feature that owns that face, its entities, size and dimensions, the features that use it; for a feature its kind and parameters, the sketches it reads, the features before it, and the names already in use).
Reply with a short human name per item: 1 to 4 words, sentence case, saying what the thing is or does in the design ("Back plate profile", "Lip", "Mounting holes", "Cable slot"). No ids, no numbers unless they matter, no quotes. Don't repeat a name already in use. If you can't tell, a plain descriptive name ("Rectangular pocket") is fine.`;

const NAMES_SCHEMA = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"], additionalProperties: false },
    },
  },
  required: ["names"],
  additionalProperties: false,
};

export interface NamingRequestItem { id: string; targetKind: AssistTargetKind; from: string; context: Record<string, unknown> }

/** One request naming every item: Haiku, low effort, no thinking, a JSON-schema answer. */
export function buildNamingRequest(items: NamingRequestItem[], model = ASSIST_MODEL): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: 1024,
    system: ASSIST_SYSTEM,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: NAMES_SCHEMA } },
    messages: [{ role: "user", content: JSON.stringify({ items: items.map((i) => ({ id: i.id, kind: i.targetKind, currentName: i.from, context: i.context })) }) }],
  };
}

/** Is this a naming request (rather than a turn of the agent's conversation)? */
export function isAssistRequest(body: { system?: unknown }): boolean {
  return body.system === ASSIST_SYSTEM;
}

/** The names in a naming reply, by item id (cleaned; empty names dropped). Throws on a refusal or unreadable reply. */
export function parseNamingResponse(msg: Pick<Anthropic.Message, "content" | "stop_reason">): Record<string, string> {
  if (msg.stop_reason === "refusal") throw new Error("the model declined to name these");
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw new Error("unreadable naming reply"); }
  const list = (parsed as { names?: unknown }).names;
  if (!Array.isArray(list)) throw new Error("unreadable naming reply");
  const out: Record<string, string> = {};
  for (const e of list as { id?: unknown; name?: unknown }[]) {
    const name = cleanName(e?.name);
    if (typeof e?.id === "string" && name) out[e.id] = name;
  }
  return out;
}

/** A canned reply to a naming request: the heuristic name for each item (or `names[currentName]` when
 *  given). The video's replay client answers naming requests with this, deterministically. */
export function assistReplyMessage(body: Anthropic.MessageCreateParamsNonStreaming, names: Record<string, string> | ((currentName: string) => string | undefined) = {}): Anthropic.Message {
  const nameFor = typeof names === "function" ? names : (cur: string) => names[cur];
  const first = body.messages[0];
  const raw = typeof first?.content === "string" ? first.content : "";
  let items: { id: string; kind: AssistTargetKind; currentName: string; context: Record<string, unknown> }[] = [];
  try { items = JSON.parse(raw).items ?? []; } catch { /* nothing to name */ }
  const reply = { names: items.map((i) => ({ id: i.id, name: nameFor(i.currentName) ?? heuristicName({ targetKind: i.kind, from: i.currentName }, i.context ?? {}) })) };
  return {
    id: "msg_assist_replay", type: "message", role: "assistant", model: body.model, container: null,
    content: [{ type: "text", text: JSON.stringify(reply), citations: null }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
  } as unknown as Anthropic.Message;
}

// ---------------------------------------------------------------- the service (inbox + watcher + resolve)

export interface AssistDeps {
  doc: () => CadDocument;
  /** Rename a sketch or feature through the command path (an edit of its creating op). */
  rename: (target: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  solids?: () => Record<string, SolidEval> | undefined;
  /** Whether organizational assist is on, and whether an embedded agent answers it. */
  status?: () => { enabled: boolean; agent: boolean };
}

export interface AssistInboxView {
  enabled: boolean;
  /** An embedded agent is naming items automatically (external agents may still answer). */
  agent: boolean;
  pending: number;
  items: (AssistItem & { currentName?: string; context?: Record<string, unknown> })[];
}

export type ResolveArgs = { id?: unknown; name?: unknown; dismiss?: unknown };
export type ResolveResult = { ok: boolean; id?: string; target?: string; name?: string; dismissed?: boolean; error?: string };

/** What the tools and transports talk to (the app's AssistService, or the headless server's). */
export interface AssistHost {
  view: (opts?: { all?: boolean }) => AssistInboxView;
  resolve: (args: ResolveArgs, by?: AssistBy) => Promise<ResolveResult>;
  subscribe: (fn: () => void) => () => void;
}

export class AssistService implements AssistHost {
  readonly inbox = new AssistInbox();
  private watcher = new AssistWatcher();
  constructor(private deps: AssistDeps) {}

  /** Feed the watcher a snapshot after a change: queues new targets, drops stale items. */
  observe(s: AssistSnapshot): AssistItem[] {
    const { reset, targets } = this.watcher.observe(s);
    if (reset) { this.inbox.clear(); return []; }
    const enabled = this.deps.status?.().enabled ?? true;
    const added = enabled ? targets.map((t) => this.inbox.enqueue(t.target, t.targetKind, t.from)).filter((i): i is AssistItem => !!i) : [];
    this.reconcile(s.doc);
    return added;
  }

  /** Pending items whose target is gone are dropped; ones renamed some other way are done. */
  reconcile(doc: CadDocument): void {
    const ops = doc.operations;
    this.inbox.drop((i) => i.status === "pending" && !creatingOp(ops, i.target));
    for (const i of this.inbox.pending()) {
      const now = currentName(doc, i.target);
      if (now !== undefined && !isDefaultName(doc, ops, i.target)) this.inbox.markDone(i.id, now, "user");
    }
  }

  view(opts: { all?: boolean } = {}): AssistInboxView {
    const doc = this.deps.doc();
    const st = this.deps.status?.() ?? { enabled: true, agent: false };
    const items = (opts.all ? this.inbox.all() : this.inbox.pending()).map((i) => ({
      ...i,
      currentName: currentName(doc, i.target),
      ...(i.status === "pending" ? { context: assistContext(doc, i, this.deps.solids?.()) } : {}),
    }));
    return { enabled: st.enabled, agent: st.agent, pending: this.inbox.pending().length, items };
  }

  /** Apply a name ({id, name}) or dismiss ({id, dismiss: true}). A done item can be renamed again. */
  async resolve(args: ResolveArgs, by: AssistBy = "external"): Promise<ResolveResult> {
    const id = typeof args.id === "string" ? args.id : "";
    const item = this.inbox.get(id);
    if (!item) return { ok: false, error: `No assist item "${id}" — call get_assist_inbox for the pending ids` };
    if (args.dismiss === true) {
      if (item.status === "pending") this.inbox.dismiss(id);
      return { ok: true, id, target: item.target, dismissed: true };
    }
    const name = cleanName(args.name);
    if (!name) return { ok: false, id, error: "`name` must be a non-empty string (or pass dismiss: true)" };
    if (item.status === "dismissed") return { ok: false, id, error: "That item was dismissed" };
    const r = await this.deps.rename(item.target, name);
    if (!r.ok) { this.inbox.patch(id, { error: r.error ?? "rename failed" }); return { ok: false, id, target: item.target, error: r.error ?? "rename failed" }; }
    this.inbox.markDone(id, name, by);
    return { ok: true, id, target: item.target, name };
  }

  subscribe(fn: () => void): () => void { return this.inbox.subscribe(fn); }
}

/** Rename through a session-like object: edit the creating op's `name`. Shared by the store and the stdio server. */
export async function renameViaEdit(
  doc: CadDocument,
  target: string,
  name: string,
  edit: (opId: string, params: Record<string, unknown>) => Promise<unknown>,
  after: () => CadDocument = () => doc,
): Promise<{ ok: boolean; error?: string }> {
  const op = creatingOp(doc.operations, target);
  if (!op) return { ok: false, error: `Nothing made "${target}" in the history` };
  await edit(op.opId, renameParams(op, name));
  const now = currentName(after(), target);
  return now === name ? { ok: true } : { ok: false, error: `could not rename ${target}` };
}

// ---------------------------------------------------------------- the hub (tools and transports find the host here)

let host: AssistHost | null = null;
let unhook: (() => void) | null = null;
const hubListeners = new Set<() => void>();

/** Install the live assist host (the app's controller, or a test's); null removes it. */
export function setAssistHost(h: AssistHost | null): void {
  unhook?.(); unhook = null;
  host = h;
  if (h) unhook = h.subscribe(emitHub);
  emitHub();
}
// Changes in one tick (an item queued, then marked attempted…) reach listeners as one notification.
let hubQueued = false;
function emitHub() {
  if (hubQueued) return;
  hubQueued = true;
  queueMicrotask(() => { hubQueued = false; for (const fn of [...hubListeners]) fn(); });
}
export function getAssistHost(): AssistHost | null { return host; }
/** Hear every inbox change, whichever host is installed (the MCP transports' notifications). */
export function onAssistChange(fn: () => void): () => void { hubListeners.add(fn); return () => { hubListeners.delete(fn); }; }

// ---------------------------------------------------------------- the tools, shared by every surface

export const ASSIST_INBOX_URI = "chisel://assist/inbox";

export const GET_ASSIST_INBOX_DESCRIPTION =
  "Organizational assist: the inbox of housekeeping an agent can do for the user — so far, naming sketches and features still called \"Sketch 12\" or \"Extrude\". Returns the pending items, each with an id, its target (sketch or feature id), its current name and a context object (a sketch's plane or face and the feature owning that face, its entities, size, dimensions and the features that use it; a feature's kind and parameters, the sketches it reads, the features before it, the names already in use). Answer each with resolve_assist. `all: true` also lists done/dismissed items. `enabled` is false when the user turned the assist off in Settings; `agent` is true when the embedded agent is already naming items automatically. The same inbox is the MCP resource " + ASSIST_INBOX_URI + " (subscribe to hear when it changes).";

export const RESOLVE_ASSIST_DESCRIPTION =
  "Answer an organizational-assist item from get_assist_inbox: {id, name} renames its sketch or feature (a short human name, 1–4 words: \"Back plate profile\", \"Lip\"; applied as an undoable edit of the operation that made it), or {id, dismiss: true} leaves the name as it is.";

export const GET_ASSIST_INBOX_SCHEMA = { type: "object", properties: { all: { type: "boolean" } } };
export const RESOLVE_ASSIST_SCHEMA = { type: "object", required: ["id"], properties: { id: { type: "string" }, name: { type: "string" }, dismiss: { type: "boolean" } } };

/** get_assist_inbox on whichever host is live. */
export function assistInboxTool(args: { all?: unknown }, h: AssistHost | null = host): AssistInboxView | { enabled: false; agent: false; pending: 0; items: []; note: string } {
  if (!h) return { enabled: false, agent: false, pending: 0, items: [], note: "Organizational assist is not running here." };
  return h.view({ all: args.all === true });
}

/** resolve_assist on whichever host is live. */
export async function resolveAssistTool(args: ResolveArgs, by: AssistBy, h: AssistHost | null = host): Promise<ResolveResult> {
  if (!h) return { ok: false, error: "Organizational assist is not running here." };
  return h.resolve(args, by);
}
