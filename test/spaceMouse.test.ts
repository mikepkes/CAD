import { describe, it, expect } from "vitest";
import { parseSpaceMouseReport, navigationDelta, isIdle, pressed, IDLE, DEFAULT_SETTINGS } from "../src/viewport/spaceMouse";

// The 3D mouse input model: HID report parsing (as both WebHID and the desktop
// reader deliver them) and the deflection → camera-motion mapping.

const report = (...vals: number[]) => { const v = new DataView(new ArrayBuffer(vals.length * 2)); vals.forEach((x, i) => v.setInt16(i * 2, x, true)); return v; };

describe("3D mouse input", () => {
  it("parses split translation/rotation reports and the combined six-axis report", () => {
    let s = parseSpaceMouseReport(1, report(350, -175, 0), IDLE);
    expect(s).toMatchObject({ tx: 1, ty: -0.5, tz: 0, rx: 0 });
    s = parseSpaceMouseReport(2, report(0, 70, -350), s);
    expect(s).toMatchObject({ tx: 1, rx: 0, ry: 0.2, rz: -1 });
    s = parseSpaceMouseReport(1, report(0, 0, 35, 700, 0, 0), s); // newer devices: all six in report 1, clamped to ±1
    expect(s).toMatchObject({ tx: 0, tz: 0.1, rx: 1, rz: 0 });
  });

  it("reads buttons and finds the ones just pressed", () => {
    const b = new DataView(new Uint8Array([0b101, 0]).buffer);
    const s = parseSpaceMouseReport(3, b, IDLE);
    expect(s.buttons).toBe(5);
    expect(pressed(0b001, 0b111)).toEqual([1, 2]);
    expect(pressed(0b111, 0b001)).toEqual([]);
    expect(parseSpaceMouseReport(9, b, s)).toBe(s); // unknown reports are ignored
  });

  it("ignores small deflections and eases in past the deadzone", () => {
    const tiny = navigationDelta({ ...IDLE, tx: 0.03, rz: -0.02 }, 1 / 60, DEFAULT_SETTINGS, false);
    expect(isIdle(tiny)).toBe(true);
    const half = navigationDelta({ ...IDLE, tx: 0.5 }, 1, DEFAULT_SETTINGS, false).panX;
    const full = navigationDelta({ ...IDLE, tx: 1 }, 1, DEFAULT_SETTINGS, false).panX;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full / 2); // eased response: fine control near rest
  });

  it("maps pull to zoom-in, lift to pan up, twist to spin, and scales with time and speed", () => {
    const d = navigationDelta({ ...IDLE, ty: 1, tz: -1, rz: 1 }, 0.5, DEFAULT_SETTINGS, false);
    expect(d.zoom).toBeGreaterThan(1);
    expect(d.panY).toBeGreaterThan(0);
    expect(d.yaw).toBeGreaterThan(0);
    const fast = navigationDelta({ ...IDLE, rz: 1 }, 0.5, { ...DEFAULT_SETTINGS, speed: 2 }, false);
    expect(fast.yaw).toBeCloseTo(2 * d.yaw, 9);
  });

  it("stays in the sketch plane, honours rotation lock, and inverts axes", () => {
    const tilt = { ...IDLE, rx: 1, rz: 1, ry: 1, tx: 1 };
    const sketch = navigationDelta(tilt, 0.1, DEFAULT_SETTINGS, true);
    expect([sketch.pitch, sketch.yaw, sketch.roll]).toEqual([0, 0, 0]);
    expect(sketch.panX).toBeGreaterThan(0); // pan still works
    const locked = navigationDelta(tilt, 0.1, { ...DEFAULT_SETTINGS, lockRotation: true }, false);
    expect(locked.pitch).toBe(0);
    const inverted = navigationDelta(tilt, 0.1, { ...DEFAULT_SETTINGS, invert: { tx: true } }, false);
    expect(inverted.panX).toBeCloseTo(-navigationDelta(tilt, 0.1, DEFAULT_SETTINGS, false).panX, 12);
  });
});
