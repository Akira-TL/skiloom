import assert from "node:assert/strict";
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

test("sync repair and doctor replay forgotten projection absence without adopting user bytes", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    assert.equal(
      (
        await runCli(
          ["detach", "acme/app/app", "--json"],
          { home, cwd, mode: "forbid-network" }
        )
      ).code,
      0
    );

    await writeFile(
      join(target, "app", "USER-NOTE"),
      "forgotten bytes remain user owned\n",
      "utf8"
    );

    const forgotten = await runCli(
      ["forget", "acme/app/app", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(forgotten.code, 0);
    const forgottenOutput = parseLocal(forgotten.stdout);
    assert.equal(forgottenOutput.result.generation, 3);
    assert.deepEqual(forgottenOutput.result.projections, []);

    const before = await statusFacts(home, cwd);
    assert.deepEqual(before, {
      generation: 3,
      packages: 1,
      projections: 0,
      detached: 0
    });

    const synced = await runCli(
      ["sync", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 0);
    const syncOutput = JSON.parse(synced.stdout) as {
      result: {
        status: string;
        generation: number;
        actions: ReadonlyArray<unknown>;
      };
    };
    assert.equal(syncOutput.result.status, "no-op");
    assert.equal(syncOutput.result.generation, 3);
    assert.deepEqual(syncOutput.result.actions, []);

    const repaired = await runCli(
      ["repair", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(repaired.code, 0);
    const repairOutput = JSON.parse(repaired.stdout) as {
      result: {
        status: string;
        generation: number;
        actions: ReadonlyArray<unknown>;
        repairedPackages: ReadonlyArray<string>;
        repairedProjections: ReadonlyArray<string>;
      };
    };
    assert.equal(repairOutput.result.status, "no-op");
    assert.equal(repairOutput.result.generation, 3);
    assert.deepEqual(repairOutput.result.actions, []);
    assert.deepEqual(repairOutput.result.repairedPackages, []);
    assert.deepEqual(repairOutput.result.repairedProjections, []);

    const doctor = await runCli(
      ["doctor", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(doctor.code, 0);
    const doctorOutput = JSON.parse(doctor.stdout) as {
      result: {
        status: string;
        diagnostics: ReadonlyArray<{
          code: string;
        }>;
      };
    };
    assert.equal(doctorOutput.result.status, "healthy");
    assert.equal(
      doctorOutput.result.diagnostics.some(
        (entry) =>
          entry.code === "ManagedProjectionMissing" ||
          entry.code === "ManagedProjectionDrift" ||
          entry.code === "RegistryIntegrityFailed"
      ),
      false
    );

    assert.deepEqual(
      await statusFacts(home, cwd),
      before
    );
    assert.equal(
      await readFile(
        join(target, "app", "USER-NOTE"),
        "utf8"
      ),
      "forgotten bytes remain user owned\n"
    );
  });
});

type LocalOutput = Readonly<{
  result: Readonly<{
    generation: number;
    projections: ReadonlyArray<unknown>;
  }>;
}>;

function parseLocal(source: string): LocalOutput {
  return JSON.parse(source) as LocalOutput;
}

async function statusFacts(
  home: string,
  cwd: string
): Promise<Readonly<{
  generation: number;
  packages: number;
  projections: number;
  detached: number;
}>> {
  const status = await runCli(
    ["status", "--json"],
    { home, cwd, mode: "forbid-network" }
  );
  assert.equal(status.code, 0);
  const parsed = JSON.parse(status.stdout) as {
    result: {
      registry: {
        generation: number;
        packages: number;
        projections: number;
        detached: number;
      } | null;
    };
  };
  assert.notEqual(parsed.result.registry, null);
  return {
    generation: parsed.result.registry!.generation,
    packages: parsed.result.registry!.packages,
    projections: parsed.result.registry!.projections,
    detached: parsed.result.registry!.detached
  };
}

async function withCliRuntime(
  run: (input: Readonly<{
    home: string;
    cwd: string;
    target: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(
    join(tmpdir(), "skiloom-cli-forget-exact-")
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
