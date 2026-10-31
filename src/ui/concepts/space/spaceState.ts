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
  metric: MetricKey;
  pins: Pin[];
  /** Pin letter whose deltas are compared against the current design, if any. */
  compare: PinLetter | null;
  setAxes: (x: string | null, y: string | null) => void;
  setN: (n: GridSize) => void;
  setMetric: (m: MetricKey) => void;
  pin: (p: Omit<Pin, "letter">) => void;
  unpin: (letter: PinLetter) => void;
  setCompare: (letter: PinLetter | null) => void;
}

export const useSpace = create<SpaceState>((set, get) => ({
  xName: null,
  yName: null,
  n: DEFAULT_N,
  metric: "mass",
  pins: [],
  compare: null,
  setAxes: (xName, yName) => set({ xName, yName }),
  setN: (n) => set({ n }),
  setMetric: (metric) => set({ metric }),
  pin: (p) => set({ pins: addPin(get().pins, p) }),
  unpin: (letter) => set({ pins: removePin(get().pins, letter), compare: get().compare === letter ? null : get().compare }),
  setCompare: (compare) => set({ compare }),
}));
