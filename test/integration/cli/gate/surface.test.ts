import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  CANONICAL_CLI_COMMANDS
} from "../../../../src/cli/meta/index.js";
import {
  assertNoUnexpectedStderr,
  assertSingleJsonDocument,
  CLI_ENTRY,
  parseJson,
  runGateCli,
  runInteractiveGateCli,
  withGateRuntime
} from "./fixture.js";

const EXPECTED_CANONICAL_COMMANDS = [
  "search",
  "status",
  "doctor",
  "validate",
  "install",
  "update",
  "remove",
  "rename",
  "sync",
  "repair",
  "detach",
  "rebind",
  "forget",
  "observe",
  "recover",
  "fork",
  "export",
  "import",
  "bootstrap"
] as const;

assert.deepEqual(
  CANONICAL_CLI_COMMANDS,
  EXPECTED_CANONICAL_COMMANDS
);

const CANONICAL_COMMANDS = EXPECTED_CANONICAL_COMMANDS;

const HANG_PRELOAD = resolve(
  "test/integration/cli/gate/hanging-fetch.mjs"
);

const FORBIDDEN_ALIASES = [
  "add",
  "rm",
  "fix",
  "heal",
  "upgrade",
  "uninstall"
] as const;

type FailureEnvelope = Readonly<{
  schema: string;
  ok: false;
  command: string;
  error: Readonly<{
    code: string;
    facts: Readonly<{
      reason?: string;
    }>;
  }>;
  warnings: ReadonlyArray<unknown>;
}>;

test("every canonical v0 command is recognized while --force is rejected", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    for (const command of CANONICAL_COMMANDS) {
      const result = await runGateCli(
        [command, "--force", "--json"],
        { home, cwd }
      );

      assert.equal(result.code, 2, command);
      assert.equal(result.signal, null, command);
      assertNoUnexpectedStderr(result.stderr);
      const output = parseJson<FailureEnvelope>(
        result.stdout
      );
      assert.equal(output.schema, "SKILOOM-CLI-V1");
      assert.equal(output.ok, false);
      assert.equal(output.command, command);
      assert.equal(
        output.error.code,
        "InvalidArguments",
        command
      );
      assert.notEqual(
        output.error.facts.reason,
        "unknown or missing command",
        command
      );
      assert.deepEqual(output.warnings, []);
    }
  });
});

test("v0 aliases policy TUI and multi-Target flags stay outside the public surface", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    for (const alias of FORBIDDEN_ALIASES) {
      const result = await runGateCli(
        [alias, "--json"],
        { home, cwd }
      );
      assert.equal(result.code, 2, alias);
      const output = parseJson<FailureEnvelope>(
        result.stdout
      );
      assert.equal(output.command, alias);
      assert.equal(output.error.code, "InvalidArguments");
      assert.equal(
        output.error.facts.reason,
        "unknown or missing command"
      );
    }

    for (const args of [
      ["status", "--policy", "allow", "--json"],
      ["status", "--profile", "ci", "--json"],
      ["status", "--tui", "--json"],
      ["status", "--targets", "a,b", "--json"]
    ]) {
      const result = await runGateCli(args, {
        home,
        cwd
      });
      assert.equal(result.code, 2, args.join(" "));
      const output = parseJson<FailureEnvelope>(
        result.stdout
      );
      assert.equal(output.error.code, "InvalidArguments");
    }
  });
});

test("default Target stays rooted at cwd and never searches an ancestor Git root", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const repositoryRoot = join(cwd, "repository");
    const nested = join(repositoryRoot, "nested", "work");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(repositoryRoot, ".git"),
      "not a real repository; must still be ignored\n",
      "utf8"
    );

    const status = await runGateCli(
      ["status", "--json"],
      { home, cwd: nested }
    );
    assert.equal(status.code, 0);
    const output = parseJson<{
      result: {
        target: {
          path: string;
          source: string;
        };
      };
    }>(status.stdout);
    assert.equal(
      output.result.target.path,
      join(nested, ".agents", "skills")
    );
    assert.equal(output.result.target.source, "default");
  });
});

test("JSON candidate mode emits one document, never prompts, and uses approval exit 3", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const blocked = await runGateCli(
      ["install", "acme/app/app", "--json"],
      { home, cwd, githubMode: "base" }
    );

    assert.equal(blocked.code, 3);
    assert.equal(blocked.signal, null);
    assertNoUnexpectedStderr(blocked.stderr);
    const document =
      assertSingleJsonDocument(blocked.stdout);
    assert.equal(document.schema, "SKILOOM-CLI-V1");
    assert.equal(document.ok, false);
    assert.equal(document.command, "install");
    assert.equal(
      blocked.stdout.includes(
        "Apply this complete state?"
      ),
      false
    );
    assert.equal(
      blocked.stdout.includes("[y/N]"),
      false
    );
  });
});

test("interactive candidate confirmation surfaces the complete state and defaults to rejection", async () => {
  await withGateRuntime(async ({ home, cwd, target }) => {
    const installed = await runGateCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, githubMode: "base" }
    );
    assert.equal(installed.code, 0);

    const rejected = await runInteractiveGateCli(
      ["update"],
      {
        home,
        cwd,
        githubMode: "versions",
        input: "n\n"
      }
    );

    assert.equal(rejected.code, 3);
    assert.match(
      rejected.stdout,
      new RegExp("Target: " + escapeRegExp(target))
    );
    assert.match(
      rejected.stdout,
      /Direct Install Requirements:/u
    );
    assert.match(rejected.stdout, /Sources:/u);
    assert.match(rejected.stdout, /Packages:/u);
    assert.match(
      rejected.stdout,
      /Dependency Edges:/u
    );
    assert.match(
      rejected.stdout,
      /Projections \/ Ownership:/u
    );
    assert.match(
      rejected.stdout,
      /Warnings \/ Special Risks:/u
    );
    assert.match(
      rejected.stdout,
      /Apply this complete state\? \[y\/N\]/u
    );
    assert.match(
      await readFile(
        join(target, "app", "SKILL.md"),
        "utf8"
      ),
      /Baseline application\./u
    );
  });
});

test(
  "SIGINT is shell-visible as exit code 130",
  { skip: process.platform === "win32" },
  async () => {
    await withGateRuntime(async ({ home, cwd }) => {
      const nodeCommand = [
        process.execPath,
        "--import",
        HANG_PRELOAD,
        CLI_ENTRY,
        "search",
        "frontend",
        "--json"
      ].map(shellQuote).join(" ");
      const script = [
        nodeCommand + " & child=$!",
        "sleep 0.2",
        "kill -INT \"$child\"",
        "wait \"$child\"",
        "exit $?"
      ].join("; ");

      const result = await runBash(script, {
        home,
        cwd
      });
      assert.equal(result.code, 130);
      assert.equal(result.signal, null);
    });
  }
);

test("Catalog failure remains isolated from explicit GitHub install update sync and repair", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const failedSearch = await runGateCli(
      ["search", "frontend", "--json"],
      {
        home,
        cwd,
        combinedPreloads: true,
        skillsmpMode: "network",
        githubMode: "base"
      }
    );
    assert.equal(failedSearch.code, 1);
    const searchOutput = parseJson<FailureEnvelope>(
      failedSearch.stdout
    );
    assert.equal(
      searchOutput.error.code,
      "SkillsMpSearchFailed"
    );

    const installed = await runGateCli(
      ["install", "acme/app/app", "--yes", "--json"],
      {
        home,
        cwd,
        combinedPreloads: true,
        skillsmpMode: "network",
        githubMode: "base"
      }
    );
    assert.equal(installed.code, 0);

    const updated = await runGateCli(
      ["update", "--yes", "--json"],
      {
        home,
        cwd,
        combinedPreloads: true,
        skillsmpMode: "network",
        githubMode: "versions"
      }
    );
    assert.equal(updated.code, 0);

    for (const command of ["sync", "repair"]) {
      const maintained = await runGateCli(
        [command, "--json"],
        {
          home,
          cwd,
          combinedPreloads: true,
          skillsmpMode: "network",
          githubMode: "forbid-network"
        }
      );
      assert.equal(
        maintained.code,
        0,
        command
      );
      assertNoUnexpectedStderr(maintained.stderr);
    }
  });
});

function runBash(
  script: string,
  options: Readonly<{
    home: string;
    cwd: string;
  }>
): Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "/bin/bash",
      ["-c", script],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          HOME: options.home,
          USERPROFILE: options.home
        },
        stdio: ["ignore", "ignore", "ignore"]
      }
    );
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveResult({ code, signal });
    });
  });
}

function shellQuote(source: string): string {
  return "'" + source.replace(/'/gu, "'\\''") + "'";
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^(){}$|[\]\\]/gu, "\\$&");
}
