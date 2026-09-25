import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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

const PRIMARY_TOKEN = "skiloom-gh-token-primary-sentinel";
const FALLBACK_TOKEN = "skiloom-github-token-fallback-sentinel";

test("GitHub API credential precedence covers release metadata anonymous access and credential-safe errors", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    const release = await runCli(
      [
        "install",
        "acme/app/app",
        "--plan",
        "--json"
      ],
      {
        home,
        cwd,
        mode: "base",
        ghToken: PRIMARY_TOKEN,
        githubToken: FALLBACK_TOKEN,
        expectedBearer: PRIMARY_TOKEN
      }
    );
    assert.equal(release.code, 0);
    assertCredentialSafe(release, PRIMARY_TOKEN);
    assertCredentialSafe(release, FALLBACK_TOKEN);


    const anonymous = await runCli(
      [
        "install",
        "acme/app/app",
        "--plan",
        "--json"
      ],
      {
        home,
        cwd,
        mode: "base",
        forbidAuthorization: true
      }
    );
    assert.equal(anonymous.code, 0);

    const denied = await runCli(
      [
        "install",
        "missing/repo/pkg",
        "--plan",
        "--json"
      ],
      {
        home,
        cwd,
        mode: "base",
        ghToken: PRIMARY_TOKEN,
        expectedBearer: PRIMARY_TOKEN
      }
    );
    assert.equal(denied.code, 1);
    assertCredentialSafe(denied, PRIMARY_TOKEN);
    const deniedOutput = JSON.parse(denied.stdout) as {
      error: {
        code: string;
        facts: { status: number };
      };
    };
    assert.equal(
      deniedOutput.error.code,
      "SourceAccessUnavailable"
    );
    assert.equal(deniedOutput.error.facts.status, 404);
  });
});

test("install update bootstrap and remove propagate the selected GitHub credential", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    const installed = await runCli(
      [
        "install",
        "acme/app/app",
        "--yes",
        "--json"
      ],
      credentialOptions(home, cwd, "base")
    );
    assert.equal(installed.code, 0);
    assertCredentialSafe(installed, PRIMARY_TOKEN);

    const updated = await runCli(
      ["update", "--yes", "--json"],
      credentialOptions(home, cwd, "versions")
    );
    assert.equal(updated.code, 0);
    assertCredentialSafe(updated, PRIMARY_TOKEN);

    const bootstrap = await runCli(
      [
        "bootstrap",
        "--target",
        join(cwd, "bootstrap-target"),
        "--plan",
        "--json"
      ],
      credentialOptions(home, cwd, "first-party")
    );
    assert.equal(bootstrap.code, 0);
    assertCredentialSafe(bootstrap, PRIMARY_TOKEN);
  });

  await withCliRuntime(async ({ home, cwd }) => {
    assert.equal(
      (
        await runCli(
          [
            "install",
            "acme/app/app",
            "--yes",
            "--json"
          ],
          credentialOptions(home, cwd, "shared-remove")
        )
      ).code,
      0
    );
    assert.equal(
      (
        await runCli(
          [
            "install",
            "acme/tool/tool",
            "--yes",
            "--json"
          ],
          credentialOptions(home, cwd, "shared-remove")
        )
      ).code,
      0
    );

    const removed = await runCli(
      [
        "remove",
        "acme/app/app",
        "--yes",
        "--json"
      ],
      credentialOptions(home, cwd, "shared-remove")
    );
    assert.equal(removed.code, 0);
    assertCredentialSafe(removed, PRIMARY_TOKEN);
  });
});

test("recover and fork propagate the selected GitHub credential", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          [
            "install",
            "acme/app/app",
            "--yes",
            "--json"
          ],
          credentialOptions(home, cwd, "base")
        )
      ).code,
      0
    );
    await deleteRegistry(home);

    const recovered = await runCli(
      ["recover", "--plan", "--json"],
      credentialOptions(home, cwd, "base")
    );
    assert.equal(recovered.code, 0);
    assertCredentialSafe(recovered, PRIMARY_TOKEN);
    assert.equal(
      await pathExists(
        join(home, ".skiloom", "registry.sqlite3")
      ),
      false
    );
    assert.equal(await pathExists(target), true);
  });

  await withCliRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          [
            "install",
            "acme/app/app",
            "--yes",
            "--json"
          ],
          credentialOptions(home, cwd, "base")
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copied-target");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });
    assert.equal(
      (
        await runCli(
          ["update", "--yes", "--json"],
          credentialOptions(home, cwd, "versions")
        )
      ).code,
      0
    );

    const forked = await runCli(
      [
        "fork",
        "--target",
        copyTarget,
        "--plan",
        "--json"
      ],
      credentialOptions(home, cwd, "base")
    );
    assert.equal(forked.code, 0);
    assertCredentialSafe(forked, PRIMARY_TOKEN);
  });
});

test("repair reacquires exact private-source content with the selected credential", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      [
        "install",
        "acme/app/app",
        "--yes",
        "--json"
      ],
      credentialOptions(home, cwd, "base")
    );
    assert.equal(installed.code, 0);
    const output = JSON.parse(installed.stdout) as {
      result: {
        packages: ReadonlyArray<{
          contentDigest: string;
        }>;
      };
    };
    const digest = output.result.packages[0]?.contentDigest;
    assert.notEqual(digest, undefined);

    await rm(join(target, "app"), {
      recursive: true,
      force: true
    });
    await rm(
      join(
        home,
        ".skiloom",
        "store",
        "sha256-" + digest!.slice("sha256:".length)
      ),
      {
        recursive: true,
        force: true
      }
    );
    await rm(
      join(home, ".skiloom", "cache", "sources"),
      {
        recursive: true,
        force: true
      }
    );

    const repaired = await runCli(
      ["repair", "--json"],
      credentialOptions(home, cwd, "exact-only")
    );
    assert.equal(repaired.code, 0);
    assertCredentialSafe(repaired, PRIMARY_TOKEN);
    assert.equal(
      await pathExists(join(target, "app", "SKILL.md")),
      true
    );
  });
});

test("credential bytes never enter Skiloom state cache marker or exact export", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      [
        "install",
        "acme/app/app",
        "--yes",
        "--json"
      ],
      credentialOptions(home, cwd, "base")
    );
    assert.equal(installed.code, 0);
    assertCredentialSafe(installed, PRIMARY_TOKEN);

    const exported = await runCli(
      [
        "export",
        "credential-check.skiloom-export",
        "--json"
      ],
      {
        home,
        cwd,
        mode: "forbid-network",
        ghToken: PRIMARY_TOKEN
      }
    );
    assert.equal(exported.code, 0);
    assertCredentialSafe(exported, PRIMARY_TOKEN);

    await assertTreeExcludes(home, PRIMARY_TOKEN);
    await assertTreeExcludes(target, PRIMARY_TOKEN);
    assert.equal(
      (
        await readFile(
          join(cwd, "credential-check.skiloom-export")
        )
      ).includes(Buffer.from(PRIMARY_TOKEN, "utf8")),
      false
    );
  });
});

function credentialOptions(
  home: string,
  cwd: string,
  mode: string
): RunCliOptions {
  return {
    home,
    cwd,
    mode,
    ghToken: PRIMARY_TOKEN,
    expectedBearer: PRIMARY_TOKEN
  };
}

function assertCredentialSafe(
  result: Readonly<{
    stdout: string;
    stderr: string;
  }>,
  credential: string
): void {
  assert.equal(result.stdout.includes(credential), false);
  assert.equal(result.stderr.includes(credential), false);
}

async function assertTreeExcludes(
  root: string,
  text: string
): Promise<void> {
  const needle = Buffer.from(text, "utf8");
  const entries = await readdir(root, {
    withFileTypes: true
  });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await assertTreeExcludes(path, text);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const bytes = await readFile(path);
    assert.equal(
      bytes.includes(needle),
      false,
      "credential leaked into " + path
    );
  }
}

async function deleteRegistry(home: string): Promise<void> {
  const root = join(home, ".skiloom");
  await Promise.all(
    [
      "registry.sqlite3",
      "registry.sqlite3-shm",
      "registry.sqlite3-wal"
    ].map((name) =>
      rm(join(root, name), { force: true })
    )
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    try {
      const entries = await readdir(path);
      return Array.isArray(entries);
    } catch {
      return false;
    }
  }
}

async function withCliRuntime(
  run: (input: Readonly<{
    home: string;
    cwd: string;
    target: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(
    join(tmpdir(), "skiloom-cli-github-credential-")
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

type RunCliOptions = Readonly<{
  home: string;
  cwd: string;
  mode: string;
  ghToken?: string;
  githubToken?: string;
  expectedBearer?: string;
  forbidAuthorization?: boolean;
}>;

function runCli(
  args: ReadonlyArray<string>,
  options: RunCliOptions
): Promise<Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolveResult, reject) => {
    const {
      GH_TOKEN: _discardGhToken,
      GITHUB_TOKEN: _discardGithubToken,
      SKILOOM_TEST_EXPECT_GITHUB_BEARER:
        _discardExpectedBearer,
      SKILOOM_TEST_FORBID_GITHUB_AUTH:
        _discardForbidAuthorization,
      ...baseEnvironment
    } = process.env;

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
          ...baseEnvironment,
          HOME: options.home,
          USERPROFILE: options.home,
          SKILOOM_LOCK_TEST_BINARY: LOCK_HELPER,
          SKILOOM_TEST_GITHUB_MODE: options.mode,
          ...(options.ghToken === undefined
            ? {}
            : { GH_TOKEN: options.ghToken }),
          ...(options.githubToken === undefined
            ? {}
            : { GITHUB_TOKEN: options.githubToken }),
          ...(options.expectedBearer === undefined
            ? {}
            : {
                SKILOOM_TEST_EXPECT_GITHUB_BEARER:
                  options.expectedBearer
              }),
          ...(options.forbidAuthorization === true
            ? { SKILOOM_TEST_FORBID_GITHUB_AUTH: "1" }
            : {})
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
      resolveResult({
        code,
        stdout,
        stderr
      });
    });
  });
}
