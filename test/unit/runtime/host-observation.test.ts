import assert from "node:assert/strict";
import test from "node:test";

import {
  probeHostSoftware,
  type HostProbeExecutor
} from "../../../src/runtime/host-observation/index.js";

test("built-in software probes use fixed executable and argv", async () => {
  const calls: Array<Readonly<{
    executable: string;
    args: ReadonlyArray<string>;
  }>> = [];
  const execute: HostProbeExecutor = async (request) => {
    calls.push({
      executable: request.executable,
      args: request.args
    });
    return {
      kind: "exited",
      code: 0,
      stdout: "git version 2.45.1\n",
      stderr: ""
    };
  };

  const observed = await probeHostSoftware({
    name: "git",
    requirement: ">=2.40",
    execute
  });

  assert.equal(observed.status, "satisfied");
  assert.equal(observed.detectedVersion, "2.45.1");
  assert.deepEqual(calls, [
    {
      executable: "git",
      args: ["--version"]
    }
  ]);
});

test("unsupported software IDs never execute package-selected commands", async () => {
  let called = false;
  const execute: HostProbeExecutor = async () => {
    called = true;
    throw new Error("must not execute");
  };

  const observed = await probeHostSoftware({
    name: "curl",
    requirement: ">=8",
    execute
  });

  assert.equal(called, false);
  assert.equal(observed.status, "unknown");
  assert.equal(
    observed.diagnostic?.code,
    "UnsupportedHostSoftwareProbe"
  );
});

test("invalid host requirements degrade observation without invalidating the package", async () => {
  let called = false;
  const execute: HostProbeExecutor = async () => {
    called = true;
    throw new Error("must not execute");
  };

  const observed = await probeHostSoftware({
    name: "git",
    requirement: "^2.40",
    execute
  });

  assert.equal(called, false);
  assert.equal(observed.status, "unknown");
  assert.equal(
    observed.diagnostic?.code,
    "InvalidHostSoftwareRequirement"
  );
});
