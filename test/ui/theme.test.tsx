// Light and dark themes: resolving the preference against the system setting,
// persisting it, applying it to the document and the viewport palette, the
// Settings control, and the CSS tokens staying in step with the viewport.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render, screen, fireEvent, act } from "@testing-library/react";

type Listener = (e: { matches: boolean }) => void;
/** A controllable prefers-color-scheme: dark media query. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    get matches() { return dark; },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => mql);
  return { set(d: boolean) { dark = d; for (const fn of listeners) fn({ matches: d }); }, listeners };
}

/** Fresh modules (the theme store reads storage and the system once, at load). */
async function load() {
  vi.resetModules();
  const theme = await import("../../src/model/theme");
  const palette = await import("../../src/viewport/palette");
  return { ...theme, ...palette };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("theme resolution", () => {
  it("System follows the system setting; Light and Dark ignore it", async () => {
    fakeSystem(true);
    const { resolveTheme } = await load();
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    for (const sys of [true, false]) {
      expect(resolveTheme("light", sys)).toBe("light");
      expect(resolveTheme("dark", sys)).toBe("dark");
    }
  });
  it("defaults to System, so a light system starts light", async () => {
    fakeSystem(false);
    const { useTheme } = await load();
    expect(useTheme.getState()).toMatchObject({ pref: "system", theme: "light" });
  });
  it("falls back to dark when the system can't be asked", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const { useTheme, systemPrefersDark } = await load();
    expect(systemPrefersDark()).toBe(true);
    expect(useTheme.getState().theme).toBe("dark");
  });
});

describe("persistence", () => {
  it("stores the choice under vibecad.theme and reads it back", async () => {
    fakeSystem(true);
    let m = await load();
    expect(m.THEME_LS).toBe("vibecad.theme");
    m.useTheme.getState().setPref("light");
    expect(localStorage.getItem("vibecad.theme")).toBe("light");
    m = await load(); // a reload
    expect(m.useTheme.getState()).toMatchObject({ pref: "light", theme: "light" });
  });
  it("ignores a stored value it doesn't know", async () => {
    fakeSystem(true);
    localStorage.setItem("vibecad.theme", "sepia");
    const { loadThemePref, useTheme } = await load();
    expect(loadThemePref()).toBe("system");
    expect(useTheme.getState().theme).toBe("dark");
  });
});

describe("applying a theme", () => {
  it("switching sets the document's theme attribute and colour scheme at once", async () => {
    fakeSystem(true);
    const { installTheme, useTheme } = await load();
    const off = installTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    act(() => useTheme.getState().setPref("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    act(() => useTheme.getState().setPref("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    off();
  });
  it("switching repaints the viewport: its palette changes and live scenes are told", async () => {
    fakeSystem(true);
    const { installTheme, useTheme, viewportColors, onViewportTheme, DARK_VIEWPORT, LIGHT_VIEWPORT } = await load();
    const off = installTheme();
    expect(viewportColors()).toBe(DARK_VIEWPORT);
    const seen: string[] = [];
    const unsub = onViewportTheme((t) => seen.push(t));
    useTheme.getState().setPref("light");
    expect(viewportColors()).toBe(LIGHT_VIEWPORT);
    expect(viewportColors().bg).toBe(0xe7eaee);
    useTheme.getState().setPref("light"); // no change, no repaint
    useTheme.getState().setPref("dark");
    expect(viewportColors().bg).toBe(0x1b1d23);
    expect(seen).toEqual(["light", "dark"]);
    unsub();
    off();
  });
  it("under System, follows the system setting as it changes; a fixed choice doesn't", async () => {
    const sys = fakeSystem(true);
    const { installTheme, useTheme, viewportTheme } = await load();
    const off = installTheme();
    sys.set(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(viewportTheme()).toBe("light");
    useTheme.getState().setPref("dark");
    sys.set(true);
    sys.set(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
    off();
    expect(sys.listeners.size).toBe(0);
  });
  it("updates the browser chrome colour", async () => {
    fakeSystem(true);
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
    const { applyTheme, THEME_META_COLOR } = await load();
    applyTheme("light");
    expect(meta.content).toBe(THEME_META_COLOR.light);
    applyTheme("dark");
    expect(meta.content).toBe(THEME_META_COLOR.dark);
    meta.remove();
  });
});

describe("the Settings control", () => {
  it("offers System, Light and Dark and applies the choice", async () => {
    fakeSystem(true);
    const { installTheme } = await load();
    const off = installTheme();
    const { useStore } = await import("../../src/model/store");
    const { SettingsPanel } = await import("../../src/ui/SettingsPanel");
    act(() => useStore.getState().setSettingsOpen(true));
    render(<SettingsPanel />);
    const group = screen.getByRole("group", { name: "Appearance" });
    const pill = (name: string) => screen.getByRole("button", { name });
    expect(group).toBeTruthy();
    expect(pill("System").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/now dark/)).toBeTruthy();
    fireEvent.click(pill("Light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(pill("Light").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("vibecad.theme")).toBe("light");
    fireEvent.click(pill("Dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => useStore.getState().setSettingsOpen(false));
    off();
  });
});

// ---- the CSS tokens ----
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const STYLES = read("../../src/styles.css");
const KIT = read("../../src/ui/kit/kit.css");
/** The custom properties declared in the first block opened by `selector`. */
function tokens(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(selector + " {");
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(at, css.indexOf("\n}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
function luminance(h: string) {
  const c = h.replace("#", "");
  const full = c.length === 3 ? [...c].map((x) => x + x).join("") : c;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe("theme tokens", () => {
  const appDark = tokens(STYLES, ":root"), appLight = tokens(STYLES, ':root[data-theme="light"]');
  const kitDark = tokens(KIT, ":root"), kitLight = tokens(KIT, ':root[data-theme="light"]');

  it("the light theme sets every colour token the dark one does", () => {
    const colourish = (v: string) => /#|rgba?\(|var\(|transparent|\d+px/.test(v);
    const missing = Object.entries(appDark).filter(([k, v]) => colourish(v) && k !== "--radius" && k !== "--paper" /* paper is paper in either theme */ && !(k in appLight)).map(([k]) => k);
    expect(missing).toEqual([]);
    const kitColours = ["--k-accent", "--k-accent-ink", "--k-accent-tint", "--k-accent-dim", "--k-select", "--k-select-tint", "--k-agent", "--k-agent-tint", "--k-agent-line", "--k-ok", "--k-bad", "--k-ghost", "--k-float", "--k-float-line", "--k-chip-at", "--k-ghost-line", "--k-ghost-ink", "--k-track", "--k-leader", "--k-shadow", "--k-scrim"];
    for (const k of kitColours) {
      expect(kitDark[k], k).toBeTruthy();
      expect(kitLight[k], k).toBeTruthy();
    }
  });
  it("mirrors the viewport palette: background, x-ray edges, browser chrome colour", async () => {
    fakeSystem(true);
    const { DARK_VIEWPORT, LIGHT_VIEWPORT, THEME_META_COLOR } = await load();
    expect(appDark["--bg"]).toBe(hex(DARK_VIEWPORT.bg));
    expect(appLight["--bg"]).toBe(hex(LIGHT_VIEWPORT.bg));
    expect(THEME_META_COLOR).toEqual({ dark: appDark["--bg"], light: appLight["--bg"] });
    expect(kitDark["--k-an-edge"]).toBe(hex(DARK_VIEWPORT.xrayEdge));
    expect(kitLight["--k-an-edge"]).toBe(hex(LIGHT_VIEWPORT.xrayEdge));
    expect(kitDark["--k-accent"]).toBe(hex(DARK_VIEWPORT.variant));
  });
  it("light text meets WCAG AA on the light surfaces", () => {
    const surfaces = ["--panel", "--panel-2", "--bg"].map((k) => appLight[k]);
    for (const ink of ["--text", "--text-dim", "--accent", "--accent-2", "--ok", "--warn", "--bad", "--caution", "--danger-ink", "--error-ink", "--ic-connector", "--ic-pattern", "--ic-joint", "--ic-datum"]) {
      for (const s of surfaces.slice(0, 2)) expect(contrast(appLight[ink], s), `${ink} on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(appLight["--text-dim"], appLight["--bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(appLight["--on-accent"], appLight["--accent"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(appLight["--on-accent-2"], appLight["--accent-2"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(appLight["--toast-error-ink"], appLight["--toast-error-bg"])).toBeGreaterThanOrEqual(4.5);
    for (const ink of ["--k-accent", "--k-select", "--k-agent", "--k-ok", "--k-bad", "--k-ghost-ink"]) {
      expect(contrast(kitLight[ink], "#ffffff"), ink).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(kitLight["--k-accent-ink"], kitLight["--k-accent"])).toBeGreaterThanOrEqual(4.5);
  });
  it("sketch geometry and dimensions read on the light viewport", async () => {
    fakeSystem(true);
    const { LIGHT_VIEWPORT: p } = await load();
    const bg = hex(p.bg);
    for (const k of ["geometry", "underConstrained", "construction", "bad", "dimension", "selected", "hover", "point", "origin", "preview", "axisX", "axisY", "axisZ"] as const) {
      expect(contrast(hex(p[k]), bg), k).toBeGreaterThanOrEqual(3); // lines and marks: AA for graphics
    }
    expect(contrast(p.dimensionText, "#ffffff")).toBeGreaterThanOrEqual(4.5); // label text on its plate
    expect(contrast(p.badgeText, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(p.exactLabels).toBe(true);
  });
});
