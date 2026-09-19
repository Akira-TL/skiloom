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

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve("native/skiloom-lock/target/debug/skiloom-lock");

type ParsedMaintenanceOutput = Readonly<{
  ok: boolean;
  error?: Readonly<{
    code: string;
    facts: Readonly<Record<string, unknown>>;
  }>;
  result: Readonly<{
    status: string;
    targetId: string;
    generation: number;
    repairedPackages: ReadonlyArray<string>;
  }>;
}>;

test("sync human output distinguishes exact no-op state without approval", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const synced = await runCli(
      ["sync"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(synced.code, 0);
    assert.match(
      synced.stdout,
      new RegExp("Target: " + escapeRegExp(target))
    );
    assert.match(synced.stdout, /Status: no-op/u);
    assert.match(synced.stdout, /Generation: 1/u);
    assert.match(synced.stdout, /Repaired Packages:\n- none/u);
  });
});

test("sync and repair fail closed on foreign replacement bytes instead of adopting them", async () => {
  for (const command of ["sync", "repair"] as const) {
    await withCliRuntime(async ({ home, cwd, target }) => {
      const installed = await runCli(
        ["install", "acme/app/app", "--yes", "--json"],
        { home, cwd, mode: "base" }
      );
      assert.equal(installed.code, 0);
      await rm(join(target, "app"), {
        recursive: true,
        force: true
      });
      await mkdir(join(target, "app"));
      await writeFile(
        join(target, "app", "KEEP"),
        "user-owned replacement bytes\n"
      );

      const maintained = await runCli(
        [command, "--json"],
        { home, cwd, mode: "forbid-network" }
      );

      assert.equal(maintained.code, 1);
      const output = parseMaintenanceOutput(
        maintained.stdout
      );
      assert.equal(output.ok, false);
      assert.equal(
        output.error?.code,
        "ManagedProjectionMaterializationMismatch"
      );
      assert.equal(
        await readFile(join(target, "app", "KEEP"), "utf8"),
        "user-owned replacement bytes\n"
      );
    });
  }
});

test("repair reconstructs missing Store and Target bytes from the accepted exact commit only", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    const installOutput = JSON.parse(installed.stdout) as {
      result: {
        packages: ReadonlyArray<{
          packageCoordinate: string;
          contentDigest: string;
        }>;
      };
    };
    const digest =
      installOutput.result.packages[0]?.contentDigest;
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
    await rm(join(home, ".skiloom", "cache", "sources"), {
      recursive: true,
      force: true
    });

    const repaired = await runCli(
      ["repair", "--json"],
      { home, cwd, mode: "exact-only" }
    );

    assert.equal(repaired.code, 0);
    assertNoUnexpectedStderr(repaired.stderr);
    const output = parseMaintenanceOutput(repaired.stdout);
    assert.equal(output.result.status, "repaired");
    assert.equal(output.result.generation, 1);
    assert.deepEqual(
      output.result.repairedPackages,
      ["acme/app/app"]
    );
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
    );
  });
});

test("repair is a no-op for exact Store Target and marker state without network", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const repaired = await runCli(
      ["repair", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(repaired.code, 0);
    assertNoUnexpectedStderr(repaired.stderr);
    const output = parseMaintenanceOutput(repaired.stdout);
    assert.equal(output.result.status, "no-op");
    assert.equal(output.result.generation, 1);
    assert.deepEqual(output.result.repairedPackages, []);
  });
});

test("sync is a no-op for an exact Target without network or approval", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);

    const synced = await runCli(
      ["sync", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(synced.code, 0);
    assertNoUnexpectedStderr(synced.stderr);
    const output = parseMaintenanceOutput(synced.stdout);
    assert.equal(output.result.status, "no-op");
    assert.equal(output.result.generation, 1);
    assert.equal(existsSync(join(target, "app")), true);
  });
});

test("sync restores the accepted marker generation without network resolution", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    await rm(join(target, ".skiloom-state"), {
      force: true
    });

    const synced = await runCli(
      ["sync", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(synced.code, 0);
    const output = parseMaintenanceOutput(synced.stdout);
    assert.equal(output.result.status, "synchronized");
    assert.equal(output.result.generation, 1);
    assert.equal(
      existsSync(join(target, ".skiloom-state")),
      true
    );
  });
});

test("sync restores a missing managed projection from accepted exact state without network or approval", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const installed = await runCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, mode: "base" }
    );
    assert.equal(installed.code, 0);
    await rm(join(target, "app"), {
      recursive: true,
      force: true
    });
    assert.equal(existsSync(join(target, "app")), false);

    const synced = await runCli(
      ["sync", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(synced.code, 0);
    assertNoUnexpectedStderr(synced.stderr);
    const output = parseMaintenanceOutput(synced.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.result.status, "synchronized");
    assert.equal(output.result.generation, 1);
    assert.equal(existsSync(join(target, "app")), true);
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Baseline application\./u
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
    join(tmpdir(), "skiloom-cli-sync-repair-")
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

function parseMaintenanceOutput(
  source: string
): ParsedMaintenanceOutput {
  return JSON.parse(source) as ParsedMaintenanceOutput;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^(){}$|[\]\\]/gu, "\\$&");
}

function assertNoUnexpectedStderr(stderr: string): void {
  const normalized = stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u,
    ""
  );
  assert.equal(normalized, "");
}
