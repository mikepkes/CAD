// 3D mouse (3Dconnexion SpaceMouse and compatible 6-DoF devices). One input
// model for every source — WebHID in a Chromium browser, a native HID reader
// in the desktop app — so the viewport never cares where motion came from.
//
// A SpaceMouse reports over HID: report 1 = translation (x, y, z as int16 LE;
// newer devices put all six axes in report 1), report 2 = rotation (rx, ry,
// rz), report 3 = button bitmask. Device axes, cap facing the user: +x right,
// +y away (push), +z down (press); rx tilt toward the user, ry roll right, rz
// twist clockwise.

/** 3Dconnexion vendor ids (current, and Logitech for older 3Dconnexion devices). */
export const SPACEMOUSE_VENDORS = [0x256f, 0x046d];

/** Full-scale axis value most devices report (deflections are clamped to ±1). */
const FULL_SCALE = 350;

export interface SpaceMouseState {
  /** Translation and rotation, each normalised to [-1, 1] (device axes). */
  tx: number; ty: number; tz: number; rx: number; ry: number; rz: number;
  /** Pressed buttons, bit i = button i. */
  buttons: number;
}

export const IDLE: SpaceMouseState = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, buttons: 0 };

/** Fold one HID input report into the state. `data` excludes the report id. */
export function parseSpaceMouseReport(reportId: number, data: DataView, prev: SpaceMouseState): SpaceMouseState {
  const axis = (i: number) => (data.byteLength >= (i + 1) * 2 ? Math.max(-1, Math.min(1, data.getInt16(i * 2, true) / FULL_SCALE)) : 0);
  switch (reportId) {
    case 1:
      return data.byteLength >= 12
        ? { ...prev, tx: axis(0), ty: axis(1), tz: axis(2), rx: axis(3), ry: axis(4), rz: axis(5) }
        : { ...prev, tx: axis(0), ty: axis(1), tz: axis(2) };
    case 2:
      return { ...prev, rx: axis(0), ry: axis(1), rz: axis(2) };
    case 3:
      return { ...prev, buttons: data.byteLength >= 4 ? data.getUint32(0, true) : data.byteLength >= 2 ? data.getUint16(0, true) : data.byteLength ? data.getUint8(0) : 0 };
    default:
      return prev;
  }
}

export interface SpaceMouseSettings {
  /** Overall speed multiplier (1 = default). */
  speed: number;
  /** Deflection below which an axis reads as zero (0..1). */
  deadzone: number;
  /** Disable rotation everywhere (pan / zoom only). */
  lockRotation: boolean;
  /** Flip an axis. */
  invert: Partial<Record<"tx" | "ty" | "tz" | "rx" | "ry" | "rz", boolean>>;
  /** Button index → hotkey action id. */
  buttons: Record<number, string>;
}

export const DEFAULT_SETTINGS: SpaceMouseSettings = {
  speed: 1,
  deadzone: 0.04,
  lockRotation: false,
  invert: {},
  buttons: { 0: "view.frame", 1: "view.iso" },
};

/** Camera motion for one frame, in view terms: pan is a fraction of the visible
 *  height (+x right, +y up), zoom a dolly factor (>1 = closer), rotations in
 *  radians about the screen's right axis (pitch), the world up axis (yaw) and
 *  the view axis (roll). */
export interface NavigationDelta { panX: number; panY: number; zoom: number; pitch: number; yaw: number; roll: number }

const shape = (v: number, dz: number) => {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  const t = (a - dz) / (1 - dz); // rescale past the deadzone, then ease in
  return Math.sign(v) * t * t;
};

/**
 * The motion for `dt` seconds of a held deflection ("object mode": the model
 * moves the way the cap is pushed). In a sketch (`planar`) rotation is off, so
 * the view never leaves the sketch plane.
 */
export function navigationDelta(s: SpaceMouseState, dt: number, settings: SpaceMouseSettings, planar: boolean): NavigationDelta {
  const k = settings.speed * dt;
  const ax = (name: keyof SpaceMouseSettings["invert"]) => (settings.invert[name] ? -1 : 1) * shape(s[name], settings.deadzone);
  const rotate = !planar && !settings.lockRotation;
  return {
    panX: 0.9 * k * ax("tx"),
    panY: -0.9 * k * ax("tz"),            // lift the cap → the model rises
    zoom: Math.exp(1.6 * k * ax("ty")),   // push away → closer
    pitch: rotate ? 1.8 * k * ax("rx") : 0,
    yaw: rotate ? 1.8 * k * ax("rz") : 0,
    roll: rotate ? 1.2 * k * ax("ry") : 0,
  };
}

/** Whether a delta moves anything (so an idle device costs nothing per frame). */
export const isIdle = (d: NavigationDelta) => !d.panX && !d.panY && d.zoom === 1 && !d.pitch && !d.yaw && !d.roll;

/** Buttons that went down between two states (indices). */
export function pressed(prev: number, next: number): number[] {
  const down = next & ~prev;
  const out: number[] = [];
  for (let i = 0; i < 32; i++) if (down & (1 << i)) out.push(i);
  return out;
}
