// A third of the bundled examples' checks (test/exampleSuite.ts): see test/examples.test.ts.
import { defineExampleSuite, OWN_KERNEL, shardOf } from "./exampleSuite";

defineExampleSuite((name) => !OWN_KERNEL.includes(name) && shardOf(name, 3) === 1);
