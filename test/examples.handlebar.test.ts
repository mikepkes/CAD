// The handlebar example's checks (test/exampleSuite.ts) in a test file of its
// own, so they run beside the other examples rather than after them: every
// slider end is a collision check between freeform B-spline bodies (a bar, two
// winged grips) fitted to 0.1 mm, which takes minutes, not seconds.
import { defineExampleSuite } from "./exampleSuite";

defineExampleSuite((name) => name === "public/examples/handlebar.json");
