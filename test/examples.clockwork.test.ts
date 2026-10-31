// The clockwork example's checks (test/exampleSuite.ts) in a kernel of its own:
// its collision sweep runs a hundred gear-pair booleans, more memory than it can
// share with the other examples.
import { defineExampleSuite } from "./exampleSuite";

defineExampleSuite((name) => name === "public/examples/clockwork.json");
