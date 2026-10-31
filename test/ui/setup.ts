// Shared setup for UI tests (jsdom). Node tests load this too; everything in
// it is guarded so it costs them nothing.
import { afterEach } from "vitest";

if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
  // jsdom has no pointer capture or layout; components call these defensively
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
  }
}
