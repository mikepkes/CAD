// Every bundled example is a regression test: see test/exampleSuite.ts for what
// each must do. The ones in OWN_KERNEL run in test files of their own.
import { defineExampleSuite, OWN_KERNEL } from "./exampleSuite";

defineExampleSuite((name) => !OWN_KERNEL.includes(name));
