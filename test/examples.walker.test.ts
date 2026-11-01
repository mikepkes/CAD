// The walker example's checks (test/exampleSuite.ts) in a test file of its own:
// twelve legs of eleven bars each are 130-odd bodies, and the collision sweep
// through a full crank turn checks every pair of them at every sample.
import { defineExampleSuite } from "./exampleSuite";

defineExampleSuite((name) => name === "public/examples/walker.json");
