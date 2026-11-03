// Demo mode for the tutorial video (`?demo` in the URL): a presenter layer over
// the app and a small API on window.__vibecadDemo that the video director
// (video/director.mjs, through Playwright) drives. Nothing here changes how the
// app works: input arrives as real pointer and key events, and the layer only
// draws what happened (the cursor where the pointer is, a ripple on a press,
// keycaps for keys) plus the lower thirds and title cards the director asks for.

import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { useStore, whenRebuilt } from "../model/store";
import { useUi } from "../model/concepts/uiState";
import { hotkeys, eventToKey, prettyKey } from "../model/hotkeys";
import { useRing } from "../model/ring";
import { useDialog } from "../ui/kit/askDialog";
import { useLens } from "../ui/concepts/lens/lens";
import { getActiveScene } from "../viewport/sceneRef";
import { buildBodies } from "../viewport/turntableRecorder";
import { resolveComponentWorld } from "../core/recompute";
import { resolveParameters } from "../core/parameters";
import { resolveSketchPlane } from "../geometry/plane";
import { compileExpr } from "../math/expr";
import { sequenceAngles, sequenceMesh } from "../core/sheetSequence";
import type { SolidEval } from "../core/features";
import { setAgentClientFactory } from "../model/agent";
import { replayClient, recordingClient, type AgentCache } from "./agentReplay";
import * as stand from "./stand";
import "./demo.css";

interface TitleCard { title: string; subtitle?: string; chips?: string[]; /** The opening title: bigger, on an opaque ground. */ hero?: boolean }
interface LowerThird { title: string; sub?: string }

const useDemo = create<{
  cursor: boolean; pointer: { x: number; y: number }; ripples: { id: number; x: number; y: number }[];
  keys: { id: number; label: string }[]; lower: LowerThird | null; title: TitleCard | null;
}>(() => ({ cursor: true, pointer: { x: -100, y: -100 }, ripples: [], keys: [], lower: null, title: null }));

let seq = 0;

function Cursor() {
  const { cursor, pointer } = useDemo();
  return (
    <svg className="demo-cursor" viewBox="0 0 26 26" style={{ left: pointer.x, top: pointer.y, opacity: cursor ? 1 : 0 }} aria-hidden="true">
      <path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L18.5 15 Z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function Layer() {
  const { ripples, keys, lower, title, cursor } = useDemo();
  return (
    <div className="demo-layer">
      {title && (
        <div className={`demo-title${title.hero ? " hero" : ""}`}>
          <h1>{title.title}</h1>
          {title.subtitle && <p>{title.subtitle}</p>}
          {title.chips && <div className="demo-chips">{title.chips.map((c) => <span key={c}>{c}</span>)}</div>}
        </div>
      )}
      {lower && <div className="demo-lower"><b>{lower.title}</b>{lower.sub && <span>{lower.sub}</span>}</div>}
      {cursor && ripples.map((r) => <div key={r.id} className="demo-ripple" style={{ left: r.x, top: r.y }} />)}
      <div className="demo-keys">{keys.map((k) => <div key={k.id} className="demo-key">{k.label}</div>)}</div>
      <Cursor />
    </div>
  );
}

function Listeners() {
  useEffect(() => {
    const move = (e: PointerEvent) => useDemo.setState({ pointer: { x: e.clientX, y: e.clientY } });
    const down = (e: PointerEvent) => {
      const id = ++seq;
      useDemo.setState((s) => ({ pointer: { x: e.clientX, y: e.clientY }, ripples: [...s.ripples, { id, x: e.clientX, y: e.clientY }] }));
      setTimeout(() => useDemo.setState((s) => ({ ripples: s.ripples.filter((r) => r.id !== id) })), 450);
    };
    const key = (e: KeyboardEvent) => {
      if (e.repeat || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if ((tag === "INPUT" || tag === "TEXTAREA") && e.key.length === 1 && !e.metaKey && !e.ctrlKey) return; // typing shows as text, not keycaps
      const id = ++seq;
      const label = prettyKey(eventToKey(e));
      useDemo.setState((s) => ({ keys: [...s.keys.slice(-2), { id, label }] }));
      setTimeout(() => useDemo.setState((s) => ({ keys: s.keys.filter((k) => k.id !== id) })), 1300);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key, true); };
  }, []);
  return <Layer />;
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const turn = { rate: 0, target: 0, raf: 0 };

/** The director's handle on the app. Every method is plain data in, plain data out (it crosses Playwright). */
/** The pose sweeps' running state: which document's parts are posed, and the parameter values they're posed at. */
let pose: { doc: unknown; scope: Record<string, number>; overrides: Record<string, string>; sheets: { id: string; seq: NonNullable<NonNullable<SolidEval["sheet"]>["sequence"]>; progress: string; last?: number }[] } | null = null;

const api = {
  // ---- waiting ----
  /** Resolves when the model has finished rebuilding, the camera has stopped, and nothing has changed for `quietMs`, plus two painted frames. */
  async settle(quietMs = 250, timeoutMs = 20000, camera = true): Promise<boolean> {
    const t0 = performance.now();
    // rounded: orbit damping leaves sub-pixel drift that would never read as still; `camera` false ignores it (a turntable runs)
    const pose = () => (camera ? JSON.stringify(getActiveScene()?.cameraPose() ?? null, (_k, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v)) : "");
    let last = useStore.getState().rev, lastPose = pose(), since = performance.now();
    for (;;) {
      await whenRebuilt();
      const s = useStore.getState(), p = pose();
      if (s.rev !== last || p !== lastPose || s.kernelLoading || s.agentRunning) { last = s.rev; lastPose = p; since = performance.now(); }
      if (performance.now() - since >= quietMs) break;
      if (performance.now() - t0 > timeoutMs) { console.warn("demo: settle timed out"); return false; }
      await new Promise((r) => setTimeout(r, 30));
    }
    await frame(); await frame();
    return true;
  },
  // ---- where things are on screen (client px) ----
  worldToScreen(p: { x: number; y: number; z: number }) { return getActiveScene()?.worldToScreen(p) ?? null; },
  /** A point (u, v) on the active sketch's plane, on screen. */
  sketchToScreen(u: number, v: number) {
    const s = useStore.getState();
    const sk = s.activeSketchId ? s.session.doc.sketches[s.activeSketchId] : null;
    const scene = getActiveScene();
    return sk && scene ? scene.uvToScreen(resolveSketchPlane(sk), u, v) : null;
  },
  /** A world point on the active sketch's plane, on screen (the point projected into the plane). */
  sketchWorldToScreen(p: { x: number; y: number; z: number }) {
    const s = useStore.getState();
    const sk = s.activeSketchId ? s.session.doc.sketches[s.activeSketchId] : null;
    const scene = getActiveScene();
    if (!sk || !scene) return null;
    const pl = resolveSketchPlane(sk);
    const d = { x: p.x - pl.origin.x, y: p.y - pl.origin.y, z: p.z - pl.origin.z };
    return scene.uvToScreen(pl, d.x * pl.u.x + d.y * pl.u.y + d.z * pl.u.z, d.x * pl.v.x + d.y * pl.v.y + d.z * pl.v.z);
  },
  /** A built body's bounds (by its creating feature id), or every body's when omitted. */
  bounds(featureId?: string) {
    const solids = useStore.getState().solids;
    if (featureId) return solids[featureId]?.bounds ?? null;
    return Object.values(solids).flatMap((b) => (b.mesh && b.bounds ? [b.bounds] : []));
  },
  /** The rect of the first visible element matching `selector` (optionally whose text or label includes `text`; "=text" matches exactly). */
  rect(selector: string, text?: string) {
    const exact = text?.startsWith("=") ? text.slice(1) : null;
    const matches = (e: HTMLElement) => {
      if (!text) return true;
      const t = (e.textContent ?? "").trim(), l = e.getAttribute("aria-label") ?? "";
      return exact != null ? t === exact || l === exact : t.includes(text) || l.includes(text);
    };
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.getClientRects().length > 0 && matches(e));
    if (!el) return null;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  },
  // ---- the presenter layer ----
  cursor(on: boolean) { useDemo.setState({ cursor: on }); },
  lowerThird(l: LowerThird | null) { useDemo.setState({ lower: l }); },
  titleCard(t: TitleCard | null) { useDemo.setState({ title: t }); },
  // ---- the camera: a smooth 3D-mouse-style drift (axes as the device reports them, about ±350) ----
  drift(axes: Partial<Record<"tx" | "ty" | "tz" | "rx" | "ry" | "rz", number>> | null) {
    getActiveScene()?.setNavigationInput({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, buttons: 0, ...(axes ?? {}) });
  },
  /** A turntable: orbit the camera about the view's target and world Z at `degPerSec`, easing in and out
   *  (null eases to a stop). Measured in degrees per second, unlike `drift`, whose rate depends on 3D-mouse tuning. */
  turntable(degPerSec: number | null) {
    turn.target = degPerSec ?? 0;
    if (turn.raf) return;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      turn.rate += (turn.target - turn.rate) * Math.min(1, dt * 3); // about a second to reach speed or stop
      const sc = getActiveScene();
      if (sc && Math.abs(turn.rate) > 0.01) {
        const cam = sc.camera, c = sc.controls.target, a = (turn.rate * dt * Math.PI) / 180;
        const x = cam.position.x - c.x, y = cam.position.y - c.y;
        cam.position.x = c.x + x * Math.cos(a) - y * Math.sin(a);
        cam.position.y = c.y + x * Math.sin(a) + y * Math.cos(a);
        cam.lookAt(c); sc.controls.update();
      }
      if (turn.target === 0 && Math.abs(turn.rate) < 0.05) { turn.rate = 0; turn.raf = 0; return; }
      turn.raf = requestAnimationFrame(tick);
    };
    turn.raf = requestAnimationFrame(tick);
  },
  view(name: string) { window.dispatchEvent(new CustomEvent("vibecad:view", { detail: name })); },
  frameAll() { window.dispatchEvent(new CustomEvent("vibecad:frame")); },
  /** The world box of the bodies in the named components (and their sub-components), at the built pose. */
  componentBox(names: string[]) {
    const solids = useStore.getState().solids;
    const lo = { x: Infinity, y: Infinity, z: Infinity }, hi = { x: -Infinity, y: -Infinity, z: -Infinity };
    const ids = new Set(api.componentBodies(names));
    for (const b of Object.values(solids)) {
      if (!b.bounds || !ids.has(b.featureId)) continue;
      for (const k of ["x", "y", "z"] as const) { lo[k] = Math.min(lo[k], b.bounds.min[k]); hi[k] = Math.max(hi[k], b.bounds.max[k]); }
    }
    return lo.x <= hi.x ? { min: lo, max: hi } : null;
  },
  /** The ids of the bodies in the named components (and their sub-components). */
  componentBodies(names: string[]) {
    const { session, solids } = useStore.getState(), doc = session.doc;
    const ids = new Set<string>();
    const add = (id: string) => { if (ids.has(id)) return; ids.add(id); for (const c of doc.components[id]?.children ?? []) add(c); };
    for (const c of Object.values(doc.components)) if (names.includes(c.name)) add(c.id);
    return Object.values(solids).flatMap((b) => {
      const cid = (b.sketchId ? doc.sketches[b.sketchId]?.componentId : undefined) ?? doc.rootComponentId;
      return b.mesh && b.bounds && ids.has(cid) ? [b.featureId] : [];
    });
  },
  /** Fly the camera (over `ms`) to look along -`dir` at a box (or every body), filling the view with `margin` to spare.
   *  With `frame` ([left, top, right, bottom], fractions of the window), the drawn parts (or just the `parts`
   *  components, or all but the `except` ones) are fitted into that rect by their silhouette instead, their tighter
   *  side filling it. */
  aim(opts: { dir: [number, number, number]; box?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null; ms?: number; margin?: number; frame?: [number, number, number, number]; parts?: string[]; except?: string[] }) {
    if (opts.frame) {
      const [x, y, z] = opts.dir;
      const out = new Set(opts.except ? api.componentBodies(opts.except) : []);
      const ids = opts.parts ? new Set(api.componentBodies(opts.parts))
        : opts.except ? new Set(Object.values(useStore.getState().solids).map((b) => b.featureId).filter((id) => !out.has(id))) : null;
      getActiveScene()?.aimFit({ x, y, z }, opts.frame, (opts.ms ?? 1500) / 1000, ids);
      return new Promise<void>((done) => setTimeout(done, (opts.ms ?? 1500) + 50));
    }
    const all = api.bounds() as { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }[];
    const box = opts.box ?? all.reduce((a, b) => ({
      min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
      max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
    }));
    const c = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
    const r = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 2;
    const [x, y, z] = opts.dir;
    getActiveScene()?.aim({ x, y, z }, c, r, (opts.ms ?? 1500) / 1000, opts.margin ?? 1.15);
    return new Promise<void>((done) => setTimeout(done, (opts.ms ?? 1500) + 50));
  },
  /** Drive a parameter from `from` to `to` over `ms` by moving the built parts (as the motion study and the
   *  turntable recorder do), not by rebuilding each step, so a mechanism moves smoothly at real speed. Joints,
   *  and paper folded in steps (its `progress`: the sheet is re-posed from its fold plan, no kernel); other
   *  geometry that depends on the parameter doesn't change. The parts stay posed (sweeps chain) until `poseEnd`. */
  poseSweep(name: string, from: number, to: number, ms: number, opts: { ease?: boolean } = {}): Promise<void> {
    const scene = getActiveScene(), st = useStore.getState(), doc = st.session.doc;
    if (!scene) return Promise.resolve();
    if (!pose || pose.doc !== doc) {
      // sheets folded in steps, and the expression that runs their steps
      const sheets = Object.values(st.solids as Record<string, SolidEval>).flatMap((sol) => {
        const f = doc.features[sol.featureId], seq = sol.sheet?.sequence;
        return f?.kind === "sheet" && f.progressExpr && seq && sol.mesh ? [{ id: sol.featureId, seq, progress: f.progressExpr }] : [];
      });
      pose = { doc, scope: { ...resolveParameters(doc.parameters).scope }, overrides: {}, sheets };
      scene.beginAnimation(buildBodies(doc, st.solids as never), resolveComponentWorld(doc, pose.scope), true);
    }
    const p = pose;
    // re-solved each step, so parameters that follow this one (a linkage's joint positions) follow it too
    const at = (v: number) => {
      p.overrides[name] = String(v);
      p.scope = resolveParameters(doc.parameters.map((q) => (p.overrides[q.name] != null ? { ...q, expr: p.overrides[q.name] } : q))).scope;
      scene.setAnimationPose(resolveComponentWorld(doc, p.scope));
      for (const sh of p.sheets) {
        let k: number;
        try { k = compileExpr(sh.progress).eval(p.scope); } catch { continue; }
        if (!Number.isFinite(k) || k === sh.last) continue;
        sh.last = k;
        scene.setAnimationMesh(sh.id, sequenceMesh(sh.seq.plan, sequenceAngles(sh.seq.plan, k), sh.seq.frame, sh.seq.bend));
      }
    };
    at(from); // before the next frame draws, so a chained sweep never shows the built pose
    const t0 = performance.now();
    return new Promise((done) => {
      const tick = () => {
        const k = Math.min(1, (performance.now() - t0) / ms), e = opts.ease === false ? k : k * k * (3 - 2 * k);
        at(from + (to - from) * e);
        if (k < 1) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
  },
  /** Put the parts back to the built model after `poseSweep`s. */
  poseEnd() { pose = null; getActiveScene()?.endAnimation(); },
  /** Ease a side panel to `px` wide over `ms` (as dragging its edge would), e.g. to widen Parameters while values are edited. */
  sideWidth(side: "left" | "right", px: number, ms = 600): Promise<void> {
    const from = useUi.getState().sideWidth[side], t0 = performance.now();
    return new Promise((done) => {
      const tick = () => {
        const k = Math.min(1, (performance.now() - t0) / ms), e = k * k * (3 - 2 * k);
        useUi.getState().setSideWidth(side, from + (px - from) * e, k === 1);
        if (k < 1) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
  },
  // ---- documents ----
  async openText(text: string, name = "model.vibecad.json") { api.poseEnd(); await useStore.getState().openFile(new File([text], name)); await api.settle(); },
  async newDocument() { api.poseEnd(); await useStore.getState().newDocument(); await api.settle(); },
  documentText() { return JSON.stringify(useStore.getState().session.doc); },
  // ---- the agent ----
  mockAgent(cache: AgentCache | null) {
    const client = cache ? replayClient(cache) : null; // one client, so turns and repeated names advance across requests
    setAgentClientFactory(client ? () => client : null);
    if (cache && !useStore.getState().apiKey) useStore.setState({ apiKey: "demo-replay" }); // the panel wants a key; the replay never sends it
  },
  recordAgent(prompt: string) { setAgentClientFactory((key) => recordingClient(key, prompt)); },
  // ---- the running project (src/demo/stand.ts), for steps the video puppets ----
  STAND: stand.STAND,
  backOutline: () => stand.backOutline(),
  lipOutline: () => stand.lipOutline(),
  async standStep(step: "box" | "sideSketch" | "backProfile" | "lipProfile" | "across", ...args: unknown[]) {
    const host: stand.StandHost = { dispatch: (t, p) => useStore.getState().dispatch(t, p), doc: () => useStore.getState().session.doc };
    const fn = stand[step] as (h: stand.StandHost, ...a: unknown[]) => Promise<unknown>;
    const r = await fn(host, ...args);
    await api.settle();
    return r;
  },
  async lipDims(sketchId: string, phoneExpr: string) {
    const host: stand.StandHost = { dispatch: (t, p) => useStore.getState().dispatch(t, p), doc: () => useStore.getState().session.doc };
    await stand.dimensionLip(host, sketchId, phoneExpr);
    await api.settle();
  },
  async backDims(sketchId: string, phoneExpr: string) {
    const host: stand.StandHost = { dispatch: (t, p) => useStore.getState().dispatch(t, p), doc: () => useStore.getState().session.doc };
    await stand.dimensionBack(host, sketchId, phoneExpr);
    await api.settle();
  },
  cameraPose: () => getActiveScene()?.cameraPose() ?? null,
  /** Close the feature card and the face card, as clicking away would (keeps the next face click clear of them). */
  closeCards() { useUi.getState().setOpenFeature(null); useStore.getState().selectFace(null); },
  // ---- the app's own state, for steps the UI can't reach ----
  store: useStore, ui: useUi, hotkeys, ring: useRing, dialog: useDialog, lens: useLens,
};

export type DemoApi = typeof api;

export function installDemo() {
  (window as unknown as { __vibecadDemo: DemoApi }).__vibecadDemo = api;
  document.documentElement.classList.add("demo");
  const host = document.createElement("div");
  document.body.appendChild(host);
  createRoot(host).render(<Listeners />);
}
