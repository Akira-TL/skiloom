import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { resolveSkiloomHomePaths } from "../../../src/runtime/home.js";
import { openMachineRegistry as openRawMachineRegistry } from "../../../src/runtime/registry/database.js";
import { writeTargetStateMarkerFile } from "../../../src/runtime/target-state-marker.js";
import { targetStateMarkerFactsFromRegistryState } from "../../../src/runtime/target-state-recovery.js";

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");

test("status defaults to cwd .agents/skills without creating Target or Registry", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skiloom-cli-status-default-"));
  const home = join(temp, "home");
  const cwd = join(temp, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  const target = join(cwd, ".agents", "skills");

  try {
    const result = await runCli(["status", "--json"], { cwd, home });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: "SKILOOM-CLI-V1",
      ok: true,
      command: "status",
      result: {
        target: {
          path: target,
          source: "default",
          host: null,
          scope: "workspace"
        },
        marker: null,
        registry: null
      },
      warnings: []
    });
    await assert.rejects(stat(target));
    await assert.rejects(stat(join(home, ".skiloom")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Target selectors map explicit, host workspace, and host user paths without Git-root discovery", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skiloom-cli-status-selectors-"));
  const home = join(temp, "home");
  const parent = join(temp, "parent");
  const cwd = join(parent, "child");
  await mkdir(home);
  await mkdir(cwd, { recursive: true });
  await writeFile(join(parent, ".git"), "not a real repo; must be ignored\n");

  try {
    const explicit = join(temp, "custom-target");
    assert.equal(
      statusTarget(await runCli(
        ["status", "--target", explicit, "--json"],
        { cwd, home }
      )),
      explicit
    );

    for (const host of ["codex", "gemini", "opencode"]) {
      assert.equal(
        statusTarget(await runCli(
          ["status", "--host", host, "--json"],
          { cwd, home }
        )),
        join(cwd, ".agents", "skills")
      );
      assert.equal(
        statusTarget(await runCli(
          ["status", "--host", host, "--scope", "user", "--json"],
          { cwd, home }
        )),
        join(home, ".agents", "skills")
      );
    }

    assert.equal(
      statusTarget(await runCli(
        ["status", "--host", "claude", "--json"],
        { cwd, home }
      )),
      join(cwd, ".claude", "skills")
    );
    assert.equal(
      statusTarget(await runCli(
        ["status", "--host", "claude", "--scope", "user", "--json"],
        { cwd, home }
      )),
      join(home, ".claude", "skills")
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("status reads existing marker and Registry summary without mutating either", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skiloom-cli-status-known-"));
  const home = join(temp, "home");
  const target = join(temp, "target");
  await mkdir(home);
  await mkdir(target);
  const paths = resolveSkiloomHomePaths(home);
  const opened = openRawMachineRegistry(paths);
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    return;
  }

  const targetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const replaced = opened.value.replaceTargetState({
    targetId,
    locations: [
      {
        path: target,
        observedGeneration: 1
      }
    ],
    directRequirements: [],
    resolvedSources: [],
    resolvedPackages: [],
    dependencyEdges: [],
    projections: [],
    detachedBaselines: [],
    dependencyObservations: []
  });
  assert.equal(replaced.ok, true);
  if (!replaced.ok) {
    opened.value.close();
    return;
  }
  opened.value.close();

  const marker = targetStateMarkerFactsFromRegistryState(replaced.value);
  assert.equal(marker.ok, true);
  if (!marker.ok) {
    return;
  }
  assert.deepEqual(
    await writeTargetStateMarkerFile(target, marker.value),
    { ok: true, value: undefined }
  );

  const registryBefore = await readFile(paths.registryPath);
  const markerBefore = await readFile(join(target, ".skiloom-state"));

  try {
    const result = await runCli(
      ["status", "--target", target, "--json"],
      { home }
    );

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout) as {
      result: {
        marker: { targetId: string; generation: number };
        registry: {
          targetId: string;
          generation: number;
          directRequirements: number;
          sources: number;
          packages: number;
          dependencyEdges: number;
          projections: number;
          detached: number;
          dependencyObservations: number;
          pendingOperations: number;
        };
      };
    };
    assert.equal(output.result.marker.targetId, targetId);
    assert.equal(output.result.marker.generation, 1);
    assert.deepEqual(output.result.registry, {
      targetId,
      generation: 1,
      directRequirements: 0,
      sources: 0,
      packages: 0,
      dependencyEdges: 0,
      projections: 0,
      detached: 0,
      dependencyObservations: 0,
      pendingOperations: 0
    });
    assert.deepEqual(await readFile(paths.registryPath), registryBefore);
    assert.deepEqual(
      await readFile(join(target, ".skiloom-state")),
      markerBefore
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("status human output is deterministic for an unregistered Target", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skiloom-cli-status-human-"));
  const home = join(temp, "home");
  const cwd = join(temp, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  const target = join(cwd, ".agents", "skills");

  try {
    const result = await runCli(["status"], { cwd, home });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      [
        "Target: " + target,
        "Registry: unregistered",
        "Marker: absent",
        ""
      ].join("\n")
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Target selector conflicts and invalid host/scope are usage errors", async () => {
  const cases = [
    ["status", "--target", "/tmp/example", "--host", "codex", "--json"],
    ["status", "--target", "/tmp/example", "--scope", "user", "--json"],
    ["status", "--host", "unknown", "--json"],
    ["status", "--scope", "other", "--json"]
  ];

  for (const args of cases) {
    const result = await runCli(args);
    assert.equal(result.code, 2);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      error: { code: string };
    };
    assert.equal(output.ok, false);
    assert.equal(output.command, "status");
    assert.equal(output.error.code, "InvalidArguments");
  }
});

function statusTarget(result: Awaited<ReturnType<typeof runCli>>): string {
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout) as {
    result: { target: { path: string } };
  };
  return output.result.target.path;
}

function runCli(
  args: ReadonlyArray<string>,
  options?: Readonly<{ cwd?: string; home?: string }>
): Promise<Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: options?.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(options?.home === undefined
          ? {}
          : { HOME: options.home, USERPROFILE: options.home })
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
}
