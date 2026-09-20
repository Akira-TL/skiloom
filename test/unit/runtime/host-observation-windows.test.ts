import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";

import {
  resolveNpmProbeCommands
} from "../../../src/runtime/host-observation/npm.js";

test("Windows npm probe resolves npm.cmd to npm-cli.js under the current Node executable", async () => {
  const nodeRoot = "C:\\Program Files\\nodejs";
  const execPath = win32.join(nodeRoot, "node.exe");
  const shim = win32.join(nodeRoot, "npm.cmd");
  const cli = win32.join(
    nodeRoot,
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  const existing = new Set([shim, cli]);

  const commands = await resolveNpmProbeCommands({
    platform: "win32",
    execPath,
    environment: {
      Path: nodeRoot,
      PATHEXT: ".COM;.EXE;.BAT;.CMD"
    },
    fileExists: async (path) => existing.has(path)
  });

  assert.deepEqual(commands, [
    {
      executable: execPath,
      args: [cli, "--version"],
      location: shim
    }
  ]);
});

test("Windows npm probe prefers a real npm.exe but keeps shell-free npm-cli fallback", async () => {
  const nodeRoot = "C:\\Node";
  const execPath = win32.join(nodeRoot, "node.exe");
  const executable = win32.join(nodeRoot, "npm.exe");
  const shim = win32.join(nodeRoot, "npm.cmd");
  const cli = win32.join(
    nodeRoot,
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  const existing = new Set([executable, shim, cli]);

  const commands = await resolveNpmProbeCommands({
    platform: "win32",
    execPath,
    environment: { PATH: nodeRoot },
    fileExists: async (path) => existing.has(path)
  });

  assert.deepEqual(commands, [
    {
      executable,
      args: ["--version"],
      location: executable
    },
    {
      executable: execPath,
      args: [cli, "--version"],
      location: shim
    }
  ]);
});

test("non-Windows npm probe keeps direct shell-free npm execution", async () => {
  const commands = await resolveNpmProbeCommands({
    platform: "linux",
    execPath: "/usr/bin/node",
    environment: { PATH: "/usr/bin" },
    fileExists: async () => false
  });

  assert.deepEqual(commands, [
    {
      executable: "npm",
      args: ["--version"],
      location: "npm"
    }
  ]);
});
