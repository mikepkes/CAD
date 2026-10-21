import { create } from "zustand";
import { uid } from "../util/id";
import {
  Constraint,
  DimensionConstraint,
  DimensionType,
  GeometricConstraint,
  NewGeometricConstraint,
  Sketch,
  SketchArc,
  SketchCircle,
  SketchEntity,
  SketchLine,
  SketchPoint,
} from "../sketch/types";
import { solveSketch, SolveDrag } from "../sketch/engine";
import { Parameter, resolveParameters } from "./parameters";
import { planeById } from "../geometry/plane";

export type Tool =
  | "select"
  | "line"
  | "rectangle"
  | "circle"
  | "arc"
  | "point";

export type AppMode = "model" | "sketch";

export interface Component {
  id: string;
  name: string;
  parentId: string | null;
  children: string[];
  sketches: string[];
}

export interface AppState {
  // document
  components: Record<string, Component>;
  rootComponentId: string;
  activeComponentId: string;
  sketches: Record<string, Sketch>;
  parameters: Parameter[];
  paramScope: Record<string, number>;

  // ui
  mode: AppMode;
  activeSketchId: string | null;
  tool: Tool;
  selection: string[]; // entity ids
  hover: string | null;
  showPlanes: boolean;
  showGrid: boolean;

  // derived / status
  lastMessage: string;

  // ---- actions ----
  setTool: (t: Tool) => void;
  setHover: (id: string | null) => void;
  select: (ids: string[], additive?: boolean) => void;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;

  startSketch: (planeId: string) => void;
  finishSketch: () => void;
  editSketch: (id: string) => void;

  // entity creation (returns new ids)
  createPoint: (sketchId: string, u: number, v: number, opts?: Partial<SketchPoint>) => string;
  createLine: (sketchId: string, p1: string, p2: string, construction?: boolean) => string;
  createCircle: (sketchId: string, center: string, r: number) => string;
  createArc: (sketchId: string, center: string, p1: string, p2: string, ccw: boolean) => string;
  deleteEntities: (ids: string[]) => void;

  addGeometric: (c: NewGeometricConstraint) => void;
  addDimension: (d: Omit<DimensionConstraint, "id" | "value">, value: number) => void;
  updateDimension: (id: string, expr: string) => void;
  deleteConstraint: (id: string) => void;

  // parameters
  addParameter: (name?: string, expr?: string) => void;
  updateParameter: (id: string, patch: Partial<Parameter>) => void;
  deleteParameter: (id: string) => void;

  // components
  addComponent: (name?: string) => void;
  setActiveComponent: (id: string) => void;
  renameComponent: (id: string, name: string) => void;

  // solve
  recomputeParams: () => void;
  solveActive: (drag?: SolveDrag) => void;
  toggleShowPlanes: () => void;
  toggleShowGrid: () => void;
}

function newSketch(planeId: string, name: string): Sketch {
  const id = uid("sk");
  const originId = `${id}:origin`;
  const origin: SketchPoint = {
    id: originId,
    kind: "point",
    x: 0,
    y: 0,
    fixed: true,
  };
  return {
    id,
    name,
    planeId,
    originPointId: originId,
    entities: { [originId]: origin },
    constraints: {},
    status: { dof: 0, fullyConstrained: false, converged: true, conflicting: false },
  };
}

const rootId = uid("cmp");

export const useStore = create<AppState>((set, get) => ({
  components: {
    [rootId]: { id: rootId, name: "Root Component", parentId: null, children: [], sketches: [] },
  },
  rootComponentId: rootId,
  activeComponentId: rootId,
  sketches: {},
  parameters: [
    { id: uid("p"), name: "width", expr: "60", value: 60 },
    { id: uid("p"), name: "height", expr: "40", value: 40 },
  ],
  paramScope: { width: 60, height: 40 },

  mode: "model",
  activeSketchId: null,
  tool: "select",
  selection: [],
  hover: null,
  showPlanes: true,
  showGrid: true,
  lastMessage: "Ready. Pick an origin plane to start a sketch.",

  setTool: (t) => set({ tool: t }),
  setHover: (id) => set({ hover: id }),
  select: (ids, additive) =>
    set((s) => ({ selection: additive ? [...new Set([...s.selection, ...ids])] : ids })),
  toggleSelect: (id) =>
    set((s) => ({
      selection: s.selection.includes(id)
        ? s.selection.filter((x) => x !== id)
        : [...s.selection, id],
    })),
  clearSelection: () => set({ selection: [] }),

  startSketch: (planeId) => {
    const plane = planeById(planeId);
    const count = Object.keys(get().sketches).length + 1;
    const sketch = newSketch(planeId, `Sketch ${count}`);
    set((s) => {
      const comp = s.components[s.activeComponentId];
      return {
        sketches: { ...s.sketches, [sketch.id]: sketch },
        components: {
          ...s.components,
          [comp.id]: { ...comp, sketches: [...comp.sketches, sketch.id] },
        },
        activeSketchId: sketch.id,
        mode: "sketch",
        tool: "line",
        selection: [],
        lastMessage: `Sketching on ${plane.name}.`,
      };
    });
  },

  finishSketch: () =>
    set({ mode: "model", activeSketchId: null, tool: "select", selection: [], hover: null }),

  editSketch: (id) =>
    set({ mode: "sketch", activeSketchId: id, tool: "select", selection: [] }),

  createPoint: (sketchId, u, v, opts) => {
    const id = uid("pt");
    set((s) => {
      const sk = s.sketches[sketchId];
      if (!sk) return {};
      const point: SketchPoint = { id, kind: "point", x: u, y: v, ...opts };
      return {
        sketches: {
          ...s.sketches,
          [sketchId]: { ...sk, entities: { ...sk.entities, [id]: point } },
        },
      };
    });
    return id;
  },

  createLine: (sketchId, p1, p2, construction) => {
    const id = uid("ln");
    set((s) => {
      const sk = s.sketches[sketchId];
      if (!sk) return {};
      const line: SketchLine = { id, kind: "line", p1, p2, construction };
      return {
        sketches: {
          ...s.sketches,
          [sketchId]: { ...sk, entities: { ...sk.entities, [id]: line } },
        },
      };
    });
    return id;
  },

  createCircle: (sketchId, center, r) => {
    const id = uid("ci");
    set((s) => {
      const sk = s.sketches[sketchId];
      if (!sk) return {};
      const circle: SketchCircle = { id, kind: "circle", center, r };
      return {
        sketches: {
          ...s.sketches,
          [sketchId]: { ...sk, entities: { ...sk.entities, [id]: circle } },
        },
      };
    });
    return id;
  },

  createArc: (sketchId, center, p1, p2, ccw) => {
    const id = uid("ar");
    set((s) => {
      const sk = s.sketches[sketchId];
      if (!sk) return {};
      const c = sk.entities[center] as SketchPoint;
      const a = sk.entities[p1] as SketchPoint;
      const r = Math.hypot(a.x - c.x, a.y - c.y);
      const arc: SketchArc = { id, kind: "arc", center, p1, p2, r, ccw };
      return {
        sketches: {
          ...s.sketches,
          [sketchId]: { ...sk, entities: { ...sk.entities, [id]: arc } },
        },
      };
    });
    return id;
  },

  deleteEntities: (ids) => {
    const sketchId = get().activeSketchId;
    if (!sketchId) return;
    set((s) => {
      const sk = s.sketches[sketchId];
      if (!sk) return {};
      const remove = new Set(ids);
      // also remove points that are defining points of removed curves? keep simple:
      const entities: Record<string, SketchEntity> = {};
      for (const [eid, e] of Object.entries(sk.entities)) {
        if (remove.has(eid)) continue;
        if (eid === sk.originPointId) {
          entities[eid] = e;
          continue;
        }
        entities[eid] = e;
      }
      // drop constraints referencing removed entities
      const constraints: Record<string, Constraint> = {};
      for (const [cid, c] of Object.entries(sk.constraints)) {
        const refs = constraintRefs(c);
        if (refs.some((r) => remove.has(r))) continue;
        constraints[cid] = c;
      }
      return {
        sketches: { ...s.sketches, [sketchId]: { ...sk, entities, constraints } },
        selection: s.selection.filter((x) => !remove.has(x)),
      };
    });
    get().solveActive();
  },

  addGeometric: (c) => {
    const sketchId = get().activeSketchId;
    if (!sketchId) return;
    const id = uid("c");
    set((s) => {
      const sk = s.sketches[sketchId];
      if (!sk) return {};
      const constraint = { ...c, id } as GeometricConstraint;
      return {
        sketches: {
          ...s.sketches,
          [sketchId]: { ...sk, constraints: { ...sk.constraints, [id]: constraint } },
        },
      };
    });
    get().solveActive();
  },

  addDimension: (d, value) => {
    const sketchId = get().activeSketchId;
    if (!sketchId) return;
    const id = uid("d");
    set((s) => {
      const sk = s.sketches[sketchId];
      if (!sk) return {};
      const dim: DimensionConstraint = { ...d, id, value } as DimensionConstraint;
      return {
        sketches: {
          ...s.sketches,
          [sketchId]: { ...sk, constraints: { ...sk.constraints, [id]: dim } },
        },
      };
    });
    get().solveActive();
  },

  updateDimension: (id, expr) => {
    const sketchId = get().activeSketchId;
    if (!sketchId) return;
    set((s) => {
      const sk = s.sketches[sketchId];
      if (!sk) return {};
      const c = sk.constraints[id] as DimensionConstraint;
      if (!c) return {};
      return {
        sketches: {
          ...s.sketches,
          [sketchId]: { ...sk, constraints: { ...sk.constraints, [id]: { ...c, expr } } },
        },
      };
    });
    get().solveActive();
  },

  deleteConstraint: (id) => {
    const sketchId = get().activeSketchId;
    if (!sketchId) return;
    set((s) => {
      const sk = s.sketches[sketchId];
      if (!sk) return {};
      const { [id]: _, ...rest } = sk.constraints;
      void _;
      return {
        sketches: { ...s.sketches, [sketchId]: { ...sk, constraints: rest } },
        selection: s.selection.filter((x) => x !== id),
      };
    });
    get().solveActive();
  },

  addParameter: (name, expr) => {
    set((s) => {
      let base = name || "param";
      let n = base;
      let i = 1;
      const names = new Set(s.parameters.map((p) => p.name));
      while (names.has(n)) {
        n = `${base}${i++}`;
      }
      const p: Parameter = { id: uid("p"), name: n, expr: expr ?? "0", value: 0 };
      return { parameters: [...s.parameters, p] };
    });
    get().recomputeParams();
  },

  updateParameter: (id, patch) => {
    set((s) => ({
      parameters: s.parameters.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    get().recomputeParams();
  },

  deleteParameter: (id) => {
    set((s) => ({ parameters: s.parameters.filter((p) => p.id !== id) }));
    get().recomputeParams();
  },

  addComponent: (name) => {
    const id = uid("cmp");
    set((s) => {
      const root = s.components[s.rootComponentId];
      const comp: Component = {
        id,
        name: name || `Component ${Object.keys(s.components).length}`,
        parentId: s.rootComponentId,
        children: [],
        sketches: [],
      };
      return {
        components: {
          ...s.components,
          [id]: comp,
          [root.id]: { ...root, children: [...root.children, id] },
        },
        activeComponentId: id,
      };
    });
  },

  setActiveComponent: (id) => set({ activeComponentId: id }),
  renameComponent: (id, name) =>
    set((s) => ({ components: { ...s.components, [id]: { ...s.components[id], name } } })),

  recomputeParams: () => {
    const { scope, resolved } = resolveParameters(get().parameters);
    set({ parameters: resolved, paramScope: scope });
    get().solveActive();
  },

  solveActive: (drag) => {
    const { activeSketchId, sketches, paramScope } = get();
    if (!activeSketchId) return;
    const sk = sketches[activeSketchId];
    if (!sk) return;
    const result = solveSketch(sk, paramScope, drag);
    // update dimension stored values
    const constraints = { ...sk.constraints };
    for (const [cid, v] of Object.entries(result.dimensions)) {
      const c = constraints[cid] as DimensionConstraint;
      if (c) constraints[cid] = { ...c, value: v };
    }
    set((s) => ({
      sketches: {
        ...s.sketches,
        [activeSketchId]: { ...sk, entities: result.entities, constraints, status: result.status },
      },
      lastMessage: result.status.message ?? s.lastMessage,
    }));
  },

  toggleShowPlanes: () => set((s) => ({ showPlanes: !s.showPlanes })),
  toggleShowGrid: () => set((s) => ({ showGrid: !s.showGrid })),
}));

// Expose the store in dev for debugging / automated UI verification.
if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as any).__chisel = useStore;
}

export function constraintRefs(c: Constraint): string[] {
  const out: string[] = [];
  const add = (v?: string) => v && out.push(v);
  const any = c as any;
  ["a", "b", "l1", "l2", "e1", "e2", "c1", "c2", "point", "line", "circle"].forEach((k) =>
    add(any[k])
  );
  return out;
}

// Convenience selectors
export const activeSketch = (s: AppState): Sketch | null =>
  s.activeSketchId ? s.sketches[s.activeSketchId] ?? null : null;

export type { DimensionType };
