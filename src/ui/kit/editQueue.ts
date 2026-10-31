// The one edit throttle every scrubbed number feeds: at most one `send` in
// flight, intermediate values dropped, the newest sent when the current one
// settles. Pure (no React, no store), tested in Node (test/kit.test.ts) and
// shared by the feature card, the face verbs, the Ledger and the Design Space.

export interface EditQueue<T> {
  /** A live value while scrubbing: sent now if nothing is in flight, else kept as the one pending value. */
  live: (v: T) => void;
  /** The final value: sent (or left pending) unless it is the last value already sent. */
  commit: (v: T) => void;
  /** Resolves when nothing is in flight or pending (what "commit on release" awaits). */
  flush: () => Promise<void>;
  readonly inFlight: boolean;
  readonly pending: T | null;
}

/**
 * `key` tells two values apart for `commit`'s "already sent" check (default:
 * JSON). A `send` that throws or rejects is swallowed; the store reports its own
 * errors and the queue goes on with the next value.
 */
export function createEditQueue<T>(send: (v: T) => Promise<unknown> | unknown, key: (v: T) => string = (v) => JSON.stringify(v)): EditQueue<T> {
  let inFlight = false;
  let pending: T | null = null;
  let lastSent: string | null = null;
  let running: Promise<void> | null = null;
  const pump = async () => {
    while (pending != null) {
      const v = pending;
      pending = null;
      inFlight = true;
      lastSent = key(v);
      try { await send(v); } catch { /* the store reports its own errors */ } finally { inFlight = false; }
    }
    running = null;
  };
  const live = (v: T) => { pending = v; if (!inFlight) running = pump(); };
  return {
    live,
    commit: (v) => { if (pending != null || lastSent !== key(v)) live(v); },
    flush: async () => { while (running) await running; },
    get inFlight() { return inFlight; },
    get pending() { return pending; },
  };
}
