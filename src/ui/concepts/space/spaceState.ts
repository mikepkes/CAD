// The Design Space's private UI state: which parameters are on the axes, the
// grid size, the metric shown and the pinned designs. Nothing else reads it,
// so it lives here (tenet 5), not in uiState. A zustand store so the choices
// survive the panel being hidden and shown, and so tests set them directly.

import { create } from "zustand";
import { DEFAULT_N, addPin, removePin, type GridSize, type MetricKey, type Pin, type PinLetter } from "./space";

export interface SpaceState {
  xName: string | null;
  yName: string | null;
  n: GridSize;
  /** The grid size was picked by hand (a slow model then samples it anyway, rather than starting at 5×5). */
  nPicked: boolean;
  metric: MetricKey;
  pins: Pin[];
  /** Pin letter whose deltas are compared against the current design, if any. */
  compare: PinLetter | null;
  setAxes: (x: string | null, y: string | null) => void;
  /** Set the grid size; `picked` when the person chose it. */
  setN: (n: GridSize, picked?: boolean) => void;
  setMetric: (m: MetricKey) => void;
  pin: (p: Omit<Pin, "letter">) => void;
  unpin: (letter: PinLetter) => void;
  setCompare: (letter: PinLetter | null) => void;
}

export const useSpace = create<SpaceState>((set, get) => ({
  xName: null,
  yName: null,
  n: DEFAULT_N,
  nPicked: false,
  metric: "mass",
  pins: [],
  compare: null,
  setAxes: (xName, yName) => set({ xName, yName }),
  setN: (n, picked = false) => set({ n, ...(picked ? { nPicked: true } : {}) }),
  setMetric: (metric) => set({ metric }),
  pin: (p) => set({ pins: addPin(get().pins, p) }),
  unpin: (letter) => set({ pins: removePin(get().pins, letter), compare: get().compare === letter ? null : get().compare }),
  setCompare: (compare) => set({ compare }),
}));
