import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  readTargetStateMarkerDocumentFile
} from "../../../../src/runtime/target-state-marker.js";

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve("native/skiloom-lock/target/debug/skiloom-lock");

type CliEnvelope = Readonly<{
  ok: boolean;
  error?: Readonly<{
    code: string;
    facts: Readonly<Record<string, unknown>>;
  }>;
  result: Readonly<{
    status: string;
    targetId: string;
    generation: number;
  }>;
}>;

test("sync registers an exact current copied Target without advancing generation and unblocks normal lifecycle", async () => {
  await withRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copy-current");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });

    const blocked = await runCli(
      [
        "update",
        "--target",
        copyTarget,
        "--yes",
        "--json"
      ],
      { home, cwd, mode: "versions" }
    );
    assert.equal(blocked.code, 1);
    assert.equal(
      parseEnvelope(blocked.stdout).error?.facts.reason,
      "target-location-mismatch"
    );

    const synced = await runCli(
      ["sync", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 0);
    const syncOutput = parseEnvelope(synced.stdout);
    assert.equal(syncOutput.result.status, "synchronized");
    assert.equal(syncOutput.result.generation, 1);

    const locations = registeredLocations(home);
    assert.deepEqual(
      locations.map((entry) => entry.path),
      [resolve(target), resolve(copyTarget)].sort(compareUtf8)
    );
    assert.deepEqual(
      locations.find(
        (entry) => entry.path === resolve(copyTarget)
      ),
      {
        path: resolve(copyTarget),
        observedGeneration: 1
      }
    );

    const doctor = await runCli(
      ["doctor", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(doctor.code, 0);
    const doctorOutput = JSON.parse(doctor.stdout) as {
      result: {
        diagnostics: ReadonlyArray<{ code: string }>;
      };
    };
    assert.equal(
      doctorOutput.result.diagnostics.some(
        (entry) => entry.code === "TargetLocationMismatch"
      ),
      false
    );

    const updated = await runCli(
      [
        "update",
        "--target",
        copyTarget,
        "--yes",
        "--json"
      ],
      { home, cwd, mode: "versions" }
    );
    assert.equal(updated.code, 0);
    const updateOutput = JSON.parse(updated.stdout) as {
      result: {
        acceptedState: { generation: number } | null;
      };
    };
    assert.equal(
      updateOutput.result.acceptedState?.generation,
      2
    );
  });
});

test("repair never adopts an unregistered copied Target and works only after sync registration", async () => {
  await withRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copy-repair-boundary");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });

    const blocked = await runCli(
      ["repair", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(blocked.code, 1);
    assert.equal(
      parseEnvelope(blocked.stdout).error?.code,
      "ExactStateTargetUnavailable"
    );
    assert.equal(
      parseEnvelope(blocked.stdout).error?.facts.reason,
      "target-location-mismatch"
    );
    assert.equal(
      registeredLocations(home).some(
        (entry) => entry.path === resolve(copyTarget)
      ),
      false
    );

    await rm(join(copyTarget, "app"), {
      recursive: true,
      force: true
    });
    await mkdir(join(copyTarget, "app"));
    await writeFile(
      join(copyTarget, "app", "KEEP"),
      "user replacement\n",
      "utf8"
    );
    const driftBlocked = await runCli(
      ["repair", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(driftBlocked.code, 1);
    assert.equal(
      parseEnvelope(driftBlocked.stdout).error?.facts.reason,
      "target-location-mismatch"
    );
    assert.equal(
      await readFile(join(copyTarget, "app", "KEEP"), "utf8"),
      "user replacement\n"
    );
    assert.equal(
      registeredLocations(home).some(
        (entry) => entry.path === resolve(copyTarget)
      ),
      false
    );

    await rm(copyTarget, {
      recursive: true,
      force: true
    });
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });
    const synced = await runCli(
      ["sync", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 0);

    const repaired = await runCli(
      ["repair", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(repaired.code, 0);
    assert.equal(
      parseEnvelope(repaired.stdout).result.status,
      "no-op"
    );
  });
});

test("sync upgrades an exact current V1 copied marker to V2 while registering the location", async () => {
  await withRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copy-v1-current");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });
    await writeSimpleV1Marker(copyTarget, 1);

    const synced = await runCli(
      ["sync", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 0);
    assert.equal(parseEnvelope(synced.stdout).result.generation, 1);

    const marker =
      await readTargetStateMarkerDocumentFile(copyTarget);
    assert.equal(marker.ok, true);
    if (marker.ok) {
      assert.equal(marker.value?.format, "SKILOOM-STATE-V2");
      assert.equal(marker.value?.facts.managed.length, 1);
    }
  });
});

test("sync reconciles a lagging V2 copied Target one-way to current Registry state without advancing generation", async () => {
  await withRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copy-lagging");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });

    const updated = await runCli(
      ["update", "--yes", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(updated.code, 0);
    assert.match(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      /Version two application/u
    );
    assert.match(
      await readFile(join(copyTarget, "app", "SKILL.md"), "utf8"),
      /Baseline application/u
    );

    const synced = await runCli(
      ["sync", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 0);
    const output = parseEnvelope(synced.stdout);
    assert.equal(output.result.status, "synchronized");
    assert.equal(output.result.generation, 2);
    assert.match(
      await readFile(
        join(copyTarget, "app", "SKILL.md"),
        "utf8"
      ),
      /Version two application/u
    );

    const marker =
      await readTargetStateMarkerDocumentFile(copyTarget);
    assert.equal(marker.ok, true);
    if (marker.ok) {
      assert.equal(marker.value?.format, "SKILOOM-STATE-V2");
      assert.equal(marker.value?.facts.generation, 2);
    }

    const copyLocation = registeredLocations(home).find(
      (entry) => entry.path === resolve(copyTarget)
    );
    assert.deepEqual(copyLocation, {
      path: resolve(copyTarget),
      observedGeneration: 2
    });
  });
});

test("sync reconciles a lagging V2 transformed managed copy using its marker ownership baseline", async () => {
  await withRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          [
            "install",
            "acme/app/app",
            "--name",
            "app-local",
            "--yes",
            "--json"
          ],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copy-transformed");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });

    assert.equal(
      (
        await runCli(
          ["update", "--yes", "--json"],
          { home, cwd, mode: "versions" }
        )
      ).code,
      0
    );

    const synced = await runCli(
      ["sync", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 0);
    assert.equal(
      parseEnvelope(synced.stdout).result.generation,
      2
    );
    const skill = await readFile(
      join(copyTarget, "app-local", "SKILL.md"),
      "utf8"
    );
    assert.match(skill, /name: app-local/u);
    assert.match(skill, /Version two application/u);
  });
});

test("sync removes an old managed dependency that disappeared from the current graph only after baseline verification", async () => {
  await withRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "shared-remove" }
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copy-removed-dependency");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });
    assert.equal(
      await pathExists(join(copyTarget, "shared")),
      true
    );

    assert.equal(
      (
        await runCli(
          ["update", "--yes", "--json"],
          { home, cwd, mode: "versions" }
        )
      ).code,
      0
    );

    const synced = await runCli(
      ["sync", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 0);
    assert.equal(
      parseEnvelope(synced.stdout).result.generation,
      2
    );
    assert.equal(
      await pathExists(join(copyTarget, "shared")),
      false
    );
    assert.match(
      await readFile(
        join(copyTarget, "app", "SKILL.md"),
        "utf8"
      ),
      /Version two application/u
    );
  });
});

test("sync rejects a copied Target marker generation ahead of Registry before location registration", async () => {
  await withRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copy-ahead");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });
    const markerPath = join(copyTarget, ".skiloom-state");
    const marker = await readFile(markerPath, "utf8");
    await writeFile(
      markerPath,
      marker.replace("generation = 1", "generation = 2"),
      "utf8"
    );

    const synced = await runCli(
      ["sync", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 1);
    const output = parseEnvelope(synced.stdout);
    assert.equal(
      output.error?.code,
      "ExactStateTargetUnavailable"
    );
    assert.equal(
      output.error?.facts.reason,
      "marker-generation-ahead"
    );
    assert.equal(
      registeredLocations(home).some(
        (entry) => entry.path === resolve(copyTarget)
      ),
      false
    );
  });
});

test("lagging V2 copied Target with foreign managed bytes fails closed before location registration", async () => {
  await withRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copy-foreign");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });
    assert.equal(
      (
        await runCli(
          ["update", "--yes", "--json"],
          { home, cwd, mode: "versions" }
        )
      ).code,
      0
    );

    await rm(join(copyTarget, "app"), {
      recursive: true,
      force: true
    });
    await mkdir(join(copyTarget, "app"));
    await writeFile(
      join(copyTarget, "app", "KEEP"),
      "foreign copied bytes\n",
      "utf8"
    );

    const synced = await runCli(
      ["sync", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 1);
    const output = parseEnvelope(synced.stdout);
    assert.equal(output.ok, false);
    assert.equal(
      output.error?.code,
      "ManagedProjectionMaterializationMismatch"
    );
    assert.equal(
      await readFile(join(copyTarget, "app", "KEEP"), "utf8"),
      "foreign copied bytes\n"
    );
    assert.equal(
      registeredLocations(home).some(
        (entry) => entry.path === resolve(copyTarget)
      ),
      false
    );
  });
});

test("lagging managed V1 copied Target fails closed because ownership baseline is unavailable", async () => {
  await withRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );
    const copyTarget = join(cwd, "copy-v1-lagging");
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });
    await writeSimpleV1Marker(copyTarget, 1);
    assert.equal(
      (
        await runCli(
          ["update", "--yes", "--json"],
          { home, cwd, mode: "versions" }
        )
      ).code,
      0
    );

    const synced = await runCli(
      ["sync", "--target", copyTarget, "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(synced.code, 1);
    const output = parseEnvelope(synced.stdout);
    assert.equal(
      output.error?.code,
      "ExactStateTargetUnavailable"
    );
    assert.equal(
      output.error?.facts.reason,
      "managed-baseline-required"
    );
    assert.match(
      await readFile(
        join(copyTarget, "app", "SKILL.md"),
        "utf8"
      ),
      /Baseline application/u
    );
    assert.equal(
      registeredLocations(home).some(
        (entry) => entry.path === resolve(copyTarget)
      ),
      false
    );
  });
});

async function writeSimpleV1Marker(
  targetRoot: string,
  generation: number
): Promise<void> {
  const marker =
    await readTargetStateMarkerDocumentFile(targetRoot);
  assert.equal(marker.ok, true);
  if (!marker.ok || marker.value === null) {
    assert.fail("V2 marker must exist before V1 compatibility rewrite");
  }
  await writeFile(
    join(targetRoot, ".skiloom-state"),
    [
      'format = "SKILOOM-STATE-V1"',
      `target-id = "${marker.value.facts.targetId}"`,
      `generation = ${generation}`,
      "",
      "[[requirements]]",
      'kind = "package"',
      'coordinate = "acme/app/app"',
      'source = "github-release"',
      ""
    ].join("\n"),
    "utf8"
  );
}

function registeredLocations(
  home: string
): ReadonlyArray<Readonly<{
  path: string;
  observedGeneration: number | null;
}>> {
  const database = new DatabaseSync(
    join(home, ".skiloom", "registry.sqlite3"),
    { readOnly: true }
  );
  try {
    return database
      .prepare(
        "SELECT path, observed_generation FROM target_locations ORDER BY path"
      )
      .all()
      .map((row) => ({
        path: String(row.path),
        observedGeneration:
          typeof row.observed_generation === "number"
            ? row.observed_generation
            : null
      }));
  } finally {
    database.close();
  }
}

function compareUtf8(
  left: string,
  right: string
): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

function parseEnvelope(source: string): CliEnvelope {
  return JSON.parse(source) as CliEnvelope;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      ? false
      : Promise.reject(error);
  }
}

async function withRuntime(
  run: (input: Readonly<{
    home: string;
    cwd: string;
    target: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(
    join(tmpdir(), "skiloom-cli-copied-target-")
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
