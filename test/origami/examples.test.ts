// The paper examples (experimental: see test/origami/README.md), with the same checks as every other bundled
// example (test/exampleSuite.ts). Run by `npm run test:origami`, not by `npm test`.
import { defineExampleSuite, PAPER } from "../exampleSuite";

defineExampleSuite((name) => PAPER.includes(name));
