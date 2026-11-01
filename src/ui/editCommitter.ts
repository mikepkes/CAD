// Commits control edits to the model after a pause: a continuous drag doesn't
// rebuild until you stop for `delayMs` (or release, `flush`), so a slow rebuild
// is never spent on a value you've already dragged past. One value waits at a
// time; an edit to a different control first commits the one that was waiting,
// so moving two sliders in quick succession keeps both.

export interface EditCommitter {
  edit(name: string, value: string, flush: boolean): void;
  cancel(): void;
}

export function editCommitter(apply: (name: string, value: string) => void, delayMs: number): EditCommitter {
  let pending: [string, string] | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => { if (!pending) return; const [n, v] = pending; pending = null; apply(n, v); };
  return {
    edit(name, value, flush) {
      clearTimeout(timer);
      if (pending && pending[0] !== name) fire();
      pending = [name, value];
      if (flush) fire();
      else timer = setTimeout(fire, delayMs);
    },
    cancel() { clearTimeout(timer); pending = null; },
  };
}
