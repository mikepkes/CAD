// Layout rules that only CSS can keep (jsdom has no layout): the toolbar is one
// row of a fixed height, and the shortcuts dialog keeps one height across its
// Keys and Ring tabs. Read from the stylesheet so a change that breaks them fails here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
/** Every declaration block for a selector (exactly as written), joined. */
const rules = (selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(^|\\n|,)\\s*${esc}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[2]).join(";");
};

describe("layout rules", () => {
  it("the toolbar is one row 52 px high: it never wraps and moves the view", () => {
    const t = rules(".toolbar");
    expect(t).toMatch(/height:\s*52px/);
    expect(t).toMatch(/flex-wrap:\s*nowrap/);
  });
  it("the side panels' collapse buttons sit in the first header row, which keeps room for them (no more 'OWSER')", () => {
    expect(rules(".side-toggle.open")).toMatch(/height:\s*24px/);
    expect(rules(".side.left > .panel:first-child > .panel-head")).toMatch(/padding-left:\s*36px/);
    expect(css).toMatch(/\.side\.right > \.k-tabs,[\s\S]*?padding-right:\s*36px/);
  });
  it("the Agent drawer opens under the panel switches, which stay reachable", () => {
    expect(rules(".agent-panel")).toMatch(/top:\s*52px/);
  });
  it("the shortcuts dialog has one body height for Keys and Ring", () => {
    expect(rules(".hk-modal .modal-body")).toMatch(/(^|;|\s)height:\s*min\(/);
  });
});
