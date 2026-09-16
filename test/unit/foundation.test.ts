import assert from "node:assert/strict";
import test from "node:test";

import "../../src/index.js";

test("unit harness executes compiled ESM", () => {
  assert.match(import.meta.url, /^file:/u);
});
