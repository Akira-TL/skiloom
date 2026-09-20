import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename as renamePath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  readTargetStateMarkerFile
} from "../../../src/runtime/target-state-marker.js";

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve("native/skiloom-lock/target/debug/skiloom-lock");

type ParsedLocalOutput = Readonly<{
  ok: boolean;
  error?: Readonly<{
    code: string;
    facts: Readonly<Record<string, unknown>>;
  }>;
  result: Readonly<{
    status: string;
    targetId: string;
    generation: number;
    packageCoordinate: string;
    projections: ReadonlyArray<Readonly<{
      packageCoordinate: string;
      activationName: string;
      ownership: string;
    }>>;
    detached: ReadonlyArray<Readonly<{
      packageCoordinate: string;
    }>>;
  }>;
}>;

test("rename updates managed projection intent DB-first and writes marker generation without --yes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(installed.code, 0);

    const renamed = await runCli(
      [
        "rename",
        "acme/app/app",
        "app-local",
        "--json"
      ],
      { home, cwd }
    );

    assert.equal(renamed.code, 0);
    assertNoUnexpectedStderr(renamed.stderr);
    const output = parseLocalOutput(renamed.stdout);
    assert.equal(output.result.status, "renamed");
    assert.equal(output.result.generation, 2);
    assert.deepEqual(output.result.projections, [
      {
        packageCoordinate: "acme/app/app",
        activationName: "app-local",
        ownership: "managed"
      }
    ]);
    assert.equal(existsSync(join(target, "app")), false);
    assert.equal(existsSync(join(target, "app-local")), true);
    assert.match(
      await readFile(
        join(target, "app-local", "SKILL.md"),
        "utf8"
      ),
      /name: app-local/u
    );

    const marker = await readTargetStateMarkerFile(target);
    assert.equal(marker.ok, true);
    if (marker.ok) {
      assert.equal(marker.value?.generation, 2);
      assert.deepEqual(marker.value?.projectionOverrides, [
        {
          packageCoordinate: "acme/app/app",
          activationName: "app-local"
        }
      ]);
      assert.equal(marker.value?.managed.length, 1);
      assert.deepEqual(
        marker.value?.managed.map((entry) => ({
          packageCoordinate: entry.packageCoordinate,
          activationName: entry.activationName,
          materialization: entry.materialization,
          packageRoot: entry.packageRoot,
          hasTransform: entry.transformJson !== null
        })),
        [
          {
            packageCoordinate: "acme/app/app",
            activationName: "app-local",
            materialization: "copy",
            packageRoot: ".",
            hasTransform: true
          }
        ]
      );
      assert.deepEqual(marker.value?.detached, []);
    }
  });
});

test("rename rejects activation collisions without auto-suffixing or target mutation", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const app = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(app.code, 0);
    const tool = await runCli(
      ["install", "acme/tool/tool", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(tool.code, 0);

    const renamed = await runCli(
      ["rename", "acme/app/app", "tool", "--json"],
      { home, cwd }
    );

    assert.equal(renamed.code, 1);
    const output = parseLocalOutput(renamed.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error?.code, "ActivationNameConflict");
    assert.equal(existsSync(join(target, "app")), true);
    assert.equal(existsSync(join(target, "tool")), true);
    assert.equal(existsSync(join(target, "tool-2")), false);
  });
});

test("rename fails closed on a foreign destination path and preserves its bytes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(installed.code, 0);
    await mkdir(join(target, "app-local"));
    await writeFile(
      join(target, "app-local", "KEEP"),
      "foreign rename bytes\n"
    );

    const renamed = await runCli(
      [
        "rename",
        "acme/app/app",
        "app-local",
        "--json"
      ],
      { home, cwd }
    );

    assert.equal(renamed.code, 1);
    const output = parseLocalOutput(renamed.stdout);
    assert.equal(output.ok, false);
    assert.equal(
      output.error?.code,
      "ForeignTargetPathConflict"
    );
    assert.equal(
      await readFile(
        join(target, "app-local", "KEEP"),
        "utf8"
      ),
      "foreign rename bytes\n"
    );
    assert.equal(existsSync(join(target, "app")), true);
  });
});

test("rebind requires a broken detached binding and forget rejects managed ownership", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(installed.code, 0);

    const managedForget = await runCli(
      ["forget", "acme/app/app", "--json"],
      { home, cwd }
    );
    assert.equal(managedForget.code, 1);
    const forgetOutput = parseLocalOutput(
      managedForget.stdout
    );
    assert.equal(
      forgetOutput.error?.code,
      "InvalidDetachedBindingInput"
    );
    assert.equal(
      forgetOutput.error?.facts.reason,
      "projection-not-detached"
    );

    const detached = await runCli(
      ["detach", "acme/app/app", "--json"],
      { home, cwd }
    );
    assert.equal(detached.code, 0);
    await mkdir(join(target, "app-moved"));

    const rebound = await runCli(
      [
        "rebind",
        "acme/app/app",
        "app-moved",
        "--json"
      ],
      { home, cwd }
    );
    assert.equal(rebound.code, 1);
    const rebindOutput = parseLocalOutput(rebound.stdout);
    assert.equal(
      rebindOutput.error?.code,
      "InvalidLocalLifecycleInput"
    );
    assert.equal(
      rebindOutput.error?.facts.reason,
      "binding-not-broken"
    );
    assert.equal(existsSync(join(target, "app")), true);
  });
});

test("explicit local operations reject ordinary candidate --yes flags", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    const cases = [
      ["rename", "acme/app/app", "app-local", "--yes", "--json"],
      ["detach", "acme/app/app", "--yes", "--json"],
      ["rebind", "acme/app/app", "app-local", "--yes", "--json"],
      ["forget", "acme/app/app", "--yes", "--json"]
    ];

    for (const args of cases) {
      const result = await runCli(args, { home, cwd });
      assert.equal(result.code, 2);
      const output = parseLocalOutput(result.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.error?.code, "InvalidArguments");
    }
  });
});

test("detach rebind and forget preserve user bytes while advancing DB-first marker generations", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(installed.code, 0);

    const detached = await runCli(
      ["detach", "acme/app/app", "--json"],
      { home, cwd }
    );
    assert.equal(detached.code, 0);
    const detachedOutput = parseLocalOutput(detached.stdout);
    assert.equal(detachedOutput.result.status, "detached");
    assert.equal(detachedOutput.result.generation, 2);
    assert.equal(
      detachedOutput.result.projections[0]?.ownership,
      "detached"
    );
    const detachedStat = await lstat(join(target, "app"));
    assert.equal(detachedStat.isDirectory(), true);
    assert.equal(detachedStat.isSymbolicLink(), false);

    const detachedMarker =
      await readTargetStateMarkerFile(target);
    assert.equal(detachedMarker.ok, true);
    if (detachedMarker.ok && detachedMarker.value !== null) {
      assert.deepEqual(detachedMarker.value.managed, []);
      assert.equal(
        detachedMarker.value.detached[0]?.packageCoordinate,
        "acme/app/app"
      );
    }

    await writeFile(
      join(target, "app", "USER-NOTE"),
      "keep detached bytes\n"
    );
    await renamePath(
      join(target, "app"),
      join(target, "app-moved")
    );

    const rebound = await runCli(
      [
        "rebind",
        "acme/app/app",
        "app-moved",
        "--json"
      ],
      { home, cwd }
    );
    assert.equal(rebound.code, 0);
    const reboundOutput = parseLocalOutput(rebound.stdout);
    assert.equal(reboundOutput.result.status, "rebound");
    assert.equal(reboundOutput.result.generation, 3);
    assert.deepEqual(reboundOutput.result.projections, [
      {
        packageCoordinate: "acme/app/app",
        activationName: "app-moved",
        ownership: "detached"
      }
    ]);
    assert.equal(
      await readFile(
        join(target, "app-moved", "USER-NOTE"),
        "utf8"
      ),
      "keep detached bytes\n"
    );

    const reboundMarker =
      await readTargetStateMarkerFile(target);
    assert.equal(reboundMarker.ok, true);
    if (reboundMarker.ok) {
      assert.equal(reboundMarker.value?.generation, 3);
      assert.deepEqual(
        reboundMarker.value?.projectionOverrides,
        [
          {
            packageCoordinate: "acme/app/app",
            activationName: "app-moved"
          }
        ]
      );
      assert.deepEqual(reboundMarker.value?.managed, []);
      assert.equal(
        reboundMarker.value?.detached[0]?.packageCoordinate,
        "acme/app/app"
      );
    }

    const forgotten = await runCli(
      ["forget", "acme/app/app", "--json"],
      { home, cwd }
    );
    assert.equal(forgotten.code, 0);
    const forgottenOutput = parseLocalOutput(
      forgotten.stdout
    );
    assert.equal(forgottenOutput.result.status, "forgotten");
    assert.equal(forgottenOutput.result.generation, 4);
    assert.deepEqual(forgottenOutput.result.projections, []);
    assert.deepEqual(forgottenOutput.result.detached, []);
    assert.equal(
      await readFile(
        join(target, "app-moved", "USER-NOTE"),
        "utf8"
      ),
      "keep detached bytes\n"
    );

    const forgottenMarker =
      await readTargetStateMarkerFile(target);
    assert.equal(forgottenMarker.ok, true);
    if (forgottenMarker.ok) {
      assert.equal(forgottenMarker.value?.generation, 4);
      assert.deepEqual(
        forgottenMarker.value?.projectionOverrides,
        []
      );
      assert.deepEqual(forgottenMarker.value?.managed, []);
      assert.deepEqual(forgottenMarker.value?.detached, []);
    }
  });
});

async function withCliRuntime(
  run: (input: Readonly<{
    home: string;
    cwd: string;
    target: string;
  }>) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(
    join(tmpdir(), "skiloom-cli-local-ops-")
  );
  const home = join(temp, "home");
  const cwd = join(temp, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  try {
    await run({
      home,
      cwd,
      target: join(cwd, ".agents", "skills")
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function runCli(
  args: ReadonlyArray<string>,
  options: Readonly<{
    home: string;
    cwd: string;
  }>
): Promise<Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", FETCH_PRELOAD, CLI_ENTRY, ...args],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          HOME: options.home,
          USERPROFILE: options.home,
          SKILOOM_LOCK_TEST_BINARY: LOCK_HELPER,
          SKILOOM_TEST_GITHUB_MODE: "base"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
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

function parseLocalOutput(source: string): ParsedLocalOutput {
  return JSON.parse(source) as ParsedLocalOutput;
}

function assertNoUnexpectedStderr(stderr: string): void {
  const normalized = stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u,
    ""
  );
  assert.equal(normalized, "");
}
