import assert from "node:assert/strict";
import test from "node:test";

import {
  operationLockPlatformPackage
} from "../../../src/native/operation-lock-helper.js";

test("operation-lock platform package selection matches the v0 release matrix", () => {
  assert.deepEqual(
    operationLockPlatformPackage("linux", "x64", "glibc"),
    {
      packageName: "skiloom-lock-linux-x64-gnu",
      executablePath: "bin/skiloom-lock"
    }
  );
  assert.deepEqual(
    operationLockPlatformPackage("darwin", "x64", null),
    {
      packageName: "skiloom-lock-darwin-x64",
      executablePath: "bin/skiloom-lock"
    }
  );
  assert.deepEqual(
    operationLockPlatformPackage("darwin", "arm64", null),
    {
      packageName: "skiloom-lock-darwin-arm64",
      executablePath: "bin/skiloom-lock"
    }
  );
  assert.deepEqual(
    operationLockPlatformPackage("win32", "x64", null),
    {
      packageName: "skiloom-lock-win32-x64",
      executablePath: "bin/skiloom-lock.exe"
    }
  );
});

test("operation-lock platform package selection stays fail-closed outside the v0 matrix", () => {
  assert.equal(
    operationLockPlatformPackage("linux", "arm64", "glibc"),
    undefined
  );
  assert.equal(
    operationLockPlatformPackage("linux", "x64", "musl"),
    undefined
  );
  assert.equal(
    operationLockPlatformPackage("win32", "arm64", null),
    undefined
  );
  assert.equal(
    operationLockPlatformPackage("freebsd", "x64", null),
    undefined
  );
});
