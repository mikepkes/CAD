// Every hotkey action the app registers (global, model, sketch, the focus
// contexts, the intent line) resolves to a real icon, as does every action the
// shipped rings hold; and <Icon/> draws what the data says.

import { describe, it, expect, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { hotkeys } from "../../src/model/hotkeys";
import { installHotkeys } from "../../src/model/hotkeyActions";
import { installContextActions } from "../../src/ui/concepts/contextActions";
import { DEFAULT_RING } from "../../src/model/ring";
import { IntentLine } from "../../src/ui/concepts/intent";
import { OPEN_ACTION_ID } from "../../src/ui/concepts/intent/IntentLine";
import { Icon, iconForAction, FALLBACK_ICON, ICONS, isIconName } from "../../src/ui/icons";
import { suggestionIcon } from "../../src/ui/concepts/intent/suggestionIcon";

/** Hotkey actions that may show the fallback icon. Empty: every action has its own.
 *  Add an id here (with a comment saying why) only for an action with nothing to draw. */
const ACTION_EXCEPTIONS: string[] = [];

let ids: string[] = [];

beforeAll(() => {
  installHotkeys();
  installContextActions();
  render(<IntentLine />); // registers intent.open
  ids = hotkeys.describe().contexts.flatMap((c) => c.actions.map((a) => a.id));
});

describe("action icons", () => {
  it("gives every registered hotkey action its own icon", () => {
    expect(ids.length).toBeGreaterThan(60);
    expect(ids).toContain(OPEN_ACTION_ID);
    const missing = ids.filter((id) => !ACTION_EXCEPTIONS.includes(id) && iconForAction(id) === FALLBACK_ICON);
    expect(missing).toEqual([]);
    for (const id of ids) expect(isIconName(iconForAction(id)), id).toBe(true);
  });

  it("lists only real actions as exceptions", () => {
    for (const id of ACTION_EXCEPTIONS) expect(ids, id).toContain(id);
  });

  it("gives every action in the shipped rings an icon", () => {
    const ringIds = Object.values(DEFAULT_RING).flat().filter((x): x is string => !!x);
    for (const id of ringIds) expect(iconForAction(id), id).not.toBe(FALLBACK_ICON);
  });

  it("picks an intent-line suggestion's icon from what it runs", () => {
    const rows = [{ opId: "op1", featureId: "f1", op: { type: "feature.fillet", params: {} } }];
    expect(suggestionIcon({ type: "openFeature", featureId: "f1" }, rows, 3)).toBe("fillet");
    expect(suggestionIcon({ type: "editOperation", opId: "op1", params: {} }, rows, 3)).toBe("fillet");
    expect(suggestionIcon({ type: "view", view: "top" }, rows, 3)).toBe("view-top");
    expect(suggestionIcon({ type: "rollback", index: 3 }, rows, 3)).toBe("history-end");
    expect(suggestionIcon({ type: "rollback", index: 1 }, rows, 3)).toBe("roll-to");
    expect(suggestionIcon({ type: "hotkey", id: "edit.undo" }, rows, 3)).toBe("undo");
    expect(suggestionIcon({ type: "togglePanel", panel: "materials" }, rows, 3)).toBe("material");
  });
});

describe("<Icon/>", () => {
  it("draws the glyph's paths and dots in currentColor, decorative by default", () => {
    const { container } = render(<Icon name="line" size={24} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector("path")!.getAttribute("d")).toBe(ICONS.line.d);
    expect(svg.querySelectorAll("circle")).toHaveLength(ICONS.line.dots.length);
    expect(svg.textContent).toBe("");
  });

  it("masks the base under a variant's badge, with a mask id unique per instance", () => {
    const { container } = render(<><Icon name="parameter-add" /><Icon name="parameter-add" /></>);
    const masks = [...container.querySelectorAll("mask")];
    expect(masks).toHaveLength(2);
    expect(masks[0].id).not.toBe(masks[1].id);
    const g = container.querySelector("g[mask]")!;
    expect(g.getAttribute("mask")).toBe(`url(#${masks[0].id})`);
    expect(g.querySelector("path")!.getAttribute("d")).toBe(ICONS.parameter.d);
  });

  it("names itself when given a title, and draws the fallback for an unknown name", () => {
    const { container } = render(<Icon name="no-such-icon" title="Something" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Something");
    expect(svg.querySelector("path")!.getAttribute("d")).toBe(ICONS[FALLBACK_ICON].d);
  });
});
