import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm
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
    acceptedState: Readonly<{
      generation: number;
    }>;
  }>;
}>;

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
    assert.equal(planned.stderr, "");
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
    assert.equal(updated.stderr, "");
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

function parseUpdateOutput(source: string): ParsedUpdateOutput {
  return JSON.parse(source) as ParsedUpdateOutput;
}
