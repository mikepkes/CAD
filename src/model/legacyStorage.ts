// Settings saved before the rename to VibeCAD sit under `chisel.*` keys (the API
// key, hotkeys, ring, panels, autosave…). Copy each to its `vibecad.*` key, before
// any store reads them, so nothing is lost on upgrade. The old keys stay, so an
// older build still finds its settings; a key already set under the new name wins.

const OLD = "chisel.", NEW = "vibecad.";

export function migrateLegacyStorage(store: Storage): number {
  let moved = 0;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k?.startsWith(OLD)) keys.push(k); }
  for (const k of keys) {
    const to = NEW + k.slice(OLD.length);
    if (store.getItem(to) == null) { store.setItem(to, store.getItem(k)!); moved++; }
  }
  return moved;
}

try { migrateLegacyStorage(localStorage); } catch { /* storage unavailable: nothing to move */ }
