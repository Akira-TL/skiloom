import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/skillsmp-fetch.mjs"
);

test("search --json normalizes SkillsMP discovery candidates without provider authority fields", async () => {
  const result = await runCli(["search", "frontend", "--json"], "success");

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: "SKILOOM-CLI-V1",
    ok: true,
    command: "search",
    result: {
      provider: "skillsmp",
      query: "frontend",
      candidates: [
        {
          provider: "skillsmp",
          providerEntryId: "skill-1",
          name: "frontend-design",
          description: "Design guidance",
          displayUrl: "https://skillsmp.com/skills/frontend-design",
          githubRepository: "anthropics/skills",
          githubPackagePathHint: "skills/frontend-design",
          installable: true,
          signals: [
            { provider: "skillsmp", kind: "stars", value: 12345 },
            { provider: "skillsmp", kind: "language", value: "en" },
            {
              provider: "skillsmp",
              kind: "updated-at",
              value: "2026-09-18T00:00:00Z"
            }
          ]
        },
        {
          provider: "skillsmp",
          providerEntryId: "skill-2",
          name: "catalog-only",
          description: "No GitHub source",
          displayUrl: "https://skillsmp.com/skills/catalog-only",
          githubRepository: null,
          githubPackagePathHint: null,
          installable: false,
          signals: [
            { provider: "skillsmp", kind: "stars", value: 8 },
            { provider: "skillsmp", kind: "language", value: "zh" },
            {
              provider: "skillsmp",
              kind: "updated-at",
              value: "2026-09-17T00:00:00Z"
            }
          ]
        }
      ]
    },
    warnings: []
  });
});

test("malformed GitHub path hints remain display-only instead of escaping structured search results", async () => {
  const result = await runCli(
    ["search", "malformed", "--json"],
    "malformed-github-url"
  );

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout) as {
    result: {
      candidates: Array<{
        githubRepository: string | null;
        githubPackagePathHint: string | null;
        installable: boolean;
      }>;
    };
  };
  assert.deepEqual(output.result.candidates[0], {
    provider: "skillsmp",
    providerEntryId: "skill-malformed",
    name: "malformed-github-url",
    description: "Malformed path hint must stay display-only.",
    displayUrl: "https://skillsmp.com/skills/malformed",
    githubRepository: null,
    githubPackagePathHint: null,
    installable: false,
    signals: [
      { provider: "skillsmp", kind: "stars", value: 1 },
      { provider: "skillsmp", kind: "language", value: "en" },
      {
        provider: "skillsmp",
        kind: "updated-at",
        value: "2026-09-19T00:00:00Z"
      }
    ]
  });
});

test("search failures stay structured and secret-safe", async () => {
  const cases = [
    ["authentication", "authentication", 401],
    ["rate-limit", "rate-limit", 429],
    ["incompatible-response", "incompatible-response", 200],
    ["network", "network", null],
    ["timeout", "timeout", null]
  ] as const;

  for (const [mode, reason, status] of cases) {
    const result = await runCli(["search", "frontend", "--json"], mode);

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout) as {
      schema: string;
      ok: boolean;
      command: string;
      error: {
        code: string;
        facts: {
          provider: string;
          reason: string;
          status: number | null;
        };
      };
      warnings: unknown[];
    };
    assert.deepEqual(output, {
      schema: "SKILOOM-CLI-V1",
      ok: false,
      command: "search",
      error: {
        code: "SkillsMpSearchFailed",
        facts: {
          provider: "skillsmp",
          reason,
          status
        }
      },
      warnings: []
    });
    assert.equal(
      result.stdout.includes("secret-token-that-must-not-leak"),
      false
    );
    assert.equal(
      result.stdout.includes("secret-key-must-not-leak"),
      false
    );
  }
});

test("search human output keeps SkillsMP provenance and display-only status visible", async () => {
  const result = await runCli(["search", "frontend"], "success");

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    [
      "[SkillsMP] frontend-design — anthropics/skills",
      "[SkillsMP] catalog-only — display-only",
      ""
    ].join("\n")
  );
});

test("search requires exactly one non-empty query", async () => {
  for (const args of [
    ["search", "--json"],
    ["search", "one", "two", "--json"]
  ]) {
    const result = await runCli(args, "success");
    assert.equal(result.code, 2);
    const output = JSON.parse(result.stdout) as {
      error: { code: string };
    };
    assert.equal(output.error.code, "InvalidArguments");
  }
});

function runCli(
  args: ReadonlyArray<string>,
  mode: string
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
        cwd: process.cwd(),
        env: {
          ...process.env,
          SKILOOM_TEST_SKILLSMP_MODE: mode
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
