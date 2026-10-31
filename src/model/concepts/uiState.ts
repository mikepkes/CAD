// Cross-concept UI state: what is open, hovered or shown. Lives apart from the
// document store so concept panels share one source of "which feature is
// hot" without touching store.ts. Each concept keeps its own private state in
// its own module; only state another concept reads goes here.

import { create } from "zustand";

export type ConceptPanel = "workbench" | "ledger" | "space" | "lens" | "intent";

export interface UiState {
  /** Feature whose card is open on the part (the pin / chip / sentence in focus). */
  openFeature: string | null;
  /** Feature under the pointer anywhere (sentence, pin, chip, or its geometry): everything else lights it. */
  hotFeature: string | null;
  /** Parameter under the pointer, so its dimension can be drawn on the part. */
  hotParam: { featureId: string; key: string } | null;
  /** Which concept surfaces are shown. */
  panels: Record<ConceptPanel, boolean>;

  setOpenFeature: (id: string | null) => void;
  setHotFeature: (id: string | null) => void;
  setHotParam: (p: { featureId: string; key: string } | null) => void;
  togglePanel: (p: ConceptPanel, on?: boolean) => void;
}

const KEY = "chisel.ui.panels.v1";
const DEFAULT_PANELS: Record<ConceptPanel, boolean> = { workbench: true, ledger: false, space: false, lens: false, intent: true };

function loadPanels(): Record<ConceptPanel, boolean> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return raw ? { ...DEFAULT_PANELS, ...JSON.parse(raw) } : DEFAULT_PANELS;
  } catch { return DEFAULT_PANELS; }
}

export const useUi = create<UiState>((set, get) => ({
  openFeature: null,
  hotFeature: null,
  hotParam: null,
  panels: loadPanels(),
  setOpenFeature: (id) => set({ openFeature: id }),
  setHotFeature: (id) => { if (get().hotFeature !== id) set({ hotFeature: id }); },
  setHotParam: (p) => set({ hotParam: p }),
  togglePanel: (p, on) => {
    const panels = { ...get().panels, [p]: on ?? !get().panels[p] };
    try { localStorage.setItem(KEY, JSON.stringify(panels)); } catch { /* ignore */ }
    set({ panels });
  },
}));
