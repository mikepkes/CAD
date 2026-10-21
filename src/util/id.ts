let counter = 0;
/** Monotonic, session-unique id with a readable prefix. */
export function uid(prefix = "e"): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}`;
}
