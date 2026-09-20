import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
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

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve("native/skiloom-lock/target/debug/skiloom-lock");

type ParsedUpdateOutput = Readonly<{
  ok: boolean;
  error?: Readonly<{
    code: string;
    facts: Readonly<{ reason: string }>;
  }>;
  result: Readonly<{
    status: string;
    directRequirements: ReadonlyArray<Readonly<{
      coordinate: string;
    }>>;
    sources: ReadonlyArray<Readonly<{
      repositoryCoordinate: string;
      sourceKind: string;
      version?: string;
    }>>;
    projections: ReadonlyArray<Readonly<{
      packageCoordinate: string;
      activationName: string;
      ownership: string;
    }>>;
    detachedContentRisks: ReadonlyArray<Readonly<{
      kind: "detached-content-change";
      packageCoordinate: string;
      previousPackage: Readonly<{
        packageRoot: string;
        contentDigest: string;
      }>;
      candidatePackage: Readonly<{
        packageRoot: string;
        contentDigest: string;
      }>;
      previousSource: Readonly<{
        sourceKind: string;
        version?: string;
        exactCommit: string;
      }> | null;
      candidateSource: Readonly<{
        sourceKind: string;
        version?: string;
        exactCommit: string;
      }> | null;
    }>>;
    comparison: Readonly<{
      sourceDeltas: ReadonlyArray<Readonly<{
        kind: string;
        repositoryCoordinate: string;
      }>>;
    }>;
    acceptedState: Readonly<{
      generation: number;
    }>;
  }>;
}>;

test("update --plan human output presents the complete candidate surface", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const planned = await runCli(
      ["update", "--plan"],
      { home, cwd, mode: "versions" }
    );

    assert.equal(planned.code, 0);
    assertNoUnexpectedStderr(planned.stderr);
    assert.match(planned.stdout, new RegExp("Target: " + escapeRegExp(target)));
    assert.match(planned.stdout, /Status: planned/u);
    assert.match(planned.stdout, /Direct Install Requirements:/u);
    assert.match(planned.stdout, /Sources:/u);
    assert.match(planned.stdout, /Packages:/u);
    assert.match(planned.stdout, /Dependency Edges:/u);
    assert.match(planned.stdout, /Projections \/ Ownership:/u);
    assert.match(planned.stdout, /acme\/app\/app -> app \(managed\)/u);
    assert.match(planned.stdout, /Changes:/u);
    assert.match(planned.stdout, /Warnings \/ Special Risks:/u);
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );
  });
});

test("update --plan returns candidate projection ownership without mutating accepted state", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const planned = await runCli(
      ["update", "--plan", "--json"],
      { home, cwd, mode: "versions" }
    );

    assert.equal(planned.code, 0);
    assertNoUnexpectedStderr(planned.stderr);
    const output = parseUpdateOutput(planned.stdout);
    assert.equal(output.result.status, "planned");
    assert.equal(output.result.sources[0]?.version, "2.0.0");
    assert.deepEqual(output.result.projections, [
      {
        packageCoordinate: "acme/app/app",
        activationName: "app",
        ownership: "managed"
      }
    ]);
    assert.equal(output.result.acceptedState.generation, 1);
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );
  });
});

test("detached Package content changes surface structured and human compatibility risk without touching user bytes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const detached = await runCli(
      ["detach", "acme/app/app", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(detached.code, 0);
    await writeFile(
      join(target, "app", "USER-NOTE"),
      "keep detached user bytes\n",
      "utf8"
    );

    const humanPlan = await runCli(
      ["update", "--plan"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(humanPlan.code, 0);
    assert.match(
      humanPlan.stdout,
      /acme\/app\/app -> app \(detached\)/u
    );
    assert.match(
      humanPlan.stdout,
      /detached-content-change acme\/app\/app/u
    );
    assert.match(
      humanPlan.stdout,
      /user-owned bytes are preserved; review compatibility manually/u
    );
    assert.equal(
      await readFile(
        join(target, "app", "USER-NOTE"),
        "utf8"
      ),
      "keep detached user bytes\n"
    );

    const jsonPlan = await runCli(
      ["update", "--plan", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(jsonPlan.code, 0);
    const planned = parseUpdateOutput(jsonPlan.stdout);
    assert.equal(planned.result.status, "planned");
    assert.equal(planned.result.acceptedState.generation, 2);
    assert.equal(
      planned.result.detachedContentRisks.length,
      1
    );
    const risk = planned.result.detachedContentRisks[0]!;
    assert.equal(
      risk.kind,
      "detached-content-change"
    );
    assert.equal(
      risk.packageCoordinate,
      "acme/app/app"
    );
    assert.notEqual(
      risk.previousPackage.contentDigest,
      risk.candidatePackage.contentDigest
    );
    assert.equal(
      risk.previousSource?.version,
      "1.0.0"
    );
    assert.equal(
      risk.candidateSource?.version,
      "2.0.0"
    );

    const unchanged = await runCli(
      ["update", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(unchanged.code, 0);
    const unchangedOutput =
      parseUpdateOutput(unchanged.stdout);
    assert.equal(
      unchangedOutput.result.status,
      "no-op"
    );
    assert.deepEqual(
      unchangedOutput.result.detachedContentRisks,
      []
    );

    const accepted = await runCli(
      ["update", "--yes", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(accepted.code, 0);
    const acceptedOutput =
      parseUpdateOutput(accepted.stdout);
    assert.equal(
      acceptedOutput.result.status,
      "updated"
    );
    assert.equal(
      acceptedOutput.result.acceptedState.generation,
      3
    );
    assert.equal(
      acceptedOutput.result.detachedContentRisks.length,
      1
    );
    assert.equal(
      await readFile(
        join(target, "app", "USER-NOTE"),
        "utf8"
      ),
      "keep detached user bytes\n"
    );
  });
});

test("interactive update presents the complete candidate and defaults to rejection", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const rejected = await runInteractiveCli(
      ["update"],
      { home, cwd, mode: "versions", input: "n\n" }
    );

    assert.equal(rejected.code, 3);
    assert.match(
      rejected.stdout,
      new RegExp("Target: " + escapeRegExp(target))
    );
    assert.match(rejected.stdout, /Status: candidate/u);
    assert.match(rejected.stdout, /Direct Install Requirements:/u);
    assert.match(rejected.stdout, /Sources:/u);
    assert.match(rejected.stdout, /Packages:/u);
    assert.match(rejected.stdout, /Projections \/ Ownership:/u);
    assert.match(
      rejected.stdout,
      /acme\/app\/app -> app \(managed\)/u
    );
    assert.match(rejected.stdout, /Apply this complete state\? \[y\/N\]/u);
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );
  });
});

test("noninteractive update without --yes requires approval before mutation", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const blocked = await runCli(
      ["update", "--json"],
      { home, cwd, mode: "versions" }
    );

    assert.equal(blocked.code, 3);
    assertNoUnexpectedStderr(blocked.stderr);
    const output = parseUpdateOutput(blocked.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error?.code, "InteractionRequired");
    assert.equal(
      output.error?.facts.reason,
      "ordinary-approval-required"
    );
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );

    const status = await runCli(
      ["status", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(status.code, 0);
    const statusOutput = JSON.parse(status.stdout) as {
      result: { registry: { generation: number } };
    };
    assert.equal(statusOutput.result.registry.generation, 1);
  });
});

test("identical update is a no-op without approval or generation change", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const noOp = await runCli(
      ["update", "--json"],
      { home, cwd, mode: "base" }
    );

    assert.equal(noOp.code, 0);
    assertNoUnexpectedStderr(noOp.stderr);
    const output = parseUpdateOutput(noOp.stdout);
    assert.equal(output.result.status, "no-op");
    assert.equal(output.result.acceptedState.generation, 1);
    assert.deepEqual(output.result.comparison.sourceDeltas, []);
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );
  });
});

test("release retarget requires independent authorization after --yes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const blocked = await runCli(
      ["update", "--yes", "--json"],
      { home, cwd, mode: "retarget" }
    );

    assert.equal(blocked.code, 3);
    const blockedOutput = parseUpdateOutput(blocked.stdout);
    assert.equal(blockedOutput.error?.code, "InteractionRequired");
    assert.equal(
      blockedOutput.error?.facts.reason,
      "release-retarget-authorization-required"
    );
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );

    const accepted = await runCli(
      [
        "update",
        "--yes",
        "--allow-release-retarget",
        "--json"
      ],
      { home, cwd, mode: "retarget" }
    );

    assert.equal(accepted.code, 0);
    const output = parseUpdateOutput(accepted.stdout);
    assert.equal(output.result.status, "updated");
    assert.equal(output.result.acceptedState.generation, 2);
    assert.equal(
      output.result.comparison.sourceDeltas[0]?.kind,
      "release-retarget"
    );
    assert.equal(
      output.result.comparison.sourceDeltas[0]?.repositoryCoordinate,
      "acme/app"
    );
    assert.deepEqual(output.result.projections, [
      {
        packageCoordinate: "acme/app/app",
        activationName: "app",
        ownership: "managed"
      }
    ]);
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Retargeted application\./u
    );
  });
});

test("update re-resolves the whole accepted Target and commits the new candidate", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const updated = await runCli(
      ["update", "--yes", "--json"],
      { home, cwd, mode: "versions" }
    );

    assert.equal(updated.code, 0);
    assertNoUnexpectedStderr(updated.stderr);
    const output = parseUpdateOutput(updated.stdout);
    assert.equal(output.result.status, "updated");
    assert.equal(output.result.acceptedState.generation, 2);
    assert.deepEqual(
      output.result.directRequirements.map(
        (entry) => entry.coordinate
      ),
      ["acme/app/app"]
    );
    assert.equal(
      output.result.sources[0]?.repositoryCoordinate,
      "acme/app"
    );
    assert.equal(output.result.sources[0]?.sourceKind, "github-release");
    assert.equal(output.result.sources[0]?.version, "2.0.0");
    assert.equal(existsSync(join(target, "app")), true);
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Version two application\./u
    );
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
    join(tmpdir(), "skiloom-cli-update-")
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

function runInteractiveCli(
  args: ReadonlyArray<string>,
  options: Readonly<{
    home: string;
    cwd: string;
    mode: string;
    input: string;
  }>
): Promise<Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolveResult, reject) => {
    const command = [
      process.execPath,
      "--import",
      FETCH_PRELOAD,
      CLI_ENTRY,
      ...args
    ].map(shellQuote).join(" ");
    const child = spawn(
      "/usr/bin/script",
      ["-qefc", command, "/dev/null"],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          HOME: options.home,
          USERPROFILE: options.home,
          SKILOOM_LOCK_TEST_BINARY: LOCK_HELPER,
          SKILOOM_TEST_GITHUB_MODE: options.mode
        },
        stdio: ["pipe", "pipe", "pipe"]
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
    child.stdin.end(options.input);
  });
}

function parseUpdateOutput(source: string): ParsedUpdateOutput {
  return JSON.parse(source) as ParsedUpdateOutput;
}

function assertNoUnexpectedStderr(stderr: string): void {
  const normalized = stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u,
    ""
  );
  assert.equal(normalized, "");
}

function shellQuote(source: string): string {
  return "'" + source.replace(/'/gu, "'\\''") + "'";
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^(){}$|[\]\\]/gu, "\\$&");
}
