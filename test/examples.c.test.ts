// A third of the bundled examples' checks (test/exampleSuite.ts): see test/examples.test.ts.
import { defineExampleSuite, OWN_KERNEL, PAPER, shardOf } from "./exampleSuite";

defineExampleSuite((name) => !OWN_KERNEL.includes(name) && !PAPER.includes(name) && shardOf(name, 3) === 2);
