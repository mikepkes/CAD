// Cross-concept UI state: what is open, hovered or shown. Lives apart from the
// document store so concept panels share one source of "which feature is
// hot" without touching store.ts. Each concept keeps its own private state in
// its own module; only state another concept reads goes here.

import { create } from "zustand";

export type ConceptPanel = "workbench" | "ledger" | "space" | "lens" | "intent" | "mechanism" | "materials";
/** One name per panel, the same on its switch, its tab, its hotkey and in ⌘K. */
export const PANEL_NAMES: Record<ConceptPanel, string> = { workbench: "Pins", lens: "Lens", ledger: "Ledger", space: "Space", materials: "Materials", mechanism: "Mechanism", intent: "Intent line" };
/** Which tab the right side panel shows. Ledger, Space, Mechanism and Materials exist only while their panel is on. */
export type RightTab = "inspector" | "ledger" | "space" | "mechanism" | "materials";
const TABS: RightTab[] = ["ledger", "space", "mechanism", "materials"];

export interface UiState {
  /** Feature whose card is open on the part (the pin / chip / sentence in focus). */
  openFeature: string | null;
  /** Feature under the pointer anywhere (sentence, pin, chip, or its geometry): everything else lights it. */
  hotFeature: string | null;
  /** Parameter under the pointer, so its dimension can be drawn on the part. */
  hotParam: { featureId: string; key: string } | null;
  /** Which concept surfaces are shown. */
  panels: Record<ConceptPanel, boolean>;
  /** The right side panel's chosen tab. */
  rightTab: RightTab;
  /** Each side panel's width in px, dragged by its inner edge. */
  sideWidth: Record<Side, number>;
  /** Whether each side panel is open (both start collapsed on a narrow window). */
  sideOpen: Record<Side, boolean>;

  setOpenFeature: (id: string | null) => void;
  setHotFeature: (id: string | null) => void;
  setHotParam: (p: { featureId: string; key: string } | null) => void;
  /** Switch a panel. Without `on`, a lit panel whose tab is hidden (another tab in front, or the right side
   *  collapsed) comes forward instead of turning off; the next press turns it off. */
  togglePanel: (p: ConceptPanel, on?: boolean) => void;
  setRightTab: (t: RightTab) => void;
  /** Set a side panel's width (clamped); `persist` false while a drag is still moving. */
  setSideWidth: (side: Side, px: number, persist?: boolean) => void;
  setSideOpen: (side: Side, open: boolean) => void;
}

export type Side = "left" | "right";
export const SIDE_DEFAULT = 320, SIDE_MIN = 220, SIDE_MAX = 640;
export const clampSide = (px: number) => Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, px)));
/** Below this window width the side panels float over the view and start collapsed. */
export const NARROW_PX = 820;
/** The view keeps at least this much width however wide the side panels are dragged. */
export const MIN_VIEW = 480;

/** The widths the side panels are drawn at in a window `windowW` wide: the open ones shrink (the wider
 *  first, never under SIDE_MIN) so the view between them keeps MIN_VIEW. */
export function fitSides(width: Record<Side, number>, open: Record<Side, boolean>, windowW: number): Record<Side, number> {
  const out = { ...width };
  const sides = (["left", "right"] as Side[]).filter((s) => open[s]);
  let over = sides.reduce((a, s) => a + out[s], 0) + MIN_VIEW - windowW;
  // take from the wider side down to the other's width, then from both alike; never under SIDE_MIN
  for (let guard = 0; over > 0 && guard < 4; guard++) {
    const can = sides.filter((s) => out[s] > SIDE_MIN);
    if (!can.length) break;
    if (can.length === 2 && out.left !== out.right) {
      const wide: Side = out.left > out.right ? "left" : "right", narrow: Side = wide === "left" ? "right" : "left";
      const cut = Math.min(over, out[wide] - Math.max(out[narrow], SIDE_MIN));
      out[wide] -= cut; over -= cut;
    } else {
      const each = Math.min(over / can.length, ...can.map((s) => out[s] - SIDE_MIN));
      for (const s of can) out[s] -= each;
      over -= each * can.length;
    }
  }
  return { left: Math.round(out.left), right: Math.round(out.right) };
}

/** The widest a side may be dragged to: the window less the other open side and MIN_VIEW (within SIDE_MIN…SIDE_MAX). */
export function maxSide(side: Side, width: Record<Side, number>, open: Record<Side, boolean>, windowW: number): number {
  const other: Side = side === "left" ? "right" : "left";
  return clampSide(windowW - MIN_VIEW - (open[other] ? width[other] : 0));
}

const isNarrow = () => typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0 && window.innerWidth < NARROW_PX;

const KEY = "vibecad.ui.panels.v1";
const TAB_KEY = "vibecad.ui.rightTab.v1";
const WIDTH_KEY = "vibecad.ui.sideWidth.v1";
const DEFAULT_PANELS: Record<ConceptPanel, boolean> = { workbench: true, ledger: false, space: false, lens: false, intent: true, mechanism: false, materials: false };

function loadPanels(): Record<ConceptPanel, boolean> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return raw ? { ...DEFAULT_PANELS, ...JSON.parse(raw) } : DEFAULT_PANELS;
  } catch { return DEFAULT_PANELS; }
}

function loadTab(panels: Record<ConceptPanel, boolean>): RightTab {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(TAB_KEY) : null;
    return rightTabFor(TABS.includes(raw as RightTab) ? (raw as RightTab) : "inspector", panels);
  } catch { return "inspector"; }
}

function loadWidths(): Record<Side, number> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(WIDTH_KEY) : null;
    const w = raw ? JSON.parse(raw) : {};
    return { left: clampSide(Number(w.left) || SIDE_DEFAULT), right: clampSide(Number(w.right) || SIDE_DEFAULT) };
  } catch { return { left: SIDE_DEFAULT, right: SIDE_DEFAULT }; }
}

/** The tab that can actually be shown: a tab whose panel is off falls back to the inspector. */
export function rightTabFor(tab: RightTab, panels: Record<ConceptPanel, boolean>): RightTab {
  return tab === "inspector" || panels[tab] ? tab : "inspector";
}

/** What a press on a panel's switch does: turn it on, bring its hidden tab forward, or turn it off. */
export function switchPress(p: ConceptPanel, panels: Record<ConceptPanel, boolean>, rightTab: RightTab, rightOpen: boolean): "on" | "forward" | "off" {
  if (!panels[p]) return "on";
  if (TABS.includes(p as RightTab) && (rightTab !== p || !rightOpen)) return "forward";
  return "off";
}

/** The right tab after a panel toggle: turning Ledger/Space/Mechanism/Materials on shows it; turning the shown one
 *  off shows another tab that is still on (as closing a browser tab does), else the inspector. */
export function rightTabAfterToggle(tab: RightTab, p: ConceptPanel, on: boolean, panels: Record<ConceptPanel, boolean>): RightTab {
  if (TABS.includes(p as RightTab) && on) return p as RightTab;
  if (!on && tab === p) return TABS.find((t) => t !== p && panels[t as ConceptPanel]) ?? "inspector";
  return rightTabFor(tab, panels);
}

export const useUi = create<UiState>((set, get) => ({
  openFeature: null,
  hotFeature: null,
  hotParam: null,
  panels: loadPanels(),
  rightTab: loadTab(loadPanels()),
  sideWidth: loadWidths(),
  sideOpen: { left: !isNarrow(), right: !isNarrow() },
  setOpenFeature: (id) => set({ openFeature: id }),
  setHotFeature: (id) => { if (get().hotFeature !== id) set({ hotFeature: id }); },
  setHotParam: (p) => set({ hotParam: p }),
  togglePanel: (p, on) => {
    const { panels: was, rightTab: tab, sideOpen } = get();
    if (on === undefined && switchPress(p, was, tab, sideOpen.right) === "forward") {
      try { localStorage.setItem(TAB_KEY, p); } catch { /* ignore */ }
      set({ rightTab: p as RightTab, sideOpen: { ...sideOpen, right: true } });
      return;
    }
    const next = on ?? !was[p];
    const panels = { ...was, [p]: next };
    const rightTab = rightTabAfterToggle(tab, p, next, panels);
    try { localStorage.setItem(KEY, JSON.stringify(panels)); localStorage.setItem(TAB_KEY, rightTab); } catch { /* ignore */ }
    // a tab panel switched on opens the right side, so its tab is seen
    const open = next && TABS.includes(p as RightTab) && !sideOpen.right ? { ...sideOpen, right: true } : sideOpen;
    set({ panels, rightTab, sideOpen: open });
  },
  setRightTab: (t) => {
    const rightTab = rightTabFor(t, get().panels);
    try { localStorage.setItem(TAB_KEY, rightTab); } catch { /* ignore */ }
    set({ rightTab });
  },
  setSideWidth: (side, px, persist = true) => {
    const sideWidth = { ...get().sideWidth, [side]: clampSide(px) };
    if (persist) try { localStorage.setItem(WIDTH_KEY, JSON.stringify(sideWidth)); } catch { /* ignore */ }
    set({ sideWidth });
  },
  setSideOpen: (side, open) => { if (get().sideOpen[side] !== open) set({ sideOpen: { ...get().sideOpen, [side]: open } }); },
}));
