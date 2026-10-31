// The tutorial video's mock agent caches (video/mock/agent-*.json) replay real tool calls on camera: each must
// still be a valid command sequence that builds, or the take shows errors.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSession } from "./helpers";
import { initKernel } from "../src/core/occ/kernel";
import { evaluateFeatures } from "../src/core/features";
import { resolveParameters } from "../src/core/parameters";

const wasm = readFileSync(fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url)));
beforeAll(async () => { await initKernel({ wasmBinary: wasm }); }, 60000);

const dir = fileURLToPath(new URL("../video/mock/", import.meta.url));
const caches = readdirSync(dir).filter((f) => /^agent-.*\.json$/.test(f));

describe("video mock agent caches", () => {
  it("has at least one", () => expect(caches.length).toBeGreaterThan(0));
  for (const f of caches) {
    it(`${f}: every tool call runs and builds a body`, async () => {
      const cache = JSON.parse(readFileSync(dir + f, "utf8"));
      const s = realSession();
      for (const turn of cache.turns) {
        for (const b of turn.content) {
          if (b.type !== "tool_use") continue;
          const r = await s.dispatch(b.name.replace(/__/g, "."), b.input);
          expect(r.ok, `${f} ${b.id} ${b.name}: ${r.error}`).toBe(true);
        }
      }
      expect(cache.turns.at(-1).stop_reason).toBe("end_turn");
      const bodies = Object.values(evaluateFeatures(s.doc, resolveParameters(s.doc.parameters).scope)).filter((b) => b.mesh);
      expect(bodies.length).toBeGreaterThan(0);
    });
  }
});
