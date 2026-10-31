// The size a placed card really has, measured from the DOM after each render,
// so placeCard keeps it inside the viewport without a per-card estimate. Until
// the first measurement (and in jsdom, which has no layout) `fallback` is used.

import { useLayoutEffect, useState, type RefObject } from "react";
import type { Box } from "./anchor";

export function useCardSize(ref: RefObject<HTMLElement | null>, fallback: Box): Box {
  const [size, setSize] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !el.offsetWidth) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
  });
  return size ?? fallback;
}
