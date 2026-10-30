// Feeds the viewport from a 3D mouse. Two sources, one parser (spaceMouse.ts):
//   - WebHID in Chromium browsers (pairing needs a click; once granted, the
//     device reconnects on its own next time), and
//   - the desktop app's native HID reader (WKWebView has no WebHID), which
//     forwards raw reports as `spacemouse-report` events.
// Button presses run hotkey actions (fit, standard views, …) per the settings.

import { getActiveScene } from "../viewport/sceneRef";
import { DEFAULT_SETTINGS, IDLE, SPACEMOUSE_VENDORS, SpaceMouseSettings, SpaceMouseState, parseSpaceMouseReport, pressed } from "../viewport/spaceMouse";
import { hotkeys } from "./hotkeys";
import { isTauri } from "./desktopMcp";

const SETTINGS_KEY = "chisel.spacemouse.v1";

export interface SpaceMouseStatus {
  /** Where motion comes from, or null when no device is connected. */
  source: "webhid" | "native" | null;
  product?: string;
  /** Why no device could be used (no WebHID, the driver holds it, …). */
  note?: string;
}

/** Minimal WebHID typings (not in TypeScript's DOM lib). */
interface HidDevice extends EventTarget { opened: boolean; productName: string; open(): Promise<void>; close(): Promise<void>; collections: { usagePage: number; usage: number }[] }
interface HidInputReportEvent extends Event { reportId: number; data: DataView; device: HidDevice }
interface Hid extends EventTarget { getDevices(): Promise<HidDevice[]>; requestDevice(o: { filters: { vendorId?: number; usagePage?: number; usage?: number }[] }): Promise<HidDevice[]> }
const webHid = (): Hid | undefined => (typeof navigator !== "undefined" ? (navigator as unknown as { hid?: Hid }).hid : undefined);

let state: SpaceMouseState = IDLE;
let settings: SpaceMouseSettings = loadSettings();
let status: SpaceMouseStatus = { source: null };
const listeners = new Set<(s: SpaceMouseStatus) => void>();

function loadSettings(): SpaceMouseSettings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SETTINGS_KEY) : null;
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch { return DEFAULT_SETTINGS; }
}

export const spaceMouseSettings = (): SpaceMouseSettings => settings;
export const spaceMouseStatus = (): SpaceMouseStatus => status;
export function onSpaceMouseStatus(fn: (s: SpaceMouseStatus) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
const setStatus = (s: SpaceMouseStatus) => { status = s; for (const fn of listeners) fn(s); };

export function setSpaceMouseSettings(patch: Partial<SpaceMouseSettings>) {
  settings = { ...settings, ...patch, invert: { ...settings.invert, ...(patch.invert ?? {}) } };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  const scene = getActiveScene();
  if (scene) scene.navSettings = settings;
}

/** One HID report from either source. */
function onReport(reportId: number, data: DataView) {
  const next = parseSpaceMouseReport(reportId, data, state);
  for (const b of pressed(state.buttons, next.buttons)) {
    const action = settings.buttons[b];
    if (action) hotkeys.runAction(action);
  }
  state = next;
  const scene = getActiveScene();
  if (scene) { scene.navSettings = settings; scene.setNavigationInput(state); }
}

/** Let go of everything (a disconnect mid-push must not leave the view spinning). */
function release() {
  state = IDLE;
  getActiveScene()?.setNavigationInput(IDLE);
}

const isMultiAxis = (d: HidDevice) => d.collections.some((c) => c.usagePage === 1 && c.usage === 8);

async function useHidDevice(dev: HidDevice): Promise<SpaceMouseStatus> {
  if (!dev.opened) await dev.open();
  dev.addEventListener("inputreport", (e) => { const ev = e as HidInputReportEvent; onReport(ev.reportId, ev.data); });
  return { source: "webhid", product: dev.productName };
}

/** True where the browser can pair a 3D mouse itself (Chromium WebHID). */
export const webHidAvailable = (): boolean => !!webHid();

/** Pair a 3D mouse through WebHID. Must run from a click (the browser asks the user). */
export async function connectWebHid(): Promise<SpaceMouseStatus> {
  const hid = webHid();
  if (!hid) { setStatus({ source: null, note: "This browser has no WebHID — use Chrome or Edge, or the desktop app." }); return status; }
  const devices = await hid.requestDevice({ filters: SPACEMOUSE_VENDORS.map((vendorId) => ({ vendorId, usagePage: 1, usage: 8 })) });
  const dev = devices.find(isMultiAxis) ?? devices[0];
  setStatus(dev ? await useHidDevice(dev) : { source: null, note: "No 3D mouse was chosen." });
  return status;
}

/**
 * Connect without asking: in the desktop app, start listening to the native
 * reader; in a browser, reopen a device paired before. Call once at startup.
 */
export async function autoConnectSpaceMouse(): Promise<SpaceMouseStatus> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    const { invoke } = await import("@tauri-apps/api/core");
    await listen<{ id: number; data: number[] }>("spacemouse-report", (e) => onReport(e.payload.id, new DataView(Uint8Array.from(e.payload.data).buffer)));
    await listen<{ product: string | null; note: string | null }>("spacemouse-status", (e) => {
      if (!e.payload.product) release();
      setStatus(e.payload.product ? { source: "native", product: e.payload.product } : { source: null, note: e.payload.note ?? undefined });
    });
    const s = await invoke<{ product: string | null; note: string | null }>("spacemouse_status");
    setStatus(s.product ? { source: "native", product: s.product } : { source: null, note: s.note ?? undefined });
    return status;
  }
  const hid = webHid();
  if (!hid) return status;
  hid.addEventListener("disconnect", () => { release(); setStatus({ source: null, note: "The 3D mouse was disconnected." }); });
  const dev = (await hid.getDevices()).find((d) => isMultiAxis(d));
  if (dev) setStatus(await useHidDevice(dev));
  return status;
}
