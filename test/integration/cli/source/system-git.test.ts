import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve(
    "native/skiloom-lock/target/manylinux2014/release/skiloom-lock"
  );

test("explicit Git package install uses system Git with zero GitHub REST requests", async () => {
  await withGitCliRuntime(async ({ home, cwd, target }) => {
    const result = await runCli(
      [
        "install",
        "acme/suite/alpha",
        "--git",
        "main",
        "--target",
        target,
        "--yes",
        "--non-interactive",
        "--json"
      ],
      { home, cwd }
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as InstallEnvelope;
    assert.equal(output.ok, true);
    assert.equal(output.result.acceptedState.generation, 1);
    assert.deepEqual(output.result.directRequirements, [
      {
        kind: "package",
        coordinate: "acme/suite/alpha",
        sourceKind: "git",
        requestedRef: "main"
      }
    ]);
    assert.equal(output.result.sources.length, 1);
    assert.equal(output.result.sources[0]?.repositoryCoordinate, "acme/suite");
    assert.equal(output.result.sources[0]?.sourceKind, "git");
    assert.equal(output.result.sources[0]?.requestedRef, "main");
    assert.match(
      output.result.sources[0]?.exactCommit ?? "",
      /^[0-9a-f]{40}$/u
    );
    assert.deepEqual(
      output.result.packages.map((entry) => entry.packageCoordinate),
      ["acme/suite/alpha", "acme/suite/beta"]
    );
    assert.deepEqual(
      output.result.dependencyEdges.map((entry) => ({
        source: entry.sourcePackageCoordinate,
        target: entry.targetPackageCoordinate
      })),
      [
        {
          source: "acme/suite/alpha",
          target: "acme/suite/beta"
        }
      ]
    );
    assert.match(
      await readFile(join(target, "alpha", "SKILL.md"), "utf8"),
      /Alpha from system Git\./u
    );
    assert.match(
      await readFile(join(target, "beta", "SKILL.md"), "utf8"),
      /Beta from system Git\./u
    );
  });
});

test("explicit Git repository-wide install uses the same exact Git snapshot with zero GitHub REST requests", async () => {
  await withGitCliRuntime(async ({ home, cwd, target }) => {
    const result = await runCli(
      [
        "install",
        "acme/suite",
        "--git",
        "main",
        "--target",
        target,
        "--yes",
        "--non-interactive",
        "--json"
      ],
      { home, cwd }
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as InstallEnvelope;
    assert.equal(output.ok, true);
    assert.deepEqual(output.result.directRequirements, [
      {
        kind: "repository",
        coordinate: "acme/suite",
        sourceKind: "git",
        requestedRef: "main"
      }
    ]);
    assert.deepEqual(
      output.result.packages.map((entry) => entry.packageCoordinate),
      ["acme/suite/alpha", "acme/suite/beta"]
    );
    assert.equal(output.result.sources.length, 1);
    assert.equal(output.result.sources[0]?.sourceKind, "git");
  });
});

type InstallEnvelope = Readonly<{
  ok: boolean;
  result: Readonly<{
    directRequirements: ReadonlyArray<Readonly<{
      kind: string;
      coordinate: string;
      sourceKind: string;
      requestedRef?: string;
    }>>;
    sources: ReadonlyArray<Readonly<{
      repositoryCoordinate: string;
      sourceKind: string;
      requestedRef?: string;
      exactCommit?: string;
    }>>;
    packages: ReadonlyArray<Readonly<{
      packageCoordinate: string;
    }>>;
    dependencyEdges: ReadonlyArray<Readonly<{
      sourcePackageCoordinate: string;
      targetPackageCoordinate: string;
    }>>;
    acceptedState: Readonly<{ generation: number }>;
  }>;
}>;

async function withGitCliRuntime(
  run: (input: Readonly<{
    home: string;
    cwd: string;
    target: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skiloom-cli-system-git-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const repository = join(root, "suite");
  const target = join(cwd, ".agents", "skills");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(repository, { recursive: true })
  ]);

  try {
    await createSuiteRepository(repository);
    await writeFile(
      join(home, ".gitconfig"),
      [
        '[url "' + pathToFileURL(repository).href + '"]',
        "    insteadOf = git@github.com:acme/suite.git",
        ""
      ].join("\n"),
      "utf8"
    );
    await run({ home, cwd, target });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createSuiteRepository(repository: string): Promise<void> {
  await git(["init", "-b", "main"], repository);
  await git(["config", "user.name", "Skiloom Test"], repository);
  await git(["config", "user.email", "skiloom@example.invalid"], repository);
  await mkdir(join(repository, "skills", "alpha"), { recursive: true });
  await mkdir(join(repository, "skills", "beta"), { recursive: true });
  await writeFile(
    join(repository, "skiloom-repo.toml"),
    [
      "schema = 1",
      "",
      "[discovery]",
      'include = ["skills/*"]',
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(repository, "skills", "alpha", "SKILL.md"),
    [
      "---",
      "name: alpha",
      "description: Alpha from system Git.",
      "---",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(repository, "skills", "alpha", "skiloom-package.toml"),
    [
      "schema = 1",
      "",
      "[dependencies]",
      '"acme/suite/beta" = "*"',
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(repository, "skills", "beta", "SKILL.md"),
    [
      "---",
      "name: beta",
      "description: Beta from system Git.",
      "---",
      ""
    ].join("\n"),
    "utf8"
  );
  await git(["add", "."], repository);
  await git(["commit", "-m", "suite fixture"], repository);
}

function runCli(
  args: ReadonlyArray<string>,
  options: Readonly<{ home: string; cwd: string }>
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
          SKILOOM_TEST_GITHUB_MODE: "forbid-network"
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
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

function git(args: ReadonlyArray<string>, cwd: string): Promise<void> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error("git fixture setup failed: " + stderr.trim()));
        return;
      }
      resolveResult();
    });
  });
}
