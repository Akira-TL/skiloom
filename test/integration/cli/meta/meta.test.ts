import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  CANONICAL_CLI_COMMANDS,
  CLI_HELP_SPECS
} from "../../../../src/cli/meta/index.js";
import {
  assertNoUnexpectedStderr,
  parseJson,
  runGateCli,
  withGateRuntime
} from "../gate/fixture.js";

type FailureEnvelope = Readonly<{
  schema: string;
  ok: false;
  command: string;
  error: Readonly<{
    code: string;
    facts: Readonly<{ reason?: string }>;
  }>;
  warnings: ReadonlyArray<unknown>;
}>;

test("bare invocation top-level help aliases and installed-package version are human meta surfaces", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const bare = await runGateCli([], { home, cwd });
    const help = await runGateCli(["--help"], { home, cwd });
    const shortHelp = await runGateCli(["-h"], { home, cwd });

    for (const result of [bare, help, shortHelp]) {
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assertNoUnexpectedStderr(result.stderr);
      assert.match(result.stdout, /^Usage:\n/u);
      assert.doesNotMatch(result.stdout, /^\{/u);
      for (const command of CANONICAL_CLI_COMMANDS) {
        assert.match(result.stdout, new RegExp("\\b" + command + "\\b", "u"));
      }
    }
    assert.equal(bare.stdout, help.stdout);
    assert.equal(shortHelp.stdout, help.stdout);

    const packageJson = JSON.parse(
      await readFile("package.json", "utf8")
    ) as { version: string };
    const version = await runGateCli(["--version"], { home, cwd });
    const shortVersion = await runGateCli(["-V"], { home, cwd });
    for (const result of [version, shortVersion]) {
      assert.equal(result.code, 0);
      assertNoUnexpectedStderr(result.stderr);
      assert.equal(
        result.stdout,
        "skiloom " + packageJson.version + "\n"
      );
    }
    assert.equal(existsSync(join(home, ".skiloom")), false);
    assert.equal(existsSync(join(cwd, ".agents")), false);
  });
});

test("every canonical command help alias short-circuits invalid operands before network lock Registry or Target work", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    for (const command of CANONICAL_CLI_COMMANDS) {
      for (const helpFlag of ["--help", "-h"]) {
        const result = await runGateCli(
          [command, "__intentionally_invalid__", helpFlag, "--force"],
          {
            home,
            cwd,
            githubMode: "forbid-network",
            skillsmpMode: "network",
            combinedPreloads: true
          }
        );
        assert.equal(result.code, 0, command + " " + helpFlag);
        assertNoUnexpectedStderr(result.stderr);
        assert.match(result.stdout, /^Usage:\n/u);
        assert.match(
          result.stdout,
          new RegExp(
            escapeRegExp(CLI_HELP_SPECS[command].usage),
            "u"
          )
        );
        assert.match(result.stdout, /--help, -h/u);
        assert.doesNotMatch(result.stdout, /^\{/u);
        assert.equal(existsSync(join(home, ".skiloom")), false);
        assert.equal(existsSync(join(cwd, ".agents")), false);
      }
    }
  });
});

test("help and version mixed with JSON keep existing InvalidArguments machine behavior", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    for (const args of [
      ["--help", "--json"],
      ["--version", "--json"],
      ["install", "--help", "--json"]
    ]) {
      const result = await runGateCli(args, { home, cwd });
      assert.equal(result.code, 2, args.join(" "));
      const output = parseJson<FailureEnvelope>(result.stdout);
      assert.equal(output.schema, "SKILOOM-CLI-V1");
      assert.equal(output.ok, false);
      assert.equal(output.error.code, "InvalidArguments");
      assert.match(
        output.error.facts.reason ?? "",
        /help\/version meta output/u
      );
      assert.deepEqual(output.warnings, []);
    }
  });
});

test("help stays a non-command and install --version remains an install option", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const helpCommand = await runGateCli(
      ["help", "--json"],
      { home, cwd }
    );
    assert.equal(helpCommand.code, 2);
    const helpOutput = parseJson<FailureEnvelope>(
      helpCommand.stdout
    );
    assert.equal(
      helpOutput.error.facts.reason,
      "unknown or missing command"
    );

    const install = await runGateCli(
      [
        "install",
        "acme/app/app",
        "--version",
        "^1.0",
        "--plan",
        "--json"
      ],
      { home, cwd, githubMode: "base" }
    );
    assert.equal(install.code, 0);
    const installOutput = parseJson<{
      command: string;
      result: {
        directRequirements: ReadonlyArray<{
          versionRequirement?: string;
        }>;
      };
    }>(install.stdout);
    assert.equal(installOutput.command, "install");
    assert.equal(
      installOutput.result.directRequirements[0]?.versionRequirement,
      "^1.0"
    );
  });
});

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^(){}$|[\]\\]/gu, "\\$&");
}
