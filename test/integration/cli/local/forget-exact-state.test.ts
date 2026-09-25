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

test("sync accepts a forgotten renamed dependency projection", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    for (const args of [
      ["install", "acme/app/app", "--yes", "--json"],
      ["rename", "acme/shared/shared", "shared-local", "--json"],
      ["detach", "acme/shared/shared", "--json"]
    ]) {
      const result = await runCli(args, {
        home,
        cwd,
        mode: args[0] === "install"
          ? "shared-remove"
          : "forbid-network"
      });
      assert.equal(result.code, 0, result.stderr || result.stdout);
    }

    await writeFile(
      join(target, "shared-local", "USER-NOTE"),
      "forgotten renamed dependency bytes\n",
      "utf8"
    );

    const forgotten = await runCli(
      ["forget", "acme/shared/shared", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(forgotten.code, 0, forgotten.stderr || forgotten.stdout);

    const status = await runCli(
      ["status", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(status.code, 0, status.stderr || status.stdout);
    const statusOutput = JSON.parse(status.stdout) as {
      result: {
        marker: {
          generation: number;
          managed: ReadonlyArray<{
            packageCoordinate: string;
            transformJson: string | null;
          }>;
          detached: ReadonlyArray<unknown>;
        };
        registry: {
          generation: number;
          projections: number;
          detached: number;
        };
      };
    };
    assert.equal(statusOutput.result.marker.generation, 4);
    assert.equal(statusOutput.result.marker.managed.length, 1);
    assert.equal(
      statusOutput.result.marker.managed[0]?.packageCoordinate,
      "acme/app/app"
    );
    assert.equal(
      statusOutput.result.marker.managed[0]?.transformJson,
      null
    );
    assert.deepEqual(statusOutput.result.marker.detached, []);
    assert.equal(statusOutput.result.registry.generation, 4);
    assert.equal(statusOutput.result.registry.projections, 1);
    assert.equal(statusOutput.result.registry.detached, 0);
    assert.doesNotMatch(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /SKILOOM-DEPENDENCY-ROUTING-V1/u
    );
    assert.equal(
      await readFile(
        join(target, "shared-local", "USER-NOTE"),
        "utf8"
      ),
      "forgotten renamed dependency bytes\n"
    );

    for (const command of ["sync", "repair"] as const) {
      const maintained = await runCli(
        [command, "--json"],
        { home, cwd, mode: "forbid-network" }
      );
      assert.equal(
        maintained.code,
        0,
        maintained.stderr || maintained.stdout
      );
      const output = JSON.parse(maintained.stdout) as {
        ok: boolean;
        result: {
          status: string;
          generation: number;
        };
      };
      assert.equal(output.ok, true);
      assert.equal(output.result.status, "no-op");
      assert.equal(output.result.generation, 4);
    }
  });
});

test("requirement add preserves forgotten projection absence and user bytes", async () => {
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
      "forgotten bytes survive later add\n",
      "utf8"
    );
    assert.equal(
      (
        await runCli(
          ["forget", "acme/app/app", "--json"],
          { home, cwd, mode: "forbid-network" }
        )
      ).code,
      0
    );

    const added = await runCli(
      [
        "install",
        "acme/suite/alpha",
        "--yes",
        "--json"
      ],
      { home, cwd, mode: "base" }
    );

    assert.equal(added.code, 0);
    const output = JSON.parse(added.stdout) as {
      result: {
        acceptedState: { generation: number } | null;
        packages: ReadonlyArray<{
          packageCoordinate: string;
        }>;
        projections: ReadonlyArray<{
          packageCoordinate: string;
          ownership: string;
        }>;
      };
    };
    assert.equal(output.result.acceptedState?.generation, 4);
    assert.deepEqual(
      output.result.packages.map(
        (entry) => entry.packageCoordinate
      ),
      ["acme/app/app", "acme/suite/alpha"]
    );
    assert.deepEqual(output.result.projections, [
      {
        packageCoordinate: "acme/suite/alpha",
        activationName: "alpha",
        ownership: "managed"
      }
    ]);
    assert.equal(
      await readFile(
        join(target, "app", "USER-NOTE"),
        "utf8"
      ),
      "forgotten bytes survive later add\n"
    );
    assert.match(
      await readFile(
        join(target, "alpha", "SKILL.md"),
        "utf8"
      ),
      /Alpha package\./u
    );
  });
});

test("remove can drop a forgotten direct requirement without deleting user bytes", async () => {
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
      "forgotten bytes survive logical removal\n",
      "utf8"
    );
    assert.equal(
      (
        await runCli(
          ["forget", "acme/app/app", "--json"],
          { home, cwd, mode: "forbid-network" }
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
      { home, cwd, mode: "base" }
    );

    assert.equal(removed.code, 0);
    const output = JSON.parse(removed.stdout) as {
      result: {
        acceptedState: { generation: number } | null;
        directRequirements: ReadonlyArray<unknown>;
        packages: ReadonlyArray<unknown>;
        projections: ReadonlyArray<unknown>;
      };
    };
    assert.equal(output.result.acceptedState?.generation, 4);
    assert.deepEqual(output.result.directRequirements, []);
    assert.deepEqual(output.result.packages, []);
    assert.deepEqual(output.result.projections, []);
    assert.equal(
      await readFile(
        join(target, "app", "USER-NOTE"),
        "utf8"
      ),
      "forgotten bytes survive logical removal\n"
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
