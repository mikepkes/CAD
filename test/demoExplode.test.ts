import { describe, it, expect } from "vitest";
import { realSession } from "./helpers";
import { componentsNamed, explodeOffsets, exploded, nameMatches } from "../src/demo/explode";
import { IDENTITY, rotation } from "../src/math/transform";

// The demo's exploded view (display only): parts picked by component name, a part's offset carried by everything
// under it unless that's named too, and the posed frames slid along their offsets.
async function holder() {
  const s = realSession();
  const make = async (name: string, parent?: string) => (await s.dispatch("component.create", { name, ...(parent ? { parent } : {}) })).createdIds[0];
  const h = await make("Holder");
  const plate = await make("Back plate", h), cover = await make("Cover", h);
  const rack = await make("Rack", h), foot = await make("Foot", rack), pin = await make("Foot pin 1", foot);
  const p1 = await make("Pivot pin 1", h), p2 = await make("Pivot pin 2", h);
  return { s, h, plate, cover, rack, foot, pin, p1, p2 };
}

describe("demo explode", () => {
  it("matches names exactly, or by their start with a trailing *", () => {
    expect(nameMatches("Cover", "Cover")).toBe(true);
    expect(nameMatches("Cover", "Cover 2")).toBe(false);
    expect(nameMatches("Pivot pin*", "Pivot pin 3")).toBe(true);
    expect(nameMatches("Pivot pin*", "Guide pin 1")).toBe(false);
  });

  it("picks the named components and everything under them", async () => {
    const m = await holder();
    expect([...componentsNamed(m.s.doc, ["Rack"])].sort()).toEqual([m.rack, m.foot, m.pin].sort());
    expect([...componentsNamed(m.s.doc, ["Pivot pin*"])].sort()).toEqual([m.p1, m.p2].sort());
  });

  it("gives a part its own offset, or its nearest named ancestor's; unnamed parts stay", async () => {
    const m = await holder();
    const by = explodeOffsets(m.s.doc, { Rack: [0, -20, 0], "Foot pin*": [0, -5, 0], "Pivot pin*": [0, -60, 0] });
    expect(by.get(m.rack)).toEqual({ x: 0, y: -20, z: 0 });
    expect(by.get(m.foot)).toEqual({ x: 0, y: -20, z: 0 }); // rides with the rack
    expect(by.get(m.pin)).toEqual({ x: 0, y: -5, z: 0 });   // named itself
    expect(by.get(m.p2)).toEqual({ x: 0, y: -60, z: 0 });
    expect(by.has(m.plate)).toBe(false);
    expect(by.has(m.h)).toBe(false);
  });

  it("slides each posed frame along its offset, k of the way, keeping its turn", async () => {
    const m = await holder();
    const turned = { ...rotation({ x: 0, y: 1, z: 0 }, Math.PI / 2), origin: { x: 5, y: 0, z: 0 } };
    const world = new Map([[m.rack, turned], [m.plate, IDENTITY]]);
    const by = explodeOffsets(m.s.doc, { Rack: [0, -20, 10] });
    expect(exploded(world, by, 0)).toBe(world);
    const half = exploded(world, by, 0.5);
    expect(half.get(m.rack)!.origin).toEqual({ x: 5, y: -10, z: 5 });
    expect(half.get(m.rack)!.x).toEqual(turned.x);
    expect(half.get(m.plate)).toBe(IDENTITY);
    expect(world.get(m.rack)).toBe(turned); // the pose itself is left alone
  });
});
