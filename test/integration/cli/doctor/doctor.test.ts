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

import {
  readTargetStateMarkerFile,
  writeTargetStateMarkerFile
} from "../../../../src/runtime/target-state-marker.js";

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve("native/skiloom-lock/target/debug/skiloom-lock");

type DoctorDiagnostic = Readonly<{
  code: string;
  severity: "info" | "warning" | "error";
  subject: string | null;
  recommendation: string | null;
}>;

type ParsedDoctorOutput = Readonly<{
  ok: boolean;
  result: Readonly<{
    status: string;
    diagnostics: ReadonlyArray<DoctorDiagnostic>;
    dependencyObservations: ReadonlyArray<unknown>;
  }>;
}>;

test("doctor reports a healthy accepted Target without network or mutation", async () => {
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

    const before = await readFile(
      join(target, "app", "SKILL.md"),
      "utf8"
    );
    const doctor = await runCli(
      ["doctor", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(doctor.code, 0);
    assertNoUnexpectedStderr(doctor.stderr);
    const output = parseDoctorOutput(doctor.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.result.status, "healthy");
    assert.equal(
      output.result.diagnostics.some(
        (entry) => entry.severity === "error"
      ),
      false
    );
    assert.deepEqual(output.result.dependencyObservations, []);
    assert.equal(
      await readFile(join(target, "app", "SKILL.md"), "utf8"),
      before
    );
  });
});

test("doctor distinguishes missing Store from missing managed projection", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );

    await rm(join(home, ".skiloom", "store"), {
      recursive: true,
      force: true
    });
    const doctor = await runCli(
      ["doctor", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(doctor.code, 0);
    const output = parseDoctorOutput(doctor.stdout);
    assertDiagnostic(
      output,
      "StoreEntryMissing",
      "repair"
    );
    assert.equal(
      output.result.diagnostics.some(
        (entry) => entry.code === "ManagedProjectionMissing"
      ),
      false
    );
  });
});

test("doctor reports managed projection drift as repairable and preserves foreign replacement bytes", async () => {
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
    await rm(join(target, "app"), {
      recursive: true,
      force: true
    });
    await mkdir(join(target, "app"));
    await writeFile(
      join(target, "app", "KEEP"),
      "user replacement bytes\n",
      "utf8"
    );

    const doctor = await runCli(
      ["doctor", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(doctor.code, 0);
    const output = parseDoctorOutput(doctor.stdout);
    assertDiagnostic(
      output,
      "ManagedProjectionDrift",
      "repair"
    );
    assert.equal(
      await readFile(join(target, "app", "KEEP"), "utf8"),
      "user replacement bytes\n"
    );
  });
});

test("doctor reports a stale marker as a sync recommendation", async () => {
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
    const oldMarker = await readTargetStateMarkerFile(target);
    assert.equal(oldMarker.ok, true);
    if (!oldMarker.ok || oldMarker.value === null) {
      return;
    }

    assert.equal(
      (
        await runCli(
          ["update", "--yes", "--json"],
          { home, cwd, mode: "versions" }
        )
      ).code,
      0
    );
    const restored = await writeTargetStateMarkerFile(
      target,
      oldMarker.value
    );
    assert.equal(restored.ok, true);

    const doctor = await runCli(
      ["doctor", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(doctor.code, 0);
    const output = parseDoctorOutput(doctor.stdout);
    assertDiagnostic(output, "MarkerStale", "sync");
  });
});

test("doctor observes detached ownership without reading or rewriting user bytes", async () => {
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
      "detached user bytes\n",
      "utf8"
    );

    const doctor = await runCli(
      ["doctor", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(doctor.code, 0);
    const output = parseDoctorOutput(doctor.stdout);
    assertDiagnostic(
      output,
      "DetachedOverridePresent",
      null
    );
    assert.equal(
      await readFile(
        join(target, "app", "USER-NOTE"),
        "utf8"
      ),
      "detached user bytes\n"
    );
  });
});

test("doctor recommends recover when Registry authority is absent but marker remains", async () => {
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
    await deleteRegistry(home);

    const doctor = await runCli(
      ["doctor", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(doctor.code, 0);
    const output = parseDoctorOutput(doctor.stdout);
    assertDiagnostic(output, "RegistryMissing", "recover");
    assert.equal(existsSync(join(target, "app")), true);
  });
});

function assertDiagnostic(
  output: ParsedDoctorOutput,
  code: string,
  recommendation: string | null
): void {
  const diagnostic = output.result.diagnostics.find(
    (entry) => entry.code === code
  );
  assert.notEqual(diagnostic, undefined);
  assert.equal(
    diagnostic?.recommendation,
    recommendation
  );
}

async function deleteRegistry(home: string): Promise<void> {
  const registry = join(home, ".skiloom", "registry.sqlite3");
  await rm(registry, { force: true });
  await rm(registry + "-shm", { force: true });
  await rm(registry + "-wal", { force: true });
}

async function withCliRuntime(
  run: (input: Readonly<{
    home: string;
    cwd: string;
    target: string;
  }>) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(
    join(tmpdir(), "skiloom-cli-doctor-")
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

function parseDoctorOutput(source: string): ParsedDoctorOutput {
  return JSON.parse(source) as ParsedDoctorOutput;
}

function assertNoUnexpectedStderr(stderr: string): void {
  const normalized = stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u,
    ""
  );
  assert.equal(normalized, "");
}
