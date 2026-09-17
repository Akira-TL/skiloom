import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  acquireOperationLock,
  parseOperationLockHandshake
} from "../../../src/native/skiloom-lock.js";

test("operation-lock handshake parser accepts only exact protocol lines", () => {
  assert.equal(parseOperationLockHandshake("SKILOOM-LOCK-V1 ACQUIRED\n"), "acquired");
  assert.equal(parseOperationLockHandshake("SKILOOM-LOCK-V1 CONTENDED\n"), "contended");
  assert.equal(parseOperationLockHandshake("SKILOOM-LOCK-V1 UNSUPPORTED\n"), "unsupported");

  assert.equal(parseOperationLockHandshake("SKILOOM-LOCK-V1 ACQUIRED"), undefined);
  assert.equal(parseOperationLockHandshake("SKILOOM-LOCK-V1 ACQUIRED\nextra"), undefined);
  assert.equal(parseOperationLockHandshake("SKILOOM-LOCK-V2 ACQUIRED\n"), undefined);
});

test("operation-lock bridge rejects implicit helper and lock paths before spawn", async () => {
  const helperPath = await acquireOperationLock({
    helperExecutable: "skiloom-lock",
    lockPath: resolve(tmpdir(), "operation.lock")
  });
  assert.deepEqual(helperPath, {
    ok: false,
    error: {
      code: "OperationLockHelperFailure",
      facts: { reason: "invalid-helper-path" }
    }
  });

  const lockPath = await acquireOperationLock({
    helperExecutable: resolve(tmpdir(), "skiloom-lock"),
    lockPath: "operation.lock"
  });
  assert.deepEqual(lockPath, {
    ok: false,
    error: {
      code: "OperationLockHelperFailure",
      facts: { reason: "invalid-lock-path" }
    }
  });
});
