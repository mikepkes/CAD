// Commits control edits to the model after a pause: a continuous drag doesn't
// rebuild until you stop for `delayMs` (or release, `flush`), so a slow rebuild
// is never spent on a value you've already dragged past. One value waits at a
// time; an edit to a different control first commits the one that was waiting,
// so moving two sliders in quick succession keeps both.

export interface EditCommitter {
  edit(name: string, value: string, flush: boolean): void;
  /** Commit the waiting value now (if any); resolves once every commit made so far has been applied. */
  flush(): Promise<void>;
  cancel(): void;
}

export function editCommitter(apply: (name: string, value: string) => void | Promise<void>, delayMs: number): EditCommitter {
  let pending: [string, string] | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let applied: Promise<void> = Promise.resolve(); // every commit so far, settled
  const fire = () => {
    if (!pending) return;
    const [n, v] = pending; pending = null;
    let r: void | Promise<void>;
    try { r = apply(n, v); } catch { r = undefined; }
    const done = Promise.resolve(r).then(() => {}, () => {});
    applied = Promise.all([applied, done]).then(() => {});
  };
  return {
    edit(name, value, flush) {
      clearTimeout(timer);
      if (pending && pending[0] !== name) fire();
      pending = [name, value];
      if (flush) fire();
      else timer = setTimeout(fire, delayMs);
    },
    flush() { clearTimeout(timer); fire(); return applied; },
    cancel() { clearTimeout(timer); pending = null; },
  };
}
