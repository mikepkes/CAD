// The icon set: every icon's data is valid (each path parses, nothing leaves the
// 24×24 box, strokes included), variants point at real bases, and every
// registered command type resolves to a real icon, not the fallback.
// (Hotkey actions are covered in test/ui/icons.test.tsx: registering them needs a DOM.)

import { describe, it, expect } from "vitest";
import { ICONS, ICON_NAMES, FALLBACK_ICON, isIconName, resolveIcon, type IconDef } from "../src/ui/icons/icons";
import { MOD_BADGE, MOD_MASK, STROKE, DOT_R } from "../src/ui/icons/icons";
import { iconForCommand, iconForAction, iconForPanel, iconForView, JOINT_ICONS, PRIMITIVE_ICONS, CONSTRAINT_ICONS } from "../src/ui/icons/lookup";
import { createDefaultRegistry } from "../src/core/command/builtins";

/** Commands that may show the fallback icon. Empty: every command has its own.
 *  Add a type here (with a comment saying why) only for a command with nothing to draw. */
const COMMAND_EXCEPTIONS: string[] = [];

// ---- a small SVG path parser: the points along each path, sampled ----

type Pt = [number, number];

function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([\s,]+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) out.push(m[1]);
    else if (m[2]) out.push(parseFloat(m[2]));
    else if (m[4]) throw new Error(`unexpected "${m[4]}" at ${m.index} in ${d}`);
  }
  return out;
}

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Points sampled along an arc in endpoint form (SVG 1.1 F.6.5). */
function arcPoints(p0: Pt, rx: number, ry: number, phiDeg: number, large: number, sweep: number, p1: Pt): Pt[] {
  if (rx === 0 || ry === 0) return [p1];
  const phi = (phiDeg * Math.PI) / 180, c = Math.cos(phi), s = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = c * dx + s * dy, y1 = -s * dx + c * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = c * cx1 - s * cy1 + (p0[0] + p1[0]) / 2, cy = s * cx1 + c * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const pts: Pt[] = [];
  for (let i = 1; i <= 32; i++) {
    const t = t0 + (dt * i) / 32;
    pts.push([cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c]);
  }
  return pts;
}

/** Parse a path and return points sampled along it; throws on anything malformed. */
export function samplePath(d: string): Pt[] {
  const toks = tokenize(d);
  const pts: Pt[] = [];
  let i = 0, cmd = "", cur: Pt = [0, 0], start: Pt = [0, 0], lastCtrl: Pt | null = null, lastCmd = "";
  const num = () => {
    const v = toks[i++];
    if (typeof v !== "number") throw new Error(`expected a number, got ${String(v)} in ${d}`);
    return v;
  };
  if (toks[0] !== "M" && toks[0] !== "m") throw new Error(`path must start with a moveto: ${d}`);
  while (i < toks.length) {
    if (typeof toks[i] === "string") cmd = toks[i++] as string;
    else if (!cmd || cmd === "Z" || cmd === "z") throw new Error(`stray number in ${d}`);
    const C = cmd.toUpperCase(), rel = cmd !== C;
    const ox = rel ? cur[0] : 0, oy = rel ? cur[1] : 0;
    const cubic = (a: Pt, b: Pt, e: Pt) => { for (let k = 1; k <= 24; k++) { const t = k / 24, u = 1 - t; pts.push([u * u * u * cur[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t * t * t * e[0], u * u * u * cur[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t * t * t * e[1]]); } };
    const quad = (a: Pt, e: Pt) => { for (let k = 1; k <= 24; k++) { const t = k / 24, u = 1 - t; pts.push([u * u * cur[0] + 2 * u * t * a[0] + t * t * e[0], u * u * cur[1] + 2 * u * t * a[1] + t * t * e[1]]); } };
    switch (C) {
      case "M": { cur = [ox + num(), oy + num()]; start = cur; pts.push(cur); cmd = rel ? "l" : "L"; lastCtrl = null; break; }
      case "L": { cur = [ox + num(), oy + num()]; pts.push(cur); lastCtrl = null; break; }
      case "H": { cur = [ox + num(), cur[1]]; pts.push(cur); lastCtrl = null; break; }
      case "V": { cur = [cur[0], oy + num()]; pts.push(cur); lastCtrl = null; break; }
      case "C": { const a: Pt = [ox + num(), oy + num()], b: Pt = [ox + num(), oy + num()], e: Pt = [ox + num(), oy + num()]; cubic(a, b, e); lastCtrl = b; cur = e; break; }
      case "S": { const a: Pt = lastCtrl && /[CS]/i.test(lastCmd) ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur; const b: Pt = [ox + num(), oy + num()], e: Pt = [ox + num(), oy + num()]; cubic(a, b, e); lastCtrl = b; cur = e; break; }
      case "Q": { const a: Pt = [ox + num(), oy + num()], e: Pt = [ox + num(), oy + num()]; quad(a, e); lastCtrl = a; cur = e; break; }
      case "T": { const a: Pt = lastCtrl && /[QT]/i.test(lastCmd) ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur; const e: Pt = [ox + num(), oy + num()]; quad(a, e); lastCtrl = a; cur = e; break; }
      case "A": {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        if (![0, 1].includes(large) || ![0, 1].includes(sweep)) throw new Error(`bad arc flags in ${d}`);
        const e: Pt = [ox + num(), oy + num()];
        pts.push(...arcPoints(cur, rx, ry, rot, large, sweep, e)); cur = e; lastCtrl = null; break;
      }
      case "Z": { cur = start; lastCtrl = null; break; }
      default: throw new Error(`unknown command ${cmd} in ${d}`);
    }
    lastCmd = C;
    if (ARITY[C] === undefined) throw new Error(`unknown command ${cmd}`);
  }
  if (pts.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) throw new Error(`non-finite point in ${d}`);
  return pts;
}

const isVariant = (d: IconDef): d is Extract<IconDef, { base: string }> => "base" in d;
const LO = STROKE / 2, HI = 24 - STROKE / 2;

describe("icon data", () => {
  it("has a healthy set of icons, each with a label", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(120);
    for (const n of ICON_NAMES) expect(ICONS[n].label, n).toBeTruthy();
    expect(isIconName(FALLBACK_ICON)).toBe(true);
  });

  it("parses every path and keeps every stroke inside the 24×24 box", () => {
    const all: Record<string, IconDef> = ICONS;
    for (const [name, def] of Object.entries(all)) {
      if (isVariant(def)) continue;
      expect(def.d || def.dash || def.dots?.length, `${name} draws something`).toBeTruthy();
      for (const d of [def.d, def.dash]) {
        if (!d) continue;
        const pts = samplePath(d);
        expect(pts.length, name).toBeGreaterThan(1);
        for (const [x, y] of pts) {
          expect(x, `${name} x`).toBeGreaterThanOrEqual(LO - 1e-6);
          expect(x, `${name} x`).toBeLessThanOrEqual(HI + 1e-6);
          expect(y, `${name} y`).toBeGreaterThanOrEqual(LO - 1e-6);
          expect(y, `${name} y`).toBeLessThanOrEqual(HI + 1e-6);
        }
      }
      for (const [cx, cy, r = DOT_R] of def.dots ?? []) {
        expect(r, name).toBeGreaterThan(0);
        expect(r, `${name}: a dot is a small accent`).toBeLessThanOrEqual(3);
        expect(Math.min(cx - r, cy - r), name).toBeGreaterThanOrEqual(0);
        expect(Math.max(cx + r, cy + r), name).toBeLessThanOrEqual(24);
      }
    }
  });

  it("keeps the modifier badges inside the box and inside their masked corner", () => {
    for (const [mod, d] of Object.entries(MOD_BADGE)) {
      for (const [x, y] of samplePath(d)) {
        expect(Math.hypot(x - MOD_MASK.cx, y - MOD_MASK.cy), mod).toBeLessThanOrEqual(MOD_MASK.r - LO + 1e-6);
        expect(Math.max(x, y), mod).toBeLessThanOrEqual(HI);
      }
    }
  });

  it("builds every variant on a real base glyph", () => {
    const all: Record<string, IconDef> = ICONS;
    for (const [name, def] of Object.entries(all)) {
      if (!isVariant(def)) continue;
      expect(isIconName(def.base), `${name} → ${def.base}`).toBe(true);
      expect(isVariant(all[def.base]), `${name}'s base is itself a base`).toBe(false);
      expect(resolveIcon(name).mod).toBe(def.mod);
    }
  });

  it("rejects malformed paths", () => {
    expect(() => samplePath("L1 1")).toThrow();
    expect(() => samplePath("M1 1L2")).toThrow();
    expect(() => samplePath("M1 1X2 2")).toThrow();
    expect(() => samplePath("M1 1A2 2 0 3 1 4 4")).toThrow();
  });

  it("samples curves along their true extent (so the bounds check sees arcs and béziers, not just endpoints)", () => {
    const xs = (d: string) => samplePath(d).map((p) => p[0]), ys = (d: string) => samplePath(d).map((p) => p[1]);
    const circle = "M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0";
    expect(Math.min(...ys(circle))).toBeCloseTo(3, 1);
    expect(Math.max(...ys(circle))).toBeCloseTo(21, 1);
    expect(Math.min(...ys("M3 18C6 6 10 6 12 12"))).toBeCloseTo(8.06, 1);
    expect(Math.max(...xs("M12 4a8 8 0 0 1 0 16"))).toBeCloseTo(20, 1);
  });

  it("draws an unknown name as the fallback", () => {
    expect(resolveIcon("no-such-icon").glyph).toBe(ICONS[FALLBACK_ICON]);
  });
});

describe("command icons", () => {
  const types = createDefaultRegistry().list().map((d) => d.type);

  it("gives every registered command its own icon", () => {
    expect(types.length).toBeGreaterThan(70);
    const missing = types.filter((t) => !COMMAND_EXCEPTIONS.includes(t) && iconForCommand(t) === FALLBACK_ICON);
    expect(missing).toEqual([]);
    for (const t of types) expect(isIconName(iconForCommand(t)), t).toBe(true);
  });

  it("lists only real commands as exceptions", () => {
    for (const t of COMMAND_EXCEPTIONS) expect(types, t).toContain(t);
  });

  it("picks the icon by kind where the kind is a parameter", () => {
    for (const [kind, icon] of Object.entries(JOINT_ICONS)) {
      expect(iconForCommand("joint.create", { kind })).toBe(icon);
      expect(isIconName(icon)).toBe(true);
    }
    expect(iconForCommand("joint.template")).toBe("joint-revolute"); // its default kind
    expect(iconForCommand("joint.create")).toBe("joint-rigid");
    for (const [shape, icon] of Object.entries(PRIMITIVE_ICONS)) expect(iconForCommand("feature.primitive", { shape })).toBe(icon);
    expect(iconForCommand("feature.pattern", { mode: "circular" })).toBe("pattern-circular");
    expect(iconForCommand("feature.pattern", { mode: "linear" })).toBe("pattern-linear");
    for (const [type, icon] of Object.entries(CONSTRAINT_ICONS)) {
      expect(iconForCommand("sketch.addConstraint", { type })).toBe(icon);
      expect(isIconName(icon)).toBe(true);
    }
    // an unknown kind falls back to the command's own icon, not the generic one
    expect(iconForCommand("joint.create", { kind: "warp" })).toBe("joint-rigid");
  });

  it("covers every constraint type the sketch model knows", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/sketch/types.ts", "utf8"));
    const kinds = [...src.matchAll(/id: ConstraintId; type: "([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(10);
    for (const k of kinds) expect(CONSTRAINT_ICONS[k], k).toBeDefined();
  });

  it("falls back for unknown commands and actions", () => {
    expect(iconForCommand("nope.nothing")).toBe(FALLBACK_ICON);
    expect(iconForAction("nope.nothing")).toBe(FALLBACK_ICON);
  });

  it("maps views and panels", () => {
    for (const v of ["iso", "front", "top", "right", "back", "left", "bottom"]) expect(iconForView(v)).toBe(`view-${v}`);
    for (const p of ["workbench", "ledger", "space", "lens", "materials", "mechanism"]) expect(iconForPanel(p)).not.toBe(FALLBACK_ICON);
  });
});
