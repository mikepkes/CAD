// The SKÅDIS holder example's checks (test/exampleSuite.ts) in a kernel of its own:
// its rack, four pinion and arm pairs and slotted board run more booleans than
// it can share with the other examples.
import { defineExampleSuite } from "./exampleSuite";

defineExampleSuite((name) => name === "public/examples/skadis.json");
