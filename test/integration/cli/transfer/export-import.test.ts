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

import {
  parseExactExportPackage
} from "../../../../src/domain/export-package/index.js";

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve("native/skiloom-lock/target/debug/skiloom-lock");

type ParsedCliOutput = Readonly<{
  ok: boolean;
  result: Readonly<{
    mode: string;
    file: string;
  }>;
  error?: Readonly<{
    code: string;
    facts: Readonly<Record<string, unknown>>;
  }>;
  warnings: ReadonlyArray<Readonly<{
    code: string;
    facts: Readonly<Record<string, unknown>>;
  }>>;
}>;

test("export defaults to dependencies, full includes user-owned payloads, and existing destinations never overwrite", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const dependenciesFile = "deps.skiloom-export";
    const exported = await runCli(
      ["export", dependenciesFile, "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(exported.code, 0);
    assertNoUnexpectedStderr(exported.stderr);
    const output = parseOutput(exported.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.result.mode, "dependencies");
    assert.equal(output.result.file, dependenciesFile);
    assert.deepEqual(output.warnings, []);
    assert.equal(exported.stdout.includes(home), false);
    assert.equal(exported.stdout.includes(target), false);

    const dependenciesPath = join(cwd, dependenciesFile);
    const parsedDependencies = parseExactExportPackage(
      await readFile(dependenciesPath)
    );
    assert.equal(parsedDependencies.ok, true);
    if (!parsedDependencies.ok) {
      return;
    }
    assert.equal(
      parsedDependencies.value.manifest.mode,
      "dependencies"
    );
    assert.deepEqual(
      parsedDependencies.value.manifest.userSkills,
      []
    );

    const before = await readFile(dependenciesPath);
    const existing = await runCli(
      ["export", dependenciesFile, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(existing.code, 1);
    const existingOutput = parseOutput(existing.stdout);
    assert.equal(
      existingOutput.error?.code,
      "ExactExportDestinationExists"
    );
    assert.equal(existing.stdout.includes(home), false);
    assert.deepEqual(
      await readFile(dependenciesPath),
      before
    );

    const manual = join(target, "manual");
    await mkdir(manual);
    await writeFile(
      join(manual, "SKILL.md"),
      [
        "---",
        "name: manual",
        "description: Manual exported skill.",
        "---",
        "manual bytes",
        ""
      ].join("\n"),
      "utf8"
    );

    const fullFile = "full.skiloom-export";
    const full = await runCli(
      ["export", fullFile, "--full", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(full.code, 0);
    const fullOutput = parseOutput(full.stdout);
    assert.equal(fullOutput.result.mode, "full");
    assert.equal(fullOutput.result.file, fullFile);
    const parsedFull = parseExactExportPackage(
      await readFile(join(cwd, fullFile))
    );
    assert.equal(parsedFull.ok, true);
    if (!parsedFull.ok) {
      return;
    }
    assert.equal(parsedFull.value.manifest.mode, "full");
    assert.deepEqual(
      parsedFull.value.manifest.userSkills.map(
        (entry) => entry.activationName
      ),
      ["manual"]
    );
    assert.equal(existsSync(join(target, "app")), true);
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
    join(tmpdir(), "skiloom-cli-transfer-")
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

function parseOutput(source: string): ParsedCliOutput {
  return JSON.parse(source) as ParsedCliOutput;
}

function assertNoUnexpectedStderr(stderr: string): void {
  const normalized = stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u,
    ""
  );
  assert.equal(normalized, "");
}
