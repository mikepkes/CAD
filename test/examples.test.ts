// Every bundled example is a regression test: see test/exampleSuite.ts for what
// each must do. They're split over three files (this, examples.b and
// examples.c) by a hash of the name, to run in parallel; the ones in OWN_KERNEL
// run in test files of their own, and the paper ones (PAPER, experimental) only in
// the origami run (test/origami/examples.test.ts).
import { defineExampleSuite, OWN_KERNEL, PAPER, shardOf } from "./exampleSuite";

defineExampleSuite((name) => !OWN_KERNEL.includes(name) && !PAPER.includes(name) && shardOf(name, 3) === 0);
