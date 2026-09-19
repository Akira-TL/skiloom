import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  readTargetStateMarkerFile
} from "../../../../src/runtime/target-state-marker.js";

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve("native/skiloom-lock/target/debug/skiloom-lock");

type ParsedRecoveryOutput = Readonly<{
  ok: boolean;
  error?: Readonly<{
    code: string;
    facts: Readonly<Record<string, unknown>>;
  }>;
  result: Readonly<{
    status: string;
    targetId: string;
    generation: number | null;
    packages: ReadonlyArray<Readonly<{
      packageCoordinate: string;
    }>>;
    projections: ReadonlyArray<Readonly<{
      packageCoordinate: string;
      activationName: string;
      ownership: string;
    }>>;
  }>;
}>;

test("fork plans and commits a stale copied Target under a new identity without mutating the old authority", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    const originalMarker =
      await readTargetStateMarkerFile(target);
    assert.equal(originalMarker.ok, true);
    if (
      !originalMarker.ok ||
      originalMarker.value === null
    ) {
      return;
    }
    const originalTargetId =
      originalMarker.value.targetId;
    const copyTarget = join(cwd, "copied-target");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });

    const updated = await runCli(
      ["update", "--yes", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(updated.code, 0);

    const planned = await runCli(
      [
        "fork",
        "--target",
        copyTarget,
        "--plan",
        "--json"
      ],
      { home, cwd, mode: "base" }
    );
    assert.equal(planned.code, 0);
    const planOutput =
      parseRecoveryOutput(planned.stdout);
    assert.equal(planOutput.result.status, "planned");
    assert.equal(planOutput.result.generation, null);
    assert.notEqual(
      planOutput.result.targetId,
      originalTargetId
    );
    const markerAfterPlan =
      await readTargetStateMarkerFile(copyTarget);
    assert.equal(markerAfterPlan.ok, true);
    if (markerAfterPlan.ok) {
      assert.equal(
        markerAfterPlan.value?.targetId,
        originalTargetId
      );
      assert.equal(markerAfterPlan.value?.generation, 1);
    }

    const blocked = await runCli(
      ["fork", "--target", copyTarget, "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(blocked.code, 3);
    const blockedOutput =
      parseRecoveryOutput(blocked.stdout);
    assert.equal(
      blockedOutput.error?.code,
      "InteractionRequired"
    );

    const forked = await runCli(
      [
        "fork",
        "--target",
        copyTarget,
        "--yes",
        "--json"
      ],
      { home, cwd, mode: "base" }
    );
    assert.equal(forked.code, 0);
    assertNoUnexpectedStderr(forked.stderr);
    const output = parseRecoveryOutput(forked.stdout);
    assert.equal(output.result.status, "forked");
    assert.equal(output.result.generation, 1);
    assert.notEqual(output.result.targetId, originalTargetId);

    const forkMarker =
      await readTargetStateMarkerFile(copyTarget);
    assert.equal(forkMarker.ok, true);
    if (forkMarker.ok) {
      assert.equal(
        forkMarker.value?.targetId,
        output.result.targetId
      );
      assert.equal(forkMarker.value?.generation, 1);
    }
    assert.match(
      await readFile(
        join(copyTarget, "app", "SKILL.md"),
        "utf8"
      ),
      /Baseline application\./u
    );

    const originalStatus = await runCli(
      ["status", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(originalStatus.code, 0);
    const statusOutput =
      JSON.parse(originalStatus.stdout) as {
        result: {
          registry: {
            targetId: string;
            generation: number;
          };
        };
      };
    assert.equal(
      statusOutput.result.registry.targetId,
      originalTargetId
    );
    assert.equal(
      statusOutput.result.registry.generation,
      2
    );
  });
});

test("fork refuses a stale marker on a path still registered to the old Target identity", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    const staleMarker = await readFile(
      join(target, ".skiloom-state"),
      "utf8"
    );

    const updated = await runCli(
      ["update", "--yes", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(updated.code, 0);
    await writeFile(
      join(target, ".skiloom-state"),
      staleMarker,
      "utf8"
    );

    const forked = await runCli(
      ["fork", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );

    assert.equal(forked.code, 1);
    const output = parseRecoveryOutput(forked.stdout);
    assert.equal(
      output.error?.code,
      "RecoveryCandidateNotAllowed"
    );
    assert.equal(
      output.error?.facts.reason,
      "target-current"
    );

    const status = await runCli(
      ["status", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(status.code, 0);
    const statusOutput = JSON.parse(status.stdout) as {
      result: {
        registry: { generation: number };
      };
    };
    assert.equal(
      statusOutput.result.registry.generation,
      2
    );
  });
});

test("fork keeps release-retarget authorization independent from ordinary --yes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    const copyTarget = join(cwd, "retarget-copy");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });

    const updated = await runCli(
      [
        "update",
        "--yes",
        "--allow-release-retarget",
        "--json"
      ],
      { home, cwd, mode: "retarget" }
    );
    assert.equal(updated.code, 0);

    const blocked = await runCli(
      [
        "fork",
        "--target",
        copyTarget,
        "--yes",
        "--json"
      ],
      { home, cwd, mode: "base" }
    );

    assert.equal(blocked.code, 3);
    const blockedOutput =
      parseRecoveryOutput(blocked.stdout);
    assert.equal(
      blockedOutput.error?.code,
      "InteractionRequired"
    );
    assert.equal(
      blockedOutput.error?.facts.reason,
      "release-retarget-authorization-required"
    );

    const accepted = await runCli(
      [
        "fork",
        "--target",
        copyTarget,
        "--yes",
        "--allow-release-retarget",
        "--json"
      ],
      { home, cwd, mode: "base" }
    );

    assert.equal(accepted.code, 0);
    const output = parseRecoveryOutput(accepted.stdout);
    assert.equal(output.result.status, "forked");
    assert.equal(output.result.generation, 1);
    assert.match(
      await readFile(
        join(copyTarget, "app", "SKILL.md"),
        "utf8"
      ),
      /Baseline application\./u
    );
  });
});

test("recover rejects an invalid marker without inferring intent from Target bytes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    await deleteRegistry(home);
    await writeFile(
      join(target, ".skiloom-state"),
      "not = [valid",
      "utf8"
    );

    const recovered = await runCli(
      ["recover", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );

    assert.equal(recovered.code, 1);
    const output = parseRecoveryOutput(recovered.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error?.code, "InvalidTargetState");
    assert.equal(existsSync(join(target, "app")), true);
    assert.equal(
      existsSync(join(home, ".skiloom", "registry.sqlite3")),
      false
    );
  });
});

test("recover propagates source access failure instead of inferring source identity from live bytes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    await deleteRegistry(home);
    const markerPath = join(target, ".skiloom-state");
    const markerText = await readFile(markerPath, "utf8");
    await writeFile(
      markerPath,
      markerText.replace(
        'coordinate = "acme/app/app"',
        'coordinate = "missing/repo/pkg"'
      ),
      "utf8"
    );

    const recovered = await runCli(
      ["recover", "--plan", "--json"],
      { home, cwd, mode: "base" }
    );

    assert.equal(recovered.code, 1);
    const output = parseRecoveryOutput(recovered.stdout);
    assert.equal(output.ok, false);
    assert.equal(
      output.error?.code,
      "SourceAccessUnavailable"
    );
    assert.equal(existsSync(join(target, "app")), true);
    assert.equal(
      existsSync(join(home, ".skiloom", "registry.sqlite3")),
      false
    );
  });
});

test("recover --plan resolves and validates the marker candidate without recreating Registry", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    await deleteRegistry(home);

    const planned = await runCli(
      ["recover", "--plan", "--json"],
      { home, cwd, mode: "base" }
    );

    assert.equal(planned.code, 0);
    assertNoUnexpectedStderr(planned.stderr);
    const output = parseRecoveryOutput(planned.stdout);
    assert.equal(output.result.status, "planned");
    assert.equal(output.result.generation, null);
    assert.deepEqual(
      output.result.packages.map(
        (entry) => entry.packageCoordinate
      ),
      ["acme/app/app"]
    );
    assert.equal(
      existsSync(join(home, ".skiloom", "registry.sqlite3")),
      false
    );
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );
  });
});

test("recover without --yes returns approval-required without recreating Registry", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    await deleteRegistry(home);

    const blocked = await runCli(
      ["recover", "--json"],
      { home, cwd, mode: "base" }
    );

    assert.equal(blocked.code, 3);
    assertNoUnexpectedStderr(blocked.stderr);
    const output = parseRecoveryOutput(blocked.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error?.code, "InteractionRequired");
    assert.equal(
      output.error?.facts.reason,
      "ordinary-approval-required"
    );
    assert.equal(
      existsSync(join(home, ".skiloom", "registry.sqlite3")),
      false
    );
    assert.equal(existsSync(join(target, "app")), true);
  });
});

test("recover fails closed on foreign content at a candidate activation", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    await deleteRegistry(home);
    await rm(join(target, "app"), {
      recursive: true,
      force: true
    });
    await mkdir(join(target, "app"));
    await writeFile(
      join(target, "app", "KEEP"),
      "foreign recovery bytes\n"
    );

    const recovered = await runCli(
      ["recover", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );

    assert.equal(recovered.code, 1);
    const output = parseRecoveryOutput(recovered.stdout);
    assert.equal(output.ok, false);
    assert.equal(
      output.error?.code,
      "ForeignTargetPathConflict"
    );
    assert.equal(
      await readFile(join(target, "app", "KEEP"), "utf8"),
      "foreign recovery bytes\n"
    );
    const status = await runCli(
      ["status", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(status.code, 0);
    const statusOutput = JSON.parse(status.stdout) as {
      result: { registry: unknown };
    };
    assert.equal(statusOutput.result.registry, null);
  });
});

test("recover preserves a detached marker binding and user-owned bytes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    const detached = await runCli(
      ["detach", "acme/app/app", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(detached.code, 0);
    await writeFile(
      join(target, "app", "USER-NOTE"),
      "detached recovery bytes\n"
    );
    await deleteRegistry(home);

    const recovered = await runCli(
      ["recover", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );

    assert.equal(recovered.code, 0);
    const output = parseRecoveryOutput(recovered.stdout);
    assert.equal(output.result.status, "recovered");
    assert.deepEqual(output.result.projections, [
      {
        packageCoordinate: "acme/app/app",
        activationName: "app",
        ownership: "detached"
      }
    ]);
    assert.equal(
      await readFile(
        join(target, "app", "USER-NOTE"),
        "utf8"
      ),
      "detached recovery bytes\n"
    );
  });
});

test("recover rebuilds Machine Registry from marker intent without treating Target bytes as exact state", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    const marker = await readTargetStateMarkerFile(target);
    assert.equal(marker.ok, true);
    if (!marker.ok || marker.value === null) {
      return;
    }
    const targetId = marker.value.targetId;

    await deleteRegistry(home);
    assert.equal(
      existsSync(join(home, ".skiloom", "registry.sqlite3")),
      false
    );

    const recovered = await runCli(
      ["recover", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );

    assert.equal(recovered.code, 0);
    assertNoUnexpectedStderr(recovered.stderr);
    const output = parseRecoveryOutput(recovered.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.result.status, "recovered");
    assert.equal(output.result.targetId, targetId);
    assert.equal(output.result.generation, 1);
    assert.deepEqual(
      output.result.packages.map(
        (entry) => entry.packageCoordinate
      ),
      ["acme/app/app"]
    );
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );
  });
});

async function deleteRegistry(home: string): Promise<void> {
  const registry = join(home, ".skiloom", "registry.sqlite3");
  await rm(registry, { force: true });
  await rm(registry + "-shm", { force: true });
  await rm(registry + "-wal", { force: true });
}

async function withCliRuntime(
  run: (input: Readonly<{
    home: string;
    cwd: string;
    target: string;
  }>) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(
    join(tmpdir(), "skiloom-cli-recover-")
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
    mode: string;
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
          SKILOOM_TEST_GITHUB_MODE: options.mode
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

function parseRecoveryOutput(
  source: string
): ParsedRecoveryOutput {
  return JSON.parse(source) as ParsedRecoveryOutput;
}

function assertNoUnexpectedStderr(stderr: string): void {
  const normalized = stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u,
    ""
  );
  assert.equal(normalized, "");
}
