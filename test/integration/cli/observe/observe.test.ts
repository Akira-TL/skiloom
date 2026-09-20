import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm
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

type ObserveEnvelope = Readonly<{
  ok: boolean;
  error?: Readonly<{
    code: string;
    facts: Readonly<Record<string, unknown>>;
  }>;
  result: Readonly<{
    status: string;
    targetId: string;
    generation: number;
    packageCoordinate: string;
    name: string;
    observation: Readonly<{
      kind: string;
      name: string;
      status: string;
      note: string | null;
    }> | null;
  }>;
}>;

test("observe records updates clears and no-ops special observations without touching Target generation marker or bytes", async () => {
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
    const markerBefore = await readFile(
      join(target, ".skiloom-state")
    );
    const skillBefore = await readFile(
      join(target, "app", "SKILL.md")
    );

    const recorded = await runCli(
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "missing",
        "--note",
        "driver absent",
        "--json"
      ],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(recorded.code, 0);
    const recordedOutput = parseObserve(recorded.stdout);
    assert.equal(recordedOutput.result.status, "recorded");
    assert.equal(recordedOutput.result.generation, 1);
    assert.deepEqual(recordedOutput.result.observation, {
      packageCoordinate: "acme/app/app",
      packageContentDigest:
        (JSON.parse(
          (
            await runCli(
              ["doctor", "--json"],
              { home, cwd, mode: "forbid-network" }
            )
          ).stdout
        ) as {
          result: {
            dependencyObservations: ReadonlyArray<{
              packageContentDigest: string;
            }>;
          };
        }).result.dependencyObservations[0]!
          .packageContentDigest,
      kind: "special",
      name: "gpu",
      status: "missing",
      detectedVersion: null,
      location: null,
      note: "driver absent"
    });

    const updated = await runCli(
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "satisfied",
        "--json"
      ],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(updated.code, 0);
    assert.equal(
      parseObserve(updated.stdout).result.status,
      "updated"
    );
    assert.equal(
      parseObserve(updated.stdout).result.generation,
      1
    );

    const noOp = await runCli(
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "satisfied",
        "--json"
      ],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(noOp.code, 0);
    assert.equal(parseObserve(noOp.stdout).result.status, "no-op");

    const cleared = await runCli(
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--clear",
        "--json"
      ],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(cleared.code, 0);
    assert.equal(
      parseObserve(cleared.stdout).result.status,
      "cleared"
    );
    assert.equal(
      parseObserve(cleared.stdout).result.generation,
      1
    );

    const clearNoOp = await runCli(
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--clear",
        "--json"
      ],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(clearNoOp.code, 0);
    assert.equal(
      parseObserve(clearNoOp.stdout).result.status,
      "no-op"
    );

    assert.deepEqual(
      await readFile(join(target, ".skiloom-state")),
      markerBefore
    );
    assert.deepEqual(
      await readFile(join(target, "app", "SKILL.md")),
      skillBefore
    );
    assert.deepEqual(
      await statusFacts(home, cwd),
      { generation: 1, dependencyObservations: 0 }
    );
  });
});

test("observe keeps Skiloom-owned software observations separate from same-name special observations", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "host-observation" }
        )
      ).code,
      0
    );
    assert.equal(
      (
        await runCli(
          ["sync", "--json"],
          { home, cwd, mode: "forbid-network" }
        )
      ).code,
      0
    );

    const recorded = await runCli(
      [
        "observe",
        "acme/app/app",
        "node",
        "--status",
        "missing",
        "--json"
      ],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(recorded.code, 0);
    assert.deepEqual(
      await statusFacts(home, cwd),
      { generation: 1, dependencyObservations: 2 }
    );

    const doctor = await runCli(
      ["doctor", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(doctor.code, 0);
    const observations = (
      JSON.parse(doctor.stdout) as {
        result: {
          dependencyObservations: ReadonlyArray<{
            kind: string;
            name: string;
            status: string;
          }>;
        };
      }
    ).result.dependencyObservations;
    assert.deepEqual(
      observations.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        status: entry.status
      })),
      [
        {
          kind: "software",
          name: "node",
          status: "satisfied"
        },
        {
          kind: "special",
          name: "node",
          status: "missing"
        }
      ]
    );

    assert.equal(
      (
        await runCli(
          [
            "observe",
            "acme/app/app",
            "node",
            "--clear",
            "--json"
          ],
          { home, cwd, mode: "forbid-network" }
        )
      ).code,
      0
    );
    assert.deepEqual(
      await statusFacts(home, cwd),
      { generation: 1, dependencyObservations: 1 }
    );
  });
});

test("observe fails closed for unregistered stale Targets and unknown Packages", async () => {
  await withCliRuntime(async ({ home, cwd, target }) => {
    const unregistered = await runCli(
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "unknown",
        "--json"
      ],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(unregistered.code, 1);
    assert.equal(
      parseObserve(unregistered.stdout).error?.code,
      "ObservationTargetUnavailable"
    );

    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          { home, cwd, mode: "base" }
        )
      ).code,
      0
    );

    const unknownPackage = await runCli(
      [
        "observe",
        "acme/missing/missing",
        "gpu",
        "--status",
        "unknown",
        "--json"
      ],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(unknownPackage.code, 1);
    assert.equal(
      parseObserve(unknownPackage.stdout).error?.code,
      "SpecialObservationPackageUnavailable"
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
    assert.deepEqual(
      await writeTargetStateMarkerFile(target, oldMarker.value),
      { ok: true, value: undefined }
    );

    const stale = await runCli(
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "unknown",
        "--json"
      ],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(stale.code, 1);
    const staleOutput = parseObserve(stale.stdout);
    assert.equal(
      staleOutput.error?.code,
      "ObservationTargetUnavailable"
    );
    assert.equal(
      staleOutput.error?.facts.reason,
      "marker-stale"
    );
  });
});

test("whole-Target update discards a saved special observation when Package digest changes", async () => {
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
    assert.equal(
      (
        await runCli(
          [
            "observe",
            "acme/app/app",
            "gpu",
            "--status",
            "missing",
            "--json"
          ],
          { home, cwd, mode: "forbid-network" }
        )
      ).code,
      0
    );
    assert.deepEqual(
      await statusFacts(home, cwd),
      { generation: 1, dependencyObservations: 1 }
    );

    const updated = await runCli(
      ["update", "--yes", "--json"],
      { home, cwd, mode: "versions" }
    );
    assert.equal(updated.code, 0);
    assert.deepEqual(
      await statusFacts(home, cwd),
      { generation: 2, dependencyObservations: 0 }
    );
  });
});

test("observe argument surface rejects invalid status name note candidate flags and mixed clear", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      [
        "observe",
        "acme/app/app",
        "",
        "--status",
        "missing",
        "--json"
      ],
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "maybe",
        "--json"
      ],
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "missing",
        "--clear",
        "--json"
      ],
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--clear",
        "--note",
        "not allowed",
        "--json"
      ],
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "missing",
        "--note",
        "bad\nnote",
        "--json"
      ],
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "missing",
        "--yes",
        "--json"
      ],
      [
        "observe",
        "acme/app/app",
        "gpu",
        "--status",
        "missing",
        "--plan",
        "--json"
      ]
    ];

    for (const args of cases) {
      const result = await runCli(args, {
        home,
        cwd,
        mode: "forbid-network"
      });
      assert.equal(result.code, 2, args.join(" "));
      assert.equal(
        parseObserve(result.stdout).error?.code,
        "InvalidArguments",
        args.join(" ")
      );
    }
  });
});

async function statusFacts(
  home: string,
  cwd: string
): Promise<Readonly<{
  generation: number;
  dependencyObservations: number;
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
        dependencyObservations: number;
      } | null;
    };
  };
  assert.notEqual(parsed.result.registry, null);
  return {
    generation: parsed.result.registry!.generation,
    dependencyObservations:
      parsed.result.registry!.dependencyObservations
  };
}

function parseObserve(source: string): ObserveEnvelope {
  return JSON.parse(source) as ObserveEnvelope;
}

async function withCliRuntime(
  run: (input: Readonly<{
    home: string;
    cwd: string;
    target: string;
  }>) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(
    join(tmpdir(), "skiloom-cli-observe-")
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
