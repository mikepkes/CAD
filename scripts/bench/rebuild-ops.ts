// Where replaying an example's operation log (core/build.ts rebuild) spends its time, by
// operation type: count, total ms, and the slowest single operations.
//
//   npx vite-node scripts/bench/rebuild-ops.ts public/examples/walker.json
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createDefaultRegistry } from "../../src/core/command/builtins";
import { deserializeDocument } from "../../src/core/persistence";
import { rebuild } from "../../src/core/build";
import type { CommandContext, OperationRecord } from "../../src/core/command/types";

const file = process.argv[2];
if (!file) { console.error("usage: vite-node scripts/bench/rebuild-ops.ts <example.json>"); process.exit(2); }
const registry = createDefaultRegistry();
const doc = deserializeDocument(readFileSync(file, "utf8"));
rebuild(doc, registry); // warm

// time each apply by wrapping the registry's definitions
const byType: Record<string, { n: number; ms: number }> = {};
const slowest: { op: string; type: string; ms: number }[] = [];
for (const type of registry.list().map((d) => d.type)) {
  const def = registry.get(type)!;
  const apply = def.apply;
  (def as { apply: typeof apply }).apply = (d, params, ctx: CommandContext) => {
    const t = performance.now();
    try { return apply(d, params, ctx); } finally {
      const dt = performance.now() - t;
      (byType[type] ??= { n: 0, ms: 0 }).n++; byType[type].ms += dt;
      slowest.push({ op: (ctx as unknown as { op?: OperationRecord }).op?.opId ?? "", type, ms: dt });
    }
  };
}
const t = performance.now();
rebuild(doc, registry);
const total = performance.now() - t;
const rows = Object.entries(byType).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k}: ${v.n} ops, ${v.ms.toFixed(1)} ms (${(v.ms / v.n).toFixed(2)} ms each)`);
console.log(`rebuild ${total.toFixed(1)} ms, ${doc.operations.length} operations, ${Object.keys(doc.sketches).length} sketches, ${Object.keys(doc.features).length} features`);
console.log(rows.join("\n"));
console.log("slowest:", slowest.sort((a, b) => b.ms - a.ms).slice(0, 8).map((s) => `${s.type} ${s.ms.toFixed(1)}`).join(", "));
