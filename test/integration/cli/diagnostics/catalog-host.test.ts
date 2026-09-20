import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  assertNoUnexpectedStderr,
  parseJson,
  runGateCli,
  withGateRuntime
} from "../gate/fixture.js";

type WarningFact = Readonly<{
  code: string;
  facts: Readonly<Record<string, unknown>>;
}>;

type SearchEnvelope = Readonly<{
  ok: boolean;
  result?: Readonly<{
    provider: string;
  }>;
  error?: Readonly<{
    code: string;
    facts: Readonly<{
      provider: string;
      reason: string;
      status: number | null;
      action: string;
      retryable: boolean;
      fallback: string;
    }>;
  }>;
  warnings: ReadonlyArray<WarningFact>;
}>;

type TargetEnvelope = Readonly<{
  ok: boolean;
  result: Readonly<{
    target: Readonly<{
      path: string;
      source: string;
      host: string | null;
      scope: string;
    }>;
  }>;
  warnings: ReadonlyArray<WarningFact>;
}>;

const HOST_HINTS = {
  codex: {
    kind: "capability",
    hint: "directory-symlink-documented"
  },
  claude: {
    kind: "capability",
    hint: "directory-symlink-documented"
  },
  gemini: {
    kind: "capability",
    hint: "directory-symlink-documented"
  },
  opencode: {
    kind: "risk",
    hint: "directory-symlink-worktree-not-guaranteed"
  }
} as const;

test("SkillsMP failure facts are stable actionable and credential-safe", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const cases = [
      {
        mode: "authentication",
        reason: "authentication",
        status: 401,
        action: "check-credentials",
        retryable: false
      },
      {
        mode: "rate-limit",
        reason: "rate-limit",
        status: 429,
        action: "retry-later",
        retryable: true
      },
      {
        mode: "incompatible-response",
        reason: "incompatible-response",
        status: 200,
        action: "update-client",
        retryable: false
      },
      {
        mode: "timeout",
        reason: "timeout",
        status: null,
        action: "retry",
        retryable: true
      }
    ] as const;

    for (const expected of cases) {
      const result = await runGateCli(
        ["search", "frontend", "--json"],
        {
          home,
          cwd,
          combinedPreloads: true,
          skillsmpMode: expected.mode
        }
      );

      assert.equal(result.code, 1, expected.mode);
      assertNoUnexpectedStderr(result.stderr);
      const output = parseJson<SearchEnvelope>(
        result.stdout
      );
      assert.equal(output.ok, false);
      assert.equal(
        output.error?.code,
        "SkillsMpSearchFailed"
      );
      assert.deepEqual(output.error?.facts, {
        provider: "skillsmp",
        reason: expected.reason,
        status: expected.status,
        action: expected.action,
        retryable: expected.retryable,
        fallback: "explicit-github-coordinate"
      });
      assert.deepEqual(output.warnings, [
        {
          code: "CatalogProviderProvenance",
          facts: {
            provider: "skillsmp",
            role: "discovery-only"
          }
        }
      ]);
      assert.equal(
        result.stdout.includes(
          "secret-token-that-must-not-leak"
        ),
        false
      );
      assert.equal(
        result.stdout.includes(
          "secret-key-must-not-leak"
        ),
        false
      );
    }
  });
});

test("SkillsMP human failures give actionable provider-specific guidance", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const cases = [
      [
        "authentication",
        /check SKILLSMP_API_KEY/iu
      ],
      [
        "rate-limit",
        /retry later/iu
      ],
      [
        "incompatible-response",
        /update Skiloom/iu
      ],
      [
        "timeout",
        /retry the search/iu
      ]
    ] as const;

    for (const [mode, message] of cases) {
      const result = await runGateCli(
        ["search", "frontend"],
        {
          home,
          cwd,
          combinedPreloads: true,
          skillsmpMode: mode
        }
      );

      assert.equal(result.code, 1, mode);
      assert.match(result.stderr, /SkillsMP/u);
      assert.match(result.stderr, message);
      assert.match(
        result.stderr,
        /explicit GitHub coordinate/iu
      );
      assert.equal(
        result.stderr.includes(
          "secret-token-that-must-not-leak"
        ),
        false
      );
      assert.equal(
        result.stderr.includes(
          "secret-key-must-not-leak"
        ),
        false
      );
    }
  });
});

test("search success keeps provider provenance in top-level warnings", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const result = await runGateCli(
      ["search", "frontend", "--json"],
      {
        home,
        cwd,
        combinedPreloads: true,
        skillsmpMode: "success"
      }
    );

    assert.equal(result.code, 0);
    const output = parseJson<SearchEnvelope>(
      result.stdout
    );
    assert.equal(output.result?.provider, "skillsmp");
    assert.deepEqual(output.warnings, [
      {
        code: "CatalogProviderProvenance",
        facts: {
          provider: "skillsmp",
          role: "discovery-only"
        }
      }
    ]);
  });
});

test("every Host preset reports provenance-bearing capability or risk hints without filesystem mutation", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    for (
      const [host, hint] of Object.entries(HOST_HINTS)
    ) {
      const result = await runGateCli(
        [
          "status",
          "--host",
          host,
          "--json"
        ],
        { home, cwd }
      );

      assert.equal(result.code, 0, host);
      const output = parseJson<TargetEnvelope>(
        result.stdout
      );
      assert.equal(output.result.target.host, host);
      assert.equal(
        output.result.target.source,
        "host"
      );
      assert.deepEqual(output.warnings, [
        {
          code: "HostPresetHint",
          facts: {
            host,
            scope: "workspace",
            kind: hint.kind,
            hint: hint.hint,
            provenance: "host-target-presets-v0"
          }
        }
      ]);
    }

    assert.equal(
      existsSync(join(cwd, ".agents")),
      false
    );
    assert.equal(
      existsSync(join(cwd, ".claude")),
      false
    );
    assert.equal(
      existsSync(join(cwd, ".gemini")),
      false
    );
    assert.equal(
      existsSync(join(cwd, ".opencode")),
      false
    );
  });
});

test("doctor carries Host warning provenance separately from diagnostics", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const result = await runGateCli(
      [
        "doctor",
        "--host",
        "opencode",
        "--json"
      ],
      { home, cwd }
    );

    assert.equal(result.code, 0);
    const output = parseJson<TargetEnvelope>(
      result.stdout
    );
    assert.equal(
      output.result.target.host,
      "opencode"
    );
    assert.deepEqual(output.warnings, [
      {
        code: "HostPresetHint",
        facts: {
          host: "opencode",
          scope: "workspace",
          kind: "risk",
          hint:
            "directory-symlink-worktree-not-guaranteed",
          provenance: "host-target-presets-v0"
        }
      }
    ]);
    assert.equal(
      existsSync(join(cwd, ".agents")),
      false
    );
  });
});

test("human Host diagnostics surface risk without changing Target semantics", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const result = await runGateCli(
      ["status", "--host", "opencode"],
      { home, cwd }
    );

    assert.equal(result.code, 0);
    assert.match(
      result.stdout,
      new RegExp(
        "Target: " +
        escapeRegExp(
          join(cwd, ".agents", "skills")
        )
      )
    );
    assert.match(
      result.stderr,
      /Warning \[opencode\]/u
    );
    assert.match(
      result.stderr,
      /symlink discovery is not guaranteed/iu
    );
    assert.match(
      result.stderr,
      /does not choose Skiloom Target materialization/iu
    );
    assert.equal(
      existsSync(join(cwd, ".opencode")),
      false
    );
  });
});

test("OpenCode risk hints do not choose Target materialization or mutate host configuration", async () => {
  await withGateRuntime(async ({ home, cwd }) => {
    const installed = await runGateCli(
      [
        "install",
        "acme/app/app",
        "--host",
        "opencode",
        "--yes",
        "--json"
      ],
      {
        home,
        cwd,
        githubMode: "base"
      }
    );

    assert.equal(installed.code, 0);
    const activation = join(
      cwd,
      ".agents",
      "skills",
      "app"
    );
    const stat = await lstat(activation);
    if (process.platform !== "win32") {
      assert.equal(
        stat.isSymbolicLink(),
        true,
        "Host hint must not override generic Linux link materialization"
      );
    }
    assert.equal(
      existsSync(join(cwd, ".opencode")),
      false
    );
  });
});

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^(){}$|[\]\\]/gu, "\\$&");
}
