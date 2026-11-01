// Whether the person has asked their system for reduced motion
// (prefers-reduced-motion): camera moves then cut instead of gliding, and the
// orbit doesn't drift on after a drag. CSS animations follow the same setting
// in styles.css.

/** True when the system asks for reduced motion (false where it can't be asked). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
