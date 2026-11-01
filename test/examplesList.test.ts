// The examples the app lists (src/model/examples.ts) are the files it ships.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXAMPLES, customizeLink, editorLink, exampleTitle } from "../src/model/examples";

const dir = "../public/examples/";
describe("the examples list", () => {
  it("names every file in public/examples once, and nothing else", () => {
    const files = readdirSync(fileURLToPath(new URL(dir, import.meta.url))).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
    expect(EXAMPLES.map((e) => e.name).sort()).toEqual(files);
    for (const e of EXAMPLES) { expect(e.title).toBeTruthy(); expect(e.blurb).toBeTruthy(); }
  });
  it("links into the viewer and the editor", () => {
    expect(customizeLink("roubo")).toBe("?customize&example=roubo");
    expect(editorLink("roubo")).toBe("?example=roubo");
    expect(exampleTitle("roubo")).toBe("Roubo workbench");
  });
});
