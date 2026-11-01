// Cross-concept UI state: what is open, hovered or shown. Lives apart from the
// document store so concept panels share one source of "which feature is
// hot" without touching store.ts. Each concept keeps its own private state in
// its own module; only state another concept reads goes here.

import { create } from "zustand";

export type ConceptPanel = "workbench" | "ledger" | "space" | "lens" | "intent" | "mechanism";
/** Which tab the right side panel shows. Ledger, Space and Mechanism exist only while their panel is on. */
export type RightTab = "inspector" | "ledger" | "space" | "mechanism";

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

  setOpenFeature: (id: string | null) => void;
  setHotFeature: (id: string | null) => void;
  setHotParam: (p: { featureId: string; key: string } | null) => void;
  togglePanel: (p: ConceptPanel, on?: boolean) => void;
  setRightTab: (t: RightTab) => void;
  /** Set a side panel's width (clamped); `persist` false while a drag is still moving. */
  setSideWidth: (side: Side, px: number, persist?: boolean) => void;
}

export type Side = "left" | "right";
export const SIDE_DEFAULT = 272, SIDE_MIN = 220, SIDE_MAX = 640;
export const clampSide = (px: number) => Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, px)));

const KEY = "vibecad.ui.panels.v1";
const TAB_KEY = "vibecad.ui.rightTab.v1";
const WIDTH_KEY = "vibecad.ui.sideWidth.v1";
const DEFAULT_PANELS: Record<ConceptPanel, boolean> = { workbench: true, ledger: false, space: false, lens: false, intent: true, mechanism: false };

function loadPanels(): Record<ConceptPanel, boolean> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return raw ? { ...DEFAULT_PANELS, ...JSON.parse(raw) } : DEFAULT_PANELS;
  } catch { return DEFAULT_PANELS; }
}

function loadTab(panels: Record<ConceptPanel, boolean>): RightTab {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(TAB_KEY) : null;
    return rightTabFor(raw === "ledger" || raw === "space" || raw === "mechanism" ? raw : "inspector", panels);
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

/** The right tab after a panel toggle: turning Ledger/Space/Mechanism on shows it; turning the shown one off returns to the inspector. */
export function rightTabAfterToggle(tab: RightTab, p: ConceptPanel, on: boolean, panels: Record<ConceptPanel, boolean>): RightTab {
  if ((p === "ledger" || p === "space" || p === "mechanism") && on) return p;
  return rightTabFor(tab, panels);
}

export const useUi = create<UiState>((set, get) => ({
  openFeature: null,
  hotFeature: null,
  hotParam: null,
  panels: loadPanels(),
  rightTab: loadTab(loadPanels()),
  sideWidth: loadWidths(),
  setOpenFeature: (id) => set({ openFeature: id }),
  setHotFeature: (id) => { if (get().hotFeature !== id) set({ hotFeature: id }); },
  setHotParam: (p) => set({ hotParam: p }),
  togglePanel: (p, on) => {
    const next = on ?? !get().panels[p];
    const panels = { ...get().panels, [p]: next };
    const rightTab = rightTabAfterToggle(get().rightTab, p, next, panels);
    try { localStorage.setItem(KEY, JSON.stringify(panels)); localStorage.setItem(TAB_KEY, rightTab); } catch { /* ignore */ }
    set({ panels, rightTab });
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
}));
