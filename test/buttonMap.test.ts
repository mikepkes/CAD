import { describe, it, expect } from "vitest";
import { buttonMapOf, settingsOf, resolveButton, inheritedButton, setButton, overridesButtons, buttonRows } from "../src/model/buttonMap";

const settings = { buttons: { 0: "view.frame", 1: "view.iso" }, contextButtons: { face: { 0: "face.lookAt", 1: "" }, sketch: { 0: "sketch.finish" } } };
const faceStack = ["global", "model", "face"] as const;

describe("3D-mouse buttons per context", () => {
  it("reads the settings as one map and writes it back", () => {
    const m = buttonMapOf(settings);
    expect(m.global).toEqual({ 0: "view.frame", 1: "view.iso" });
    expect(m.face).toEqual({ 0: "face.lookAt", 1: "" });
    expect(settingsOf(m)).toEqual(settings);
    expect(buttonMapOf({ buttons: { 0: "view.top" } })).toEqual({ global: { 0: "view.top" } }); // settings saved before contexts existed
  });

  it("resolves a press top-down: override, explicit nothing, inherit", () => {
    const m = buttonMapOf(settings);
    expect(resolveButton(0, [...faceStack], m)).toEqual({ actionId: "face.lookAt", from: "face" });
    expect(resolveButton(1, [...faceStack], m)).toEqual({ actionId: null, from: "face" }); // "" stops inheritance
    expect(resolveButton(0, ["global", "model"], m)).toEqual({ actionId: "view.frame", from: "global" });
    expect(resolveButton(0, ["global", "sketch"], m)).toEqual({ actionId: "sketch.finish", from: "sketch" });
    expect(resolveButton(5, [...faceStack], m)).toEqual({ actionId: null, from: null });
  });

  it("falls through to the context below when the action can't run now", () => {
    const m = buttonMapOf(settings);
    expect(resolveButton(0, [...faceStack], m, (id) => id !== "face.lookAt")).toEqual({ actionId: "view.frame", from: "global" });
  });

  it("says what a context inherits, and sets / clears / blanks a button", () => {
    let m = buttonMapOf(settings);
    expect(inheritedButton(0, "face", m)).toEqual({ actionId: "view.frame", from: "global" });
    m = setButton(m, "lens", 2, "lens.xray");
    expect(m.lens).toEqual({ 2: "lens.xray" });
    expect(overridesButtons("lens", m)).toBe(true);
    m = setButton(m, "lens", 2, null);
    expect(m.lens).toBeUndefined();
    expect(overridesButtons("lens", m)).toBe(false);
    m = setButton(m, "global", 1, "");
    expect(m.global).toEqual({ 0: "view.frame" });
    m = setButton(m, "model", 0, "");
    expect(resolveButton(0, ["global", "model"], m)).toEqual({ actionId: null, from: "model" });
  });

  it("shows rows for every configured or pressed button, at least two", () => {
    expect(buttonRows({ global: {} }, [])).toBe(2);
    expect(buttonRows(buttonMapOf(settings), [])).toBe(2);
    expect(buttonRows({ global: {}, face: { 5: "x" } }, [])).toBe(6);
    expect(buttonRows({ global: {} }, [11], 1)).toBe(13);
  });
});
