import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
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

type ParsedRemoveOutput = Readonly<{
  ok: boolean;
  error?: Readonly<{
    code: string;
    facts: Readonly<{
      reason: string;
      coordinate?: string;
    }>;
  }>;
  result: Readonly<{
    status: string;
    directRequirements: ReadonlyArray<unknown>;
    packages: ReadonlyArray<unknown>;
    projections: ReadonlyArray<unknown>;
    detachedContentRisks: ReadonlyArray<unknown>;
    acceptedState: Readonly<{
      generation: number;
    }>;
  }>;
}>;

test("remove --plan reports the exact candidate without mutating accepted state", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(installed.code, 0);

    const planned = await runCli(
      ["remove", "acme/app/app", "--plan", "--json"],
      { home, cwd }
    );

    assert.equal(planned.code, 0);
    assertNoUnexpectedStderr(planned.stderr);
    const output = parseRemoveOutput(planned.stdout);
    assert.equal(output.result.status, "planned");
    assert.deepEqual(output.result.directRequirements, []);
    assert.deepEqual(output.result.packages, []);
    assert.deepEqual(output.result.projections, []);
    assert.equal(output.result.acceptedState.generation, 1);
    assert.equal(existsSync(join(target, "app")), true);
  });
});

test("interactive remove presents the candidate and defaults to rejection", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(installed.code, 0);

    const rejected = await runInteractiveCli(
      ["remove", "acme/app/app"],
      { home, cwd, input: "n\n" }
    );

    assert.equal(rejected.code, 3);
    assert.match(
      rejected.stdout,
      new RegExp("Target: " + escapeRegExp(target))
    );
    assert.match(rejected.stdout, /Status: candidate/u);
    assert.match(
      rejected.stdout,
      /Direct Install Requirements:/u
    );
    assert.match(rejected.stdout, /Packages:/u);
    assert.match(
      rejected.stdout,
      /Apply this complete state\? \[y\/N\]/u
    );
    assert.equal(existsSync(join(target, "app")), true);
  });
});

test("noninteractive remove without --yes requires approval before mutation", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(installed.code, 0);

    const blocked = await runCli(
      ["remove", "acme/app/app", "--json"],
      { home, cwd }
    );

    assert.equal(blocked.code, 3);
    assertNoUnexpectedStderr(blocked.stderr);
    const output = parseRemoveOutput(blocked.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error?.code, "InteractionRequired");
    assert.equal(
      output.error?.facts.reason,
      "ordinary-approval-required"
    );
    assert.equal(existsSync(join(target, "app")), true);
  });
});

test("remove rejects coordinates that are not accepted direct requirements", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(installed.code, 0);

    const unknown = await runCli(
      ["remove", "acme/tool/tool", "--yes", "--json"],
      { home, cwd }
    );

    assert.equal(unknown.code, 1);
    assertNoUnexpectedStderr(unknown.stderr);
    const output = parseRemoveOutput(unknown.stdout);
    assert.equal(output.ok, false);
    assert.equal(
      output.error?.code,
      "InvalidRemoveDirectRequirement"
    );
    assert.equal(
      output.error?.facts.reason,
      "requirement-not-found"
    );
    assert.equal(
      output.error?.facts.coordinate,
      "acme/tool/tool"
    );
    assert.equal(existsSync(join(target, "app")), true);
  });
});

test("remove keeps a shared transitive dependency until the final direct root is removed", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const app = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "shared-remove" }
    );
    assert.equal(app.code, 0);
    const tool = await runCli(
      ["install", "acme/tool/tool", "--yes", "--json"],
      { home, cwd, mode: "shared-remove" }
    );
    assert.equal(tool.code, 0);
    assert.equal(existsSync(join(target, "app")), true);
    assert.equal(existsSync(join(target, "tool")), true);
    assert.equal(existsSync(join(target, "shared")), true);

    const first = await runCli(
      ["remove", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "shared-remove" }
    );
    assert.equal(first.code, 0);
    const firstOutput = parseRemoveOutput(first.stdout);
    assert.equal(firstOutput.result.status, "removed");
    assert.equal(existsSync(join(target, "app")), false);
    assert.equal(existsSync(join(target, "tool")), true);
    assert.equal(existsSync(join(target, "shared")), true);

    const second = await runCli(
      ["remove", "acme/tool/tool", "--yes", "--json"],
      { home, cwd, mode: "shared-remove" }
    );
    assert.equal(second.code, 0);
    const secondOutput = parseRemoveOutput(second.stdout);
    assert.equal(secondOutput.result.status, "removed");
    assert.deepEqual(secondOutput.result.directRequirements, []);
    assert.deepEqual(secondOutput.result.packages, []);
    assert.deepEqual(secondOutput.result.projections, []);
    assert.equal(secondOutput.result.acceptedState.generation, 4);
    assert.equal(existsSync(join(target, "tool")), false);
    assert.equal(existsSync(join(target, "shared")), false);
  });
});

test("remove keeps unchanged detached Package risk-free when it remains reachable", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "shared-remove" }
        )
      ).code,
      0
    );
    assert.equal(
      (
        await runCli(
          ["detach", "acme/shared/shared", "--json"],
          { home, cwd, mode: "forbid-network" }
        )
      ).code,
      0
    );
    assert.equal(
      (
        await runCli(
          ["install", "acme/tool/tool", "--yes", "--json"],
          { home, cwd, mode: "shared-remove" }
        )
      ).code,
      0
    );

    const planned = await runCli(
      [
        "remove",
        "acme/app/app",
        "--plan",
        "--json"
      ],
      { home, cwd, mode: "shared-remove" }
    );
    assert.equal(planned.code, 0);
    const output = parseRemoveOutput(planned.stdout);
    assert.deepEqual(
      output.result.detachedContentRisks,
      []
    );
  });
});

test("remove deletes an existing direct root through the complete Target lifecycle", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );
    assert.equal(installed.code, 0);
    assert.equal(existsSync(join(target, "app")), true);

    const removed = await runCli(
      ["remove", "acme/app/app", "--yes", "--json"],
      { home, cwd }
    );

    assert.equal(removed.code, 0);
    const output = parseRemoveOutput(removed.stdout);
    assert.equal(output.result.status, "removed");
    assert.deepEqual(output.result.directRequirements, []);
    assert.deepEqual(output.result.packages, []);
    assert.deepEqual(output.result.projections, []);
    assert.equal(output.result.acceptedState.generation, 2);
    assert.equal(existsSync(join(target, "app")), false);
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
    join(tmpdir(), "skiloom-cli-remove-")
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
      ["--import", FETCH_PRELOAD, CLI_ENTRY, ...args],
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

function runInteractiveCli(
  args: ReadonlyArray<string>,
  options: Readonly<{
    home: string;
    cwd: string;
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
          SKILOOM_TEST_GITHUB_MODE: "base"
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

function parseRemoveOutput(source: string): ParsedRemoveOutput {
  return JSON.parse(source) as ParsedRemoveOutput;
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
