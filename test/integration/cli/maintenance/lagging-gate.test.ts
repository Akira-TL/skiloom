import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
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

type CliEnvelope = Readonly<{
  ok: boolean;
  error?: Readonly<{
    code: string;
    facts: Readonly<Record<string, unknown>>;
  }>;
  result?: Readonly<{
    status?: string;
    targetId?: string;
    generation?: number;
  }>;
}>;

type Runtime = Readonly<{
  home: string;
  cwd: string;
  target: string;
  copyTarget: string;
}>;

const LAGGING_ERROR = "TargetCopyRequiresSyncOrFork";

test("candidate commands fail before network or accepted-state mutation on a lagging registered copy", async () => {
  const cases: ReadonlyArray<Readonly<{
    args: ReadonlyArray<string>;
  }>> = [
    {
      args: ["update", "--yes", "--json"]
    },
    {
      args: [
        "install",
        "acme/tool/tool",
        "--yes",
        "--json"
      ]
    },
    {
      args: [
        "remove",
        "acme/app/app",
        "--yes",
        "--json"
      ]
    },
    {
      args: ["bootstrap", "--yes", "--json"]
    }
  ];

  for (const entry of cases) {
    await withLaggingCopy(async (runtime) => {
      const before = await readFile(
        join(runtime.copyTarget, "app", "SKILL.md")
      );
      const result = await runCli(
        [
          ...entry.args.slice(0, -1),
          "--target",
          runtime.copyTarget,
          entry.args.at(-1)!
        ],
        {
          ...runtime,
          mode: "forbid-network",
          lockHelper: missingLockHelper(runtime)
        }
      );
      assertLaggingGate(result, entry.args[0]!);
      assert.deepEqual(
        await readFile(
          join(runtime.copyTarget, "app", "SKILL.md")
        ),
        before
      );
      assert.equal(
        await markerGeneration(runtime.copyTarget),
        1
      );
      assert.equal(
        await registryGeneration(runtime.home),
        2
      );
    });
  }
});

test("human lagging-copy failure points to sync or fork before lock acquisition", async () => {
  await withLaggingCopy(async (runtime) => {
    const result = await runCli(
      [
        "update",
        "--target",
        runtime.copyTarget,
        "--yes"
      ],
      {
        ...runtime,
        mode: "forbid-network",
        lockHelper: missingLockHelper(runtime)
      }
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /skiloom sync/u);
    assert.match(result.stderr, /skiloom fork/u);
    assert.match(result.stderr, /generation 1/u);
    assert.match(result.stderr, /generation 2/u);
  });
});

test("repair local ownership operations and observe fail before lagging-copy mutation", async () => {
  const cases: ReadonlyArray<ReadonlyArray<string>> = [
    ["repair"],
    ["rename", "acme/app/app", "app-local"],
    ["detach", "acme/app/app"],
    ["rebind", "acme/app/app", "app-rebound"],
    ["forget", "acme/app/app"],
    [
      "observe",
      "acme/app/app",
      "gpu",
      "--status",
      "unknown"
    ]
  ];

  for (const args of cases) {
    await withLaggingCopy(async (runtime) => {
      const before = await readFile(
        join(runtime.copyTarget, "app", "SKILL.md")
      );
      const result = await runCli(
        [
          ...args,
          "--target",
          runtime.copyTarget,
          "--json"
        ],
        {
          ...runtime,
          mode: "forbid-network",
          lockHelper: missingLockHelper(runtime)
        }
      );
      assertLaggingGate(result, args[0]!);
      assert.deepEqual(
        await readFile(
          join(runtime.copyTarget, "app", "SKILL.md")
        ),
        before
      );
      assert.equal(
        await markerGeneration(runtime.copyTarget),
        1
      );
      assert.equal(
        await registryGeneration(runtime.home),
        2
      );
    });
  }
});

test("exact export and merge import refuse a lagging registered copy", async () => {
  await withLaggingCopy(async (runtime) => {
    const destination = join(
      runtime.cwd,
      "lagging-export.skiloom-export"
    );
    const exported = await runCli(
      [
        "export",
        destination,
        "--target",
        runtime.copyTarget,
        "--json"
      ],
      {
        ...runtime,
        mode: "forbid-network",
        lockHelper: missingLockHelper(runtime)
      }
    );
    assertLaggingGate(exported, "export");
    assert.equal(existsSync(destination), false);

    const currentExport = join(
      runtime.cwd,
      "current.skiloom-export"
    );
    const current = await runCli(
      [
        "export",
        currentExport,
        "--target",
        runtime.target,
        "--json"
      ],
      {
        ...runtime,
        mode: "forbid-network"
      }
    );
    assert.equal(current.code, 0);

    const merged = await runCli(
      [
        "import",
        currentExport,
        "--merge",
        "--yes",
        "--target",
        runtime.copyTarget,
        "--json"
      ],
      {
        ...runtime,
        mode: "forbid-network",
        lockHelper: missingLockHelper(runtime)
      }
    );
    assertLaggingGate(merged, "import");
    assert.equal(
      await markerGeneration(runtime.copyTarget),
      1
    );
  });
});

test("status doctor sync and fork remain the explicit lagging-copy paths", async () => {
  await withLaggingCopy(async (runtime) => {
    const originalTargetId = await markerTargetId(runtime.target);
    const status = await runCli(
      [
        "status",
        "--target",
        runtime.copyTarget,
        "--json"
      ],
      {
        ...runtime,
        mode: "forbid-network"
      }
    );
    assert.equal(status.code, 0);

    const doctor = await runCli(
      [
        "doctor",
        "--target",
        runtime.copyTarget,
        "--json"
      ],
      {
        ...runtime,
        mode: "forbid-network"
      }
    );
    assert.equal(doctor.code, 0);

    const forked = await runCli(
      [
        "fork",
        "--target",
        runtime.copyTarget,
        "--yes",
        "--json"
      ],
      {
        ...runtime,
        mode: "base"
      }
    );
    assert.equal(
      forked.code,
      0,
      forked.stdout + forked.stderr
    );
    const forkOutput = JSON.parse(
      forked.stdout
    ) as CliEnvelope;
    assert.equal(forkOutput.result?.status, "forked");
    assert.equal(forkOutput.result?.generation, 1);
    const forkTargetId = forkOutput.result?.targetId;
    assert.equal(typeof forkTargetId, "string");
    assert.notEqual(forkTargetId, originalTargetId);
    assert.equal(
      await registryGenerationForTarget(
        runtime.home,
        originalTargetId
      ),
      2
    );
    assert.equal(
      await registryGenerationForTarget(
        runtime.home,
        forkTargetId!
      ),
      1
    );
    assert.equal(
      await registryTargetForPath(runtime.home, runtime.target),
      originalTargetId
    );
    assert.equal(
      await registryTargetForPath(
        runtime.home,
        runtime.copyTarget
      ),
      forkTargetId
    );
  });

  await withLaggingCopy(async (runtime) => {
    const synced = await runCli(
      [
        "sync",
        "--target",
        runtime.copyTarget,
        "--json"
      ],
      {
        ...runtime,
        mode: "forbid-network"
      }
    );
    assert.equal(synced.code, 0);
    assert.equal(
      await markerGeneration(runtime.copyTarget),
      2
    );

    const updated = await runCli(
      [
        "update",
        "--target",
        runtime.copyTarget,
        "--yes",
        "--json"
      ],
      {
        ...runtime,
        mode: "versions"
      }
    );
    assert.equal(updated.code, 0);
  });
});

async function withLaggingCopy(
  run: (runtime: Runtime) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(
    join(tmpdir(), "skiloom-cli-lagging-gate-")
  );
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const target = join(cwd, ".agents", "skills");
  const copyTarget = join(cwd, "copy");
  await mkdir(home);
  await mkdir(cwd);

  const runtime = {
    home,
    cwd,
    target,
    copyTarget
  };
  try {
    assert.equal(
      (
        await runCli(
          ["install", "acme/app/app", "--yes", "--json"],
          {
            ...runtime,
            mode: "base"
          }
        )
      ).code,
      0
    );
    await cp(target, copyTarget, {
      recursive: true,
      dereference: false
    });
    assert.equal(
      (
        await runCli(
          [
            "sync",
            "--target",
            copyTarget,
            "--json"
          ],
          {
            ...runtime,
            mode: "forbid-network"
          }
        )
      ).code,
      0
    );
    assert.equal(
      (
        await runCli(
          ["update", "--yes", "--json"],
          {
            ...runtime,
            mode: "versions"
          }
        )
      ).code,
      0
    );
    assert.equal(await markerGeneration(copyTarget), 1);
    assert.equal(await registryGeneration(home), 2);
    await run(runtime);
  } finally {
    await rm(root, {
      recursive: true,
      force: true
    });
  }
}

function assertLaggingGate(
  result: Readonly<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>,
  command: string
): void {
  assert.equal(result.code, 1, command);
  const output = JSON.parse(result.stdout) as CliEnvelope;
  assert.equal(output.ok, false, command);
  assert.equal(output.error?.code, LAGGING_ERROR, command);
  assert.deepEqual(
    output.error?.facts.actions,
    ["sync", "fork"],
    command
  );
  assert.equal(output.error?.facts.markerGeneration, 1);
  assert.equal(output.error?.facts.registryGeneration, 2);
}

async function markerGeneration(
  target: string
): Promise<number> {
  const text = await readFile(
    join(target, ".skiloom-state"),
    "utf8"
  );
  const match = /^generation = (\d+)$/mu.exec(text);
  assert.notEqual(match, null);
  return Number(match![1]);
}

async function markerTargetId(target: string): Promise<string> {
  const text = await readFile(
    join(target, ".skiloom-state"),
    "utf8"
  );
  const match = /^target-id = "([^"]+)"$/mu.exec(text);
  assert.notEqual(match, null);
  return match![1]!;
}

async function registryGeneration(
  home: string
): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(
    join(home, ".skiloom", "registry.sqlite3"),
    { readOnly: true }
  );
  try {
    const row = database
      .prepare("SELECT generation FROM targets")
      .get();
    assert.equal(typeof row?.generation, "number");
    return row!.generation as number;
  } finally {
    database.close();
  }
}

async function registryGenerationForTarget(
  home: string,
  targetId: string
): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(
    join(home, ".skiloom", "registry.sqlite3"),
    { readOnly: true }
  );
  try {
    const row = database
      .prepare(
        "SELECT generation FROM targets WHERE target_id = ?"
      )
      .get(targetId);
    assert.equal(typeof row?.generation, "number");
    return row!.generation as number;
  } finally {
    database.close();
  }
}

async function registryTargetForPath(
  home: string,
  path: string
): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(
    join(home, ".skiloom", "registry.sqlite3"),
    { readOnly: true }
  );
  try {
    const row = database
      .prepare(
        "SELECT target_id FROM target_locations WHERE path = ?"
      )
      .get(resolve(path));
    assert.equal(typeof row?.target_id, "string");
    return row!.target_id as string;
  } finally {
    database.close();
  }
}

function missingLockHelper(runtime: Runtime): string {
  return join(runtime.cwd, "missing-lock-helper");
}

function runCli(
  args: ReadonlyArray<string>,
  options: Runtime & Readonly<{
    mode: string;
    lockHelper?: string;
  }>
): Promise<Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolveResult, reject) => {
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
          ...process.env,
          HOME: options.home,
          USERPROFILE: options.home,
          SKILOOM_LOCK_TEST_BINARY:
            options.lockHelper ?? LOCK_HELPER,
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
      resolveResult({
        code,
        stdout,
        stderr
      });
    });
  });
}
