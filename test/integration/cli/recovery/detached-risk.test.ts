import assert from "node:assert/strict";
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

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve("native/skiloom-lock/target/debug/skiloom-lock");

type RecoveryOutput = Readonly<{
  ok: boolean;
  result: Readonly<{
    status: string;
    generation: number | null;
    projections: ReadonlyArray<Readonly<{
      packageCoordinate: string;
      activationName: string;
      ownership: "managed" | "detached";
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
  }>;
}>;

test("DB-loss recover surfaces marker-baseline detached risk and preserves user bytes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    assert.equal(
      (
        await runCli(
          ["detach", "acme/app/app", "--json"],
          { home, cwd, mode: "forbid-network" }
        )
      ).code,
      0
    );
    await writeFile(
      join(target, "app", "USER-NOTE"),
      "keep recovered detached bytes\n",
      "utf8"
    );
    await deleteRegistry(home);

    const human = await runCli(
      ["recover", "--plan"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(human.code, 0);
    assert.match(
      human.stdout,
      /acme\/app\/app -> app \(detached\)/u
    );
    assert.match(
      human.stdout,
      /detached-content-change acme\/app\/app/u
    );
    assert.match(
      human.stdout,
      /user-owned bytes are preserved; review compatibility manually/u
    );

    const planned = await runCli(
      ["recover", "--plan", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(planned.code, 0);
    const planOutput = parse(planned.stdout);
    assert.equal(planOutput.result.status, "planned");
    assert.equal(planOutput.result.generation, null);
    assert.equal(
      planOutput.result.detachedContentRisks.length,
      1
    );
    const risk =
      planOutput.result.detachedContentRisks[0]!;
    assert.equal(risk.packageCoordinate, "acme/app/app");
    assert.equal(risk.previousSource?.version, "1.0.0");
    assert.equal(risk.candidateSource?.version, "2.0.0");
    assert.notEqual(
      risk.previousPackage.contentDigest,
      risk.candidatePackage.contentDigest
    );
    assert.equal(
      await readFile(
        join(target, "app", "USER-NOTE"),
        "utf8"
      ),
      "keep recovered detached bytes\n"
    );

    const recovered = await runCli(
      ["recover", "--yes", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(recovered.code, 0);
    const output = parse(recovered.stdout);
    assert.equal(output.result.status, "recovered");
    assert.equal(
      output.result.detachedContentRisks.length,
      1
    );
    assert.equal(
      output.result.projections[0]?.ownership,
      "detached"
    );
    assert.equal(
      await readFile(
        join(target, "app", "USER-NOTE"),
        "utf8"
      ),
      "keep recovered detached bytes\n"
    );
  });
});

test("unchanged detached recover does not emit a false compatibility risk", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    assert.equal(
      (
        await runCli(
          ["detach", "acme/app/app", "--json"],
          { home, cwd, mode: "forbid-network" }
        )
      ).code,
      0
    );
    await deleteRegistry(home);

    const planned = await runCli(
      ["recover", "--plan", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(planned.code, 0);
    assert.deepEqual(
      parse(planned.stdout).result.detachedContentRisks,
      []
    );
  });
});

test("stale-copy fork derives detached risk from copied marker baseline rather than current Registry", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    assert.equal(
      (
        await runCli(
          ["detach", "acme/app/app", "--json"],
          { home, cwd, mode: "forbid-network" }
        )
      ).code,
      0
    );

    const copyTarget = join(cwd, "detached-copy");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });
    const copiedMarkerBefore = await readFile(
      join(copyTarget, ".skiloom-state")
    );

    const updated = await runCli(
      ["update", "--yes", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(updated.code, 0);

    const forked = await runCli(
      [
        "fork",
        "--target",
        copyTarget,
        "--plan",
        "--json"
      ],
      { home, cwd, mode: "versions" }
    );
    assert.equal(forked.code, 0);
    const output = parse(forked.stdout);
    assert.equal(output.result.status, "planned");
    assert.equal(
      output.result.detachedContentRisks.length,
      1
    );
    const risk = output.result.detachedContentRisks[0]!;
    assert.equal(risk.previousSource?.version, "1.0.0");
    assert.equal(risk.candidateSource?.version, "2.0.0");
    assert.equal(
      await readFile(join(copyTarget, ".skiloom-state"))
        .then((bytes) =>
          Buffer.compare(bytes, copiedMarkerBefore)
        ),
      0
    );
  });
});

async function deleteRegistry(home: string): Promise<void> {
  const registry = join(
    home,
    ".skiloom",
    "registry.sqlite3"
  );
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
  const root = await mkdtemp(
    join(tmpdir(), "skiloom-cli-recovery-risk-")
  );
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  try {
    await run({
      home,
      cwd,
      target: join(cwd, ".agents", "skills")
    });
  } finally {
    await rm(root, {
      recursive: true,
      force: true
    });
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

function parse(source: string): RecoveryOutput {
  return JSON.parse(source) as RecoveryOutput;
}
