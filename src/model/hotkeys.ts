// Hotkey manager.
//
// Commands register themselves as actions, each tagged with a *context*.
// Contexts stack: a specialized context (e.g. "sketch") lays on top of the
// base ("global") one. A pressed key is resolved top-down through the active
// stack, so an action in a higher context overrides the same key in a lower
// one — that's how "f" can be Frame in global but Look At while sketching.
//
// Conflicts only matter *within* a single context: the same key may be bound
// in two different contexts without clashing. Bindings have a primary and an
// optional secondary; a command need not bind any key at all. Custom bindings
// are persisted to localStorage and layered over the registered defaults.

export interface HotkeyAction {
  /** Stable unique id, e.g. "tool.line", "view.frame". */
  id: string;
  /** Human label shown in the manager. */
  label: string;
  /** Context this action belongs to (e.g. "global", "sketch"). */
  context: string;
  /** Default primary binding (canonical key string) or undefined for none. */
  defaultPrimary?: string;
  /** Default secondary binding or undefined. */
  defaultSecondary?: string;
  /** What the action does when its key fires. */
  run: () => void;
  /** Optional guard; when it returns false the key falls through to lower contexts. */
  when?: () => boolean;
}

export interface BindingOverride {
  primary?: string | null; // null = explicitly unbound
  secondary?: string | null;
}

const STORAGE_KEY = "chisel.hotkeys";

/** Canonicalize a KeyboardEvent to a binding string like "mod+shift+z", "f", "delete". */
export function eventToKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(normalizeKeyName(e.key));
  return parts.join("+");
}

function normalizeKeyName(k: string): string {
  if (k === " ") return "space";
  if (k.length === 1) return k.toLowerCase();
  const map: Record<string, string> = {
    Escape: "escape", Enter: "enter", Tab: "tab", Delete: "delete", Backspace: "backspace",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  };
  return map[k] ?? k.toLowerCase();
}

/** True if the key string is only modifiers / a lone modifier press (never a real binding). */
function isModifierOnly(key: string): boolean {
  const last = key.split("+").pop() ?? "";
  return last === "" || last === "control" || last === "meta" || last === "shift" || last === "alt";
}

/** Pretty-print a binding for the UI (platform-aware modifier). */
export function prettyKey(key: string | null | undefined): string {
  if (!key) return "—";
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
  return key
    .split("+")
    .map((p) => {
      if (p === "mod") return mac ? "⌘" : "Ctrl";
      if (p === "shift") return mac ? "⇧" : "Shift";
      if (p === "alt") return mac ? "⌥" : "Alt";
      if (p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(mac ? "" : "+");
}

export interface ConflictInfo {
  context: string;
  key: string;
  actionIds: string[];
}

export class HotkeyManager {
  private actions = new Map<string, HotkeyAction>();
  private overrides: Record<string, BindingOverride> = {};
  private active: string[] = ["global"]; // bottom → top
  private listeners = new Set<() => void>();
  private attached = false;

  constructor() {
    this.overrides = this.load();
  }

  // ---- registration ----

  register(action: HotkeyAction): () => void {
    this.actions.set(action.id, action);
    this.emit();
    return () => { this.actions.delete(action.id); this.emit(); };
  }

  /** Register many at once; returns a single unregister for all. */
  registerAll(actions: HotkeyAction[]): () => void {
    const offs = actions.map((a) => this.register(a));
    return () => offs.forEach((o) => o());
  }

  // ---- active context stack ----

  setContexts(stack: string[]) {
    this.active = stack.length ? stack : ["global"];
    this.emit();
  }
  getContexts(): string[] { return [...this.active]; }

  // ---- bindings ----

  primary(id: string): string | null {
    const a = this.actions.get(id); if (!a) return null;
    const o = this.overrides[id];
    if (o && "primary" in o) return o.primary ?? null;
    return a.defaultPrimary ?? null;
  }
  secondary(id: string): string | null {
    const a = this.actions.get(id); if (!a) return null;
    const o = this.overrides[id];
    if (o && "secondary" in o) return o.secondary ?? null;
    return a.defaultSecondary ?? null;
  }

  /** Set a binding slot (null clears it). Persists. */
  setBinding(id: string, slot: "primary" | "secondary", key: string | null) {
    if (!this.actions.has(id)) throw new Error(`No hotkey action "${id}"`);
    const o = this.overrides[id] ?? (this.overrides[id] = {});
    o[slot] = key;
    this.save();
    this.emit();
  }

  /** Drop custom bindings for an action, restoring its defaults. */
  resetBinding(id: string) {
    delete this.overrides[id];
    this.save();
    this.emit();
  }

  resetAll() {
    this.overrides = {};
    this.save();
    this.emit();
  }

  // ---- dispatch ----

  /** Resolve and run the action bound to this event. Returns true if handled. */
  handle(e: KeyboardEvent): boolean {
    const key = eventToKey(e);
    if (isModifierOnly(key)) return false;
    // Walk the active stack top-down so higher contexts override lower ones.
    for (let i = this.active.length - 1; i >= 0; i--) {
      const ctx = this.active[i];
      for (const a of this.actions.values()) {
        if (a.context !== ctx) continue;
        if (this.primary(a.id) !== key && this.secondary(a.id) !== key) continue;
        if (a.when && !a.when()) continue; // fall through to lower contexts
        a.run();
        return true;
      }
    }
    return false;
  }

  // ---- introspection (for UI + MCP) ----

  /** All registered actions, grouped by context in stack order (top-most last). */
  describe(): {
    contexts: {
      context: string;
      active: boolean;
      actions: { id: string; label: string; primary: string | null; secondary: string | null; customized: boolean }[];
    }[];
    conflicts: ConflictInfo[];
  } {
    const byContext = new Map<string, HotkeyAction[]>();
    for (const a of this.actions.values()) {
      (byContext.get(a.context) ?? byContext.set(a.context, []).get(a.context)!).push(a);
    }
    // Order: active stack first (bottom→top), then any inactive contexts.
    const order = [...this.active];
    for (const c of byContext.keys()) if (!order.includes(c)) order.push(c);
    const contexts = order
      .filter((c) => byContext.has(c))
      .map((context) => ({
        context,
        active: this.active.includes(context),
        actions: byContext.get(context)!.map((a) => ({
          id: a.id,
          label: a.label,
          primary: this.primary(a.id),
          secondary: this.secondary(a.id),
          customized: !!this.overrides[a.id],
        })),
      }));
    return { contexts, conflicts: this.conflicts() };
  }

  /** Within-context clashes (same key bound to two actions in one context). */
  conflicts(): ConflictInfo[] {
    const out: ConflictInfo[] = [];
    const byContext = new Map<string, HotkeyAction[]>();
    for (const a of this.actions.values()) {
      (byContext.get(a.context) ?? byContext.set(a.context, []).get(a.context)!).push(a);
    }
    for (const [context, acts] of byContext) {
      const seen = new Map<string, string[]>();
      for (const a of acts) {
        for (const key of [this.primary(a.id), this.secondary(a.id)]) {
          if (!key) continue;
          (seen.get(key) ?? seen.set(key, []).get(key)!).push(a.id);
        }
      }
      for (const [key, ids] of seen) if (ids.length > 1) out.push({ context, key, actionIds: ids });
    }
    return out;
  }

  // ---- change subscription (UI) ----

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() { for (const l of this.listeners) l(); }

  // ---- window listener ----

  attach(target: Window | HTMLElement = window): () => void {
    if (this.attached) return () => {};
    this.attached = true;
    const onKey = (ev: Event) => {
      const e = ev as KeyboardEvent;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (this.handle(e)) e.preventDefault();
    };
    target.addEventListener("keydown", onKey);
    return () => { target.removeEventListener("keydown", onKey); this.attached = false; };
  }

  // ---- persistence ----

  private load(): Record<string, BindingOverride> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.overrides)); } catch { /* ignore */ }
  }
}

/** App-wide singleton. */
export const hotkeys = new HotkeyManager();
