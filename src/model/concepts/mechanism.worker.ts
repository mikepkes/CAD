/// <reference lib="webworker" />
// Web Worker for the Mechanism tab's force–travel curve: a sweep of the
// drive's whole range (flexureEquilibria, with its beam solves) takes a second
// or two, so it runs here, off the main thread, on a copy of the document.

import { flexureEquilibria, isAngularDrive } from "../../sim/flexure";
import type { CadDocument } from "../../core/document";
import { buildCurve } from "./mechanism";

export interface CurveRequest { id: number; doc: CadDocument; param: string; min: number; max: number; samples: number }

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent) => {
  const { id, doc, param, min, max, samples } = e.data as CurveRequest;
  try {
    const study = flexureEquilibria(doc, param, min, max, samples);
    ctx.postMessage({ id, curve: buildCurve(study, param, isAngularDrive(doc, param), min, max) });
  } catch (err) {
    ctx.postMessage({ id, error: (err as Error).message ?? String(err) });
  }
};
