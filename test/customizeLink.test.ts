// A customize link carries the values its controls were moved to, and opening it sets them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deserializeDocument } from "../src/core/persistence";
import { rebuild } from "../src/core/build";
import { createDefaultRegistry } from "../src/core/command/builtins";
import { resolveParameters } from "../src/core/parameters";
import { applyLinkValues, linkDefaults, linkSearch, snapValue } from "../src/model/customizeLink";

const motor = () => deserializeDocument(readFileSync(fileURLToPath(new URL("../public/examples/motor.json", import.meta.url)), "utf8"));
const values = (doc: ReturnType<typeof motor>) => resolveParameters(doc.parameters).scope;

describe("customize link", () => {
  it("lists the model's controls with their own values, not its hidden ones", () => {
    const d = linkDefaults(motor());
    expect(d.size).toBe("3");
    expect(d.length).toMatch(/^pick\(size/);
    expect(d.holes).toMatch(/^pick\(size/);
    expect(d).not.toHaveProperty("Lb"); // hidden
  });

  it("opens with the link's values, snapped onto each control", () => {
    const doc = motor();
    const set = applyLinkValues(doc, new URLSearchParams("mode=customize&example=motor&size=4&length=70&holes=0&horn=0&shaft_d=99&wiring=7&shaft=2.4&angle=width%2F2"));
    expect(set.sort()).toEqual(["holes", "horn", "length", "shaft", "shaft_d", "size"]); // wiring 7 isn't an option; angle isn't a number
    rebuild(doc, createDefaultRegistry());
    const v = values(doc);
    expect(v.size).toBe(4);       // NEMA 23
    expect(v.length).toBe(70);
    expect(v.holes).toBe(0);      // tapped, though a NEMA 23 comes through
    expect(v.shaft_d).toBe(25);   // the slider's top
    expect(v.shaft).toBe(2);      // an option's index, rounded
    expect(v.wiring).toBe(2);     // left at its default
    expect(v.shaft_len).toBeCloseTo(20.6, 6); // still following the size
  });

  it("writes only the values moved off the defaults, keeping the link's own keys", () => {
    const doc = motor();
    const d = linkDefaults(doc);
    rebuild(doc, createDefaultRegistry());
    doc.parameters = resolveParameters(doc.parameters).resolved;
    const at = (changes: Record<string, number>) => doc.parameters.filter((p) => p.name in d).map((p) => (
      p.name in changes ? { name: p.name, expr: String(changes[p.name]), value: changes[p.name] } : { name: p.name, expr: p.expr, value: p.value }));
    expect(linkSearch("?mode=customize&example=motor", at({}), d)).toBe("?mode=customize&example=motor");
    expect(linkSearch("?mode=customize&example=motor", at({ size: 4, length: 70.5 }), d)).toBe("?mode=customize&example=motor&size=4&length=70.5");
    // moved back to the default: out of the link again
    expect(linkSearch("?mode=customize&example=motor&size=4&length=70.5", at({ length: 70.5 }), d)).toBe("?mode=customize&example=motor&length=70.5");
  });

  it("round-trips: the link written opens to the same values", () => {
    const doc = motor();
    const d = linkDefaults(doc);
    rebuild(doc, createDefaultRegistry());
    doc.parameters = resolveParameters(doc.parameters).resolved;
    const changed = { size: 7, ends: 1, rear_len: 33.5, wiring: 1 };
    const cur = doc.parameters.filter((p) => p.name in d).map((p) => (p.name in changed ? { name: p.name, expr: String(changed[p.name as keyof typeof changed]), value: changed[p.name as keyof typeof changed] } : { name: p.name, expr: p.expr, value: p.value }));
    const opened = motor();
    applyLinkValues(opened, new URLSearchParams(linkSearch("?mode=customize&example=motor", cur, d)));
    rebuild(opened, createDefaultRegistry());
    const v = values(opened);
    for (const [k, x] of Object.entries(changed)) expect(v[k], k).toBe(x);
  });

  it("takes only plain numbers", () => {
    const slider = { min: 0, max: 10 };
    expect(snapValue(slider, "3.5")).toBe(3.5);
    expect(snapValue(slider, "-2")).toBe(0);
    expect(snapValue(slider, "1e1")).toBe(10);
    for (const bad of ["", "abc", "2+2", "Infinity", "NaN", "0x10", "width"]) expect(snapValue(slider, bad), bad).toBeNull();
    expect(snapValue({ boolean: true }, "5")).toBe(1);
    expect(snapValue({ values: [1, 2, 4] }, "3")).toBeNull();
  });
});
