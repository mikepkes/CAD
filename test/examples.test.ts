// Every bundled example is a regression test: see test/exampleSuite.ts for what
// each must do. They're split over three files (this, examples.b and
// examples.c) by a hash of the name, to run in parallel; the ones in OWN_KERNEL
// run in test files of their own.
import { defineExampleSuite, OWN_KERNEL, shardOf } from "./exampleSuite";

defineExampleSuite((name) => !OWN_KERNEL.includes(name) && shardOf(name, 3) === 0);
