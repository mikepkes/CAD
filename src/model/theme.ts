// Light and dark themes. The preference (System, Light or Dark) is a UI pref in
// localStorage; the resolved theme is written to <html data-theme="…"> where
// the CSS tokens (styles.css, kit.css) switch, and handed to the 3D viewport's
// palette (viewport/palette.ts), so one switch repaints chrome and scene alike.
// "system" follows prefers-color-scheme live.

import { create } from "zustand";
import { setViewportTheme } from "../viewport/palette";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_LS = "vibecad.theme";
export const THEME_PREFS: ThemePref[] = ["system", "light", "dark"];
/** The browser chrome colour (<meta name="theme-color">) per theme: each theme's --bg. */
export const THEME_META_COLOR: Record<Theme, string> = { dark: "#1b1d23", light: "#e7eaee" };

/** The theme a preference shows, given whether the system asks for dark. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

const media = (): MediaQueryList | null => {
  try { return typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null; } catch { return null; }
};

/** Whether the system asks for a dark theme (dark when it can't be told: the app was dark-only). */
export function systemPrefersDark(): boolean {
  const m = media();
  return m ? m.matches : true;
}

export function loadThemePref(): ThemePref {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_LS) : null;
    return THEME_PREFS.includes(raw as ThemePref) ? (raw as ThemePref) : "system";
  } catch { return "system"; }
}

/** Paint a theme: the document's attribute and colour scheme, the browser chrome colour, the viewport palette. */
export function applyTheme(theme: Theme) {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_META_COLOR[theme]);
  }
  setViewportTheme(theme);
}

export interface ThemeState {
  /** What the user chose in Settings. */
  pref: ThemePref;
  /** What shows: the preference resolved against the system setting. */
  theme: Theme;
  setPref: (pref: ThemePref) => void;
  /** Re-resolve after the system setting changes. */
  syncSystem: () => void;
}

export const useTheme = create<ThemeState>((set, get) => {
  const pref = loadThemePref();
  return {
    pref,
    theme: resolveTheme(pref, systemPrefersDark()),
    setPref: (p) => {
      try { localStorage.setItem(THEME_LS, p); } catch { /* ignore */ }
      set({ pref: p, theme: resolveTheme(p, systemPrefersDark()) });
    },
    syncSystem: () => {
      const theme = resolveTheme(get().pref, systemPrefersDark());
      if (theme !== get().theme) set({ theme });
    },
  };
});

let installed: (() => void) | null = null;

/** Apply the theme now and on every change (the preference, or the system's while it is followed). Returns an uninstaller. */
export function installTheme(): () => void {
  if (installed) return installed;
  applyTheme(useTheme.getState().theme);
  const unsub = useTheme.subscribe((s, prev) => { if (s.theme !== prev.theme) applyTheme(s.theme); });
  const m = media();
  const onSystem = () => useTheme.getState().syncSystem();
  m?.addEventListener?.("change", onSystem);
  installed = () => { unsub(); m?.removeEventListener?.("change", onSystem); installed = null; };
  return installed;
}
