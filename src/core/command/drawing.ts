// The shop drawing's annotation commands: placed dimensions, section views and
// detail views (core/drawings.ts draws them). They change only what the drawing
// shows, never the model; a dimension names the geometry it measures by
// topological name, so it reads the current value after every rebuild and
// shows as broken, not as an error here, when that geometry is gone.

import type { CadDocument, DetailView, DimensionKind, Drafting, DrawingDimension, DrawingRef, SectionView, ViewPoint } from "../document";
import type { CommandDef, JSONSchema } from "./types";

const ORTHO = ["front", "top", "right"] as const;

const POINT: JSONSchema = { type: "object", required: ["u", "v"], additionalProperties: false, properties: { u: { type: "number" }, v: { type: "number" } } };
const REF: JSONSchema = {
  description: "Model geometry by topological name: {body, edge} (edge names as body_topology lists them, \"A|B\") or {body, vertex} (the faces meeting at the corner, sorted, \"A|B|C\"). shop_drawing lists a view's names with where they sit.",
  oneOf: [
    { type: "object", required: ["body", "edge"], additionalProperties: false, properties: { body: { type: "string" }, edge: { type: "string" } } },
    { type: "object", required: ["body", "vertex"], additionalProperties: false, properties: { body: { type: "string" }, vertex: { type: "string" } } },
  ],
};

/** The document's drafting, made on first use. */
function drafting(draft: CadDocument): Drafting {
  draft.drafting ??= { dimensions: [], sections: [], details: [] };
  return draft.drafting;
}

/** Whether `view` is one dimensions and details can be placed in. */
function hasView(draft: CadDocument, view: string): boolean {
  return (ORTHO as readonly string[]).includes(view) || !!draft.drafting?.sections.some((s) => s.id === view) || !!draft.drafting?.details.some((d) => d.id === view);
}

/** The next free view letter: A, B, C, … (I, O and Q are skipped, as drafting does: they read as 1, 0 and O). */
function nextLabel(draft: CadDocument): string {
  const used = new Set([...(draft.drafting?.sections ?? []), ...(draft.drafting?.details ?? [])].map((x) => x.label));
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ".split("");
  for (let round = 0; ; round++) for (const l of letters) { const s = round ? `${l}${round + 1}` : l; if (!used.has(s)) return s; }
}

const finite = (p: ViewPoint, what: string) => { if (!Number.isFinite(p.u) || !Number.isFinite(p.v)) throw new Error(`${what} must be finite`); };

function checkRefs(kind: DimensionKind, refs: DrawingRef[]) {
  const want = kind === "radius" || kind === "diameter" ? 1 : 2;
  if (refs.length !== want) throw new Error(`a ${kind} dimension measures ${want === 1 ? "one circle or arc" : "two things"}, got ${refs.length}`);
  if ((kind === "radius" || kind === "diameter" || kind === "angle") && refs.some((r) => !("edge" in r))) throw new Error(`a ${kind} dimension measures edges, not vertices`);
}

export const DRAWING_COMMANDS: CommandDef<any>[] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
  {
    type: "drawing.addDimension",
    title: "Add drawing dimension",
    summary: "Dimension the shop drawing: a distance, radius, diameter or angle placed on one of its views.",
    description:
      "Places a dimension on a view of the shop drawing (\"front\", \"top\", \"right\", or a section or detail view's id). It measures model geometry by topological name, so it follows the model: after a parameter change it shows the new value, and when its geometry no longer exists it is drawn as broken. " +
      "kind horizontal / vertical / aligned: the distance between two refs (vertices, straight edges, or circles — a circle counts as its centre); a straight edge must lie square to the measuring direction (aligned between two parallel edges measures the gap between them). radius / diameter: one circle or arc edge. angle: two straight edges, the angle on the side the offset points to. " +
      "`offset` places it relative to the middle of what it measures, in view mm (u right, v up): {u:0, v:40} puts a horizontal dimension 40 mm above, a radius's text up and to the right of the centre with {u:20, v:20}. Returns the dimension id.",
    paramsSchema: {
      type: "object",
      required: ["view", "kind", "refs"],
      additionalProperties: false,
      properties: {
        view: { type: "string", description: "front, top, right, or a section or detail view's id." },
        kind: { type: "string", enum: ["horizontal", "vertical", "aligned", "radius", "diameter", "angle"] },
        refs: { type: "array", items: REF, description: "Two refs (one for radius/diameter)." },
        offset: { ...POINT, description: "Where it goes, relative to the middle of what it measures (view mm)." },
        prefix: { type: "string", description: "Written before the value, e.g. \"4×\"." },
      },
    },
    examples: [
      { note: "A leg's width, 60 mm below it in the front view", params: { view: "front", kind: "horizontal", refs: [{ body: "ext135", edge: "ext135:side:ln127|ext135:side:ln133" }, { body: "ext135", edge: "ext135:side:ln127|ext135:side:ln129" }], offset: { u: 0, v: -460 } } },
      { note: "A hole's diameter", params: { view: "top", kind: "diameter", refs: [{ body: "ext12", edge: "ext12:end|hole9:bore" }], offset: { u: 25, v: 25 } } },
    ],
    apply(draft, p: { view: string; kind: DimensionKind; refs: DrawingRef[]; offset?: ViewPoint; prefix?: string }, ctx) {
      if (!hasView(draft, p.view)) throw new Error(`No drawing view "${p.view}" (front, top, right, or a section or detail id)`);
      checkRefs(p.kind, p.refs);
      if (p.offset) finite(p.offset, "offset");
      const id = ctx.alloc("dim");
      const d: DrawingDimension = { id, view: p.view, kind: p.kind, refs: p.refs.map((r) => ({ ...r })), ...(p.offset ? { offset: { ...p.offset } } : {}), ...(p.prefix ? { prefix: p.prefix } : {}) };
      drafting(draft).dimensions.push(d);
      return { createdIds: [id], message: `Dimension ${id} (${p.kind}) on the ${p.view} view` };
    },
  },
  {
    type: "drawing.addSection",
    title: "Add section view",
    summary: "Cut the model along a line drawn on a drawing view, and show the cut, cross-hatched, as a view of its own.",
    description:
      "Adds a section view to the shop drawing: the model cut by the plane through a line on a base view (front, top or right; `from` and `to` in its coordinates, model mm, u right / v up), looked at square to the cut. The cut faces are cross-hatched (each part at its own angle) and the section line with its letters (A–A) is drawn on the base view. " +
      "Unflipped it looks to the left of the line going from `from` to `to`; `flip` looks the other way. `label` names it (default the next free letter). It updates with the model. Returns the section view's id, which dimensions and details can be placed on.",
    paramsSchema: {
      type: "object",
      required: ["base", "from", "to"],
      additionalProperties: false,
      properties: {
        base: { type: "string", enum: [...ORTHO] },
        from: POINT,
        to: POINT,
        flip: { type: "boolean" },
        label: { type: "string", description: "Its letter (default the next free one)." },
      },
    },
    examples: [{ note: "Cut the bench across, through a leg, looking at its end", params: { base: "front", from: { u: -690, v: -500 }, to: { u: -690, v: 500 } } }],
    apply(draft, p: { base: SectionView["base"]; from: ViewPoint; to: ViewPoint; flip?: boolean; label?: string }, ctx) {
      finite(p.from, "from"); finite(p.to, "to");
      if (Math.hypot(p.to.u - p.from.u, p.to.v - p.from.v) < 1e-6) throw new Error("the section line needs two different points");
      const label = p.label?.trim() || nextLabel(draft);
      const id = ctx.alloc("sec");
      drafting(draft).sections.push({ id, label, base: p.base, from: { ...p.from }, to: { ...p.to }, ...(p.flip ? { flip: true } : {}) });
      return { createdIds: [id], message: `Section ${label}–${label} (${id}) cut on the ${p.base} view` };
    },
  },
  {
    type: "drawing.addDetail",
    title: "Add detail view",
    summary: "Draw a circled region of a drawing view again, larger.",
    description: "Adds a detail view to the shop drawing: everything inside a circle (`center`, `radius`, view mm) on a base view (front, top, right or a section's id), drawn `scale` times larger (default 2). The circle and its letter go on the base view. Returns the detail view's id, which dimensions can be placed on.",
    paramsSchema: {
      type: "object",
      required: ["base", "center", "radius"],
      additionalProperties: false,
      properties: {
        base: { type: "string" },
        center: POINT,
        radius: { type: "number", exclusiveMinimum: 0 },
        scale: { type: "number", exclusiveMinimum: 1, description: "How much larger (default 2)." },
        label: { type: "string" },
      },
    },
    examples: [{ note: "The vise screw and garter, three times larger", params: { base: "front", center: { u: -670, v: 275 }, radius: 70, scale: 3 } }],
    apply(draft, p: { base: string; center: ViewPoint; radius: number; scale?: number; label?: string }, ctx) {
      if (!(ORTHO as readonly string[]).includes(p.base) && !draft.drafting?.sections.some((s) => s.id === p.base)) throw new Error(`No view "${p.base}" to detail (front, top, right or a section id)`);
      finite(p.center, "center");
      const label = p.label?.trim() || nextLabel(draft);
      const id = ctx.alloc("det");
      const d: DetailView = { id, label, base: p.base, center: { ...p.center }, radius: p.radius, scale: p.scale ?? 2 };
      drafting(draft).details.push(d);
      return { createdIds: [id], message: `Detail ${label} (${id}) of the ${p.base} view` };
    },
  },
  {
    type: "drawing.edit",
    title: "Edit drawing annotation",
    summary: "Move a drawing dimension, or change a section or detail view.",
    description: "Changes the given fields of a dimension (offset, prefix), a section (from, to, flip, label) or a detail (center, radius, scale, label), by id; the others keep their values.",
    paramsSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        offset: POINT, prefix: { type: "string" },
        from: POINT, to: POINT, flip: { type: "boolean" },
        center: POINT, radius: { type: "number", exclusiveMinimum: 0 }, scale: { type: "number", exclusiveMinimum: 1 },
        label: { type: "string" },
      },
    },
    apply(draft, p: { id: string } & Partial<DrawingDimension & SectionView & DetailView>) {
      const d = draft.drafting;
      const dim = d?.dimensions.find((x) => x.id === p.id), sec = d?.sections.find((x) => x.id === p.id), det = d?.details.find((x) => x.id === p.id);
      const allowed = dim ? ["offset", "prefix"] : sec ? ["from", "to", "flip", "label"] : det ? ["center", "radius", "scale", "label"] : undefined;
      if (!allowed) throw new Error(`No drawing annotation "${p.id}"`);
      const wrong = Object.keys(p).filter((k) => k !== "id" && !allowed.includes(k));
      if (wrong.length) throw new Error(`${p.id} has no ${wrong.join(", ")} (it takes ${allowed.join(", ")})`);
      for (const k of ["offset", "from", "to", "center"] as const) if (p[k]) finite(p[k]!, k);
      const target = (dim ?? sec ?? det) as unknown as Record<string, unknown>;
      for (const k of allowed) if ((p as Record<string, unknown>)[k] !== undefined) target[k] = structuredClone((p as Record<string, unknown>)[k]);
      if (sec && Math.hypot(sec.to.u - sec.from.u, sec.to.v - sec.from.v) < 1e-6) throw new Error("the section line needs two different points");
      return { message: `Edited ${p.id}` };
    },
  },
  {
    type: "drawing.remove",
    title: "Remove drawing annotation",
    summary: "Remove a dimension, section view or detail view from the shop drawing.",
    description: "Removes a drawing annotation by id. Removing a section or detail view also removes the dimensions placed on it and the details drawn from it.",
    paramsSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
    destructive: true,
    apply(draft, p: { id: string }) {
      const d = draft.drafting;
      if (!d || ![...d.dimensions, ...d.sections, ...d.details].some((x) => x.id === p.id)) throw new Error(`No drawing annotation "${p.id}"`);
      // a view takes what is placed on it (and details of it) along
      const gone = new Set([p.id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const x of [...d.details]) if (gone.has(x.base) && !gone.has(x.id)) { gone.add(x.id); grew = true; }
      }
      const placed = d.dimensions.filter((x) => x.id !== p.id && gone.has(x.view)).length;
      d.dimensions = d.dimensions.filter((x) => !gone.has(x.id) && !gone.has(x.view));
      d.sections = d.sections.filter((x) => !gone.has(x.id));
      d.details = d.details.filter((x) => !gone.has(x.id));
      const also = [...gone].filter((g) => g !== p.id).concat(placed ? [`${placed} dimension${placed > 1 ? "s" : ""} on it`] : []);
      return { message: `Removed ${p.id}${also.length ? ` (and ${also.join(", ")})` : ""}` };
    },
  },
];
