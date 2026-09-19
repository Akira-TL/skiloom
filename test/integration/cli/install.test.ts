import assert from "node:assert/strict";
import {
  existsSync
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat
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

test("install --plan renders a complete human candidate without committing Registry or Target", async () => {
  await withCliRuntime("plan-human", async ({ home, cwd, target }) => {
    const result = await runCli(
      [
        "install",
        "acme/app/app",
        "--name",
        "app-local",
        "--plan"
      ],
      { home, cwd }
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp("Target: " + escapeRegExp(target)));
    assert.match(result.stdout, /Status: planned/u);
    assert.match(result.stdout, /Direct Install Requirements:/u);
    assert.match(result.stdout, /acme\/app\/app/u);
    assert.match(result.stdout, /Sources:/u);
    assert.match(result.stdout, /Packages:/u);
    assert.match(
      result.stdout,
      /acme\/app\/app -> app-local/u
    );
    await assert.rejects(
      stat(join(home, ".skiloom", "registry.sqlite3"))
    );
    assert.equal(existsSync(join(target, "app-local")), false);
  });
});

test("install --plan --json keeps the SKILOOM-CLI-V1 envelope and does not imply acceptance", async () => {
  await withCliRuntime("plan-json", async ({ home, cwd, target }) => {
    const result = await runCli(
      ["install", "acme/app/app", "--plan", "--json"],
      { home, cwd }
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const output = parseJson(result.stdout);
    assert.equal(output.schema, "SKILOOM-CLI-V1");
    assert.equal(output.ok, true);
    assert.equal(output.command, "install");
    assert.equal(output.result.status, "planned");
    assert.equal(output.result.target.path, target);
    assert.equal(
      output.result.directRequirements[0]?.coordinate,
      "acme/app/app"
    );
    assert.equal(
      output.result.directRequirements[0]?.sourceKind,
      "github-release"
    );
    assert.equal(
      output.result.sources[0]?.repositoryCoordinate,
      "acme/app"
    );
    assert.equal(
      output.result.packages[0]?.packageCoordinate,
      "acme/app/app"
    );
    await assert.rejects(
      stat(join(home, ".skiloom", "registry.sqlite3"))
    );
  });
});

test("noninteractive install without --yes returns InteractionRequired exit 3 without accepted mutation", async () => {
  await withCliRuntime("approval", async ({ home, cwd, target }) => {
    const result = await runCli(
      ["install", "acme/app/app", "--json"],
      { home, cwd }
    );

    assert.equal(result.code, 3);
    assert.equal(result.stderr, "");
    const output = parseJson(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.command, "install");
    assert.equal(output.error.code, "InteractionRequired");
    assert.equal(
      output.error.facts.reason,
      "ordinary-approval-required"
    );
    const status = await runCli(
      ["status", "--json"],
      { home, cwd }
    );
    assert.equal(status.code, 0);
    const statusOutput = parseJson(status.stdout);
    assert.equal(statusOutput.result.registry, null);
    assert.equal(statusOutput.result.marker, null);
    assert.equal(existsSync(join(target, "app")), false);
  });
});

test("install applies Package and repository-wide GitHub Release roots through the canonical lifecycle", async () => {
  await withCliRuntime("release-package", async ({ home, cwd, target }) => {
    const result = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );

    assert.equal(result.code, 0);
    const output = parseJson(result.stdout);
    assert.equal(output.result.status, "installed");
    assert.equal(output.result.acceptedState.generation, 1);
    assert.equal(
      output.result.directRequirements[0]?.kind,
      "package"
    );
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );
    assert.equal(
      existsSync(join(target, ".skiloom-state")),
      true
    );
  });

  await withCliRuntime("release-repository", async ({ home, cwd, target }) => {
    const result = await runCli(
      ["install", "acme/suite", "--yes", "--json"],
      { home, cwd }
    );

    assert.equal(result.code, 0);
    const output = parseJson(result.stdout);
    assert.equal(output.result.status, "installed");
    assert.equal(
      output.result.directRequirements[0]?.kind,
      "repository"
    );
    assert.deepEqual(
      output.result.packages.map(
        (entry: { packageCoordinate: string }) =>
          entry.packageCoordinate
      ),
      ["acme/suite/alpha", "acme/suite/beta"]
    );
    assert.equal(existsSync(join(target, "alpha")), true);
    assert.equal(existsSync(join(target, "beta")), true);
  });
});

test("reinstalling one Package with a new version upserts the direct requirement at the executable boundary", async () => {
  await withCliRuntime("version-upsert", async ({ home, cwd, target }) => {
    const first = await runCli(
      [
        "install",
        "acme/app/app",
        "--version",
        "^1.0.0",
        "--yes",
        "--json"
      ],
      { home, cwd, mode: "versions" }
    );
    assert.equal(first.code, 0);
    const installed = parseJson(first.stdout);
    assert.equal(installed.result.status, "installed");
    assert.equal(installed.result.directRequirements.length, 1);
    assert.equal(
      installed.result.directRequirements[0]?.versionRequirement,
      "^1.0.0"
    );

    const second = await runCli(
      [
        "install",
        "acme/app/app",
        "--version",
        "^2.0.0",
        "--yes",
        "--json"
      ],
      { home, cwd, mode: "versions" }
    );
    assert.equal(second.code, 0);
    const applied = parseJson(second.stdout);
    assert.equal(applied.result.status, "applied");
    assert.equal(applied.result.acceptedState.generation, 2);
    assert.deepEqual(applied.result.directRequirements, [
      {
        kind: "package",
        coordinate: "acme/app/app",
        sourceKind: "github-release",
        versionRequirement: "^2.0.0"
      }
    ]);
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Version two application\./u
    );
  });
});

test("install supports explicit Git source and Package activation rename while preserving Package identity", async () => {
  await withCliRuntime("git", async ({ home, cwd }) => {
    const result = await runCli(
      [
        "install",
        "acme/gitapp/gitapp",
        "--git",
        "main",
        "--yes",
        "--json"
      ],
      { home, cwd }
    );

    assert.equal(result.code, 0);
    const output = parseJson(result.stdout);
    assert.equal(
      output.result.directRequirements[0]?.sourceKind,
      "git"
    );
    assert.equal(
      output.result.directRequirements[0]?.requestedRef,
      "main"
    );
    assert.equal(output.result.sources[0]?.sourceKind, "git");
  });

  await withCliRuntime("rename", async ({ home, cwd, target }) => {
    const first = await runCli(
      [
        "install",
        "acme/app/app",
        "--name",
        "app-local",
        "--yes",
        "--json"
      ],
      { home, cwd }
    );
    assert.equal(first.code, 0);
    const installed = parseJson(first.stdout);
    assert.equal(installed.result.status, "installed");
    assert.deepEqual(installed.result.projectionRenames, [
      {
        packageCoordinate: "acme/app/app",
        activationName: "app-local"
      }
    ]);
    assert.equal(
      installed.result.packages[0]?.packageCoordinate,
      "acme/app/app"
    );
    assert.equal(existsSync(join(target, "app")), false);
    assert.equal(existsSync(join(target, "app-local")), true);

    const repeated = await runCli(
      [
        "install",
        "acme/app/app",
        "--name",
        "app-local",
        "--json"
      ],
      { home, cwd }
    );
    assert.equal(repeated.code, 0);
    assert.equal(parseJson(repeated.stdout).result.status, "no-op");
  });
});

test("release retarget remains independently gated after ordinary --yes approval", async () => {
  await withCliRuntime("retarget", async ({ home, cwd, target }) => {
    const initial = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(initial.code, 0);

    const blocked = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "retarget" }
    );
    assert.equal(blocked.code, 3);
    const blockedOutput = parseJson(blocked.stdout);
    assert.equal(
      blockedOutput.error.code,
      "InteractionRequired"
    );
    assert.equal(
      blockedOutput.error.facts.reason,
      "release-retarget-authorization-required"
    );
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );

    const accepted = await runCli(
      [
        "install",
        "acme/app/app",
        "--yes",
        "--allow-release-retarget",
        "--json"
      ],
      { home, cwd, mode: "retarget" }
    );
    assert.equal(accepted.code, 0);
    assert.equal(parseJson(accepted.stdout).result.status, "applied");
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Retargeted application\./u
    );
  });
});

test("install rejects conflicting source flags and repository-wide --name as usage errors", async () => {
  await withCliRuntime("usage", async ({ home, cwd }) => {
    for (const args of [
      [
        "install",
        "acme/app/app",
        "--version",
        "^1",
        "--git",
        "main",
        "--json"
      ],
      [
        "install",
        "acme/suite",
        "--name",
        "suite-local",
        "--json"
      ]
    ]) {
      const result = await runCli(args, { home, cwd });
      assert.equal(result.code, 2);
      const output = parseJson(result.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.command, "install");
      assert.equal(output.error.code, "InvalidArguments");
    }
  });
});

async function withCliRuntime(
  name: string,
  run: (input: Readonly<{
    home: string;
    cwd: string;
    target: string;
  }>) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(
    join(tmpdir(), "skiloom-cli-install-" + name + "-")
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
    mode?: string;
  }>
): Promise<Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        FETCH_PRELOAD,
        CLI_ENTRY,
        ...args
      ],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          HOME: options.home,
          USERPROFILE: options.home,
          SKILOOM_LOCK_TEST_BINARY: LOCK_HELPER,
          SKILOOM_TEST_GITHUB_MODE: options.mode ?? "base"
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

function parseJson(source: string): any {
  return JSON.parse(source);
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^(){}$|[\]\\]/gu, "\\$&");
}
