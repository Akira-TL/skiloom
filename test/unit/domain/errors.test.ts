import assert from "node:assert/strict";
import test from "node:test";

import { productError } from "../../../src/domain/errors/index.js";

test("product errors are plain structured values", () => {
  const error = productError("ExampleError", {
    subject: "owner/repo"
  });

  assert.deepEqual(error, {
    code: "ExampleError",
    facts: {
      subject: "owner/repo"
    }
  });
  assert.equal("message" in error, false);
});
