import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");
const FETCH_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve("native/skiloom-lock/target/debug/skiloom-lock");

const ROUTER = "akira-tl/skiloom/skiloom";
const SUITE = [
  "akira-tl/skiloom/skiloom",
  "akira-tl/skiloom/skiloom-author",
  "akira-tl/skiloom/skiloom-discover",
  "akira-tl/skiloom/skiloom-doctor",
  "akira-tl/skiloom/skiloom-manage"
] as const;

type ParsedBootstrapOutput = Readonly<{
  ok: boolean;
  error?: Readonly<{
    code: string;
    facts: Readonly<Record<string, unknown>>;
  }>;
  result: Readonly<{
    status: string;
    target: Readonly<{
      path: string;
      source: string;
      host: string | null;
      scope: string;
    }>;
    directRequirements: ReadonlyArray<Readonly<{
      coordinate: string;
      versionRequirement?: string;
    }>>;
    packages: ReadonlyArray<Readonly<{
      packageCoordinate: string;
    }>>;
    acceptedState: Readonly<{
      generation: number;
    }> | null;
  }>;
}>;

test("bootstrap resolves the checkout operation-lock helper without test-only injection", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    const planned = await runCli(
      ["bootstrap", "--plan", "--json"],
      {
        home,
        cwd,
        mode: "first-party",
        injectLockHelper: false
      }
    );

    assert.equal(planned.code, 0);
    assertNoUnexpectedStderr(planned.stderr);
    const output = parseOutput(planned.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.result.status, "planned");
  });
});

test("bootstrap --plan computes the complete Router candidate on the default Target without writes", async () => {
  await withCliRuntime(async ({ home, cwd, defaultTarget }) => {
    const planned = await runCli(
      ["bootstrap", "--plan", "--json"],
      { home, cwd, mode: "first-party" }
    );

    assert.equal(planned.code, 0);
    assertNoUnexpectedStderr(planned.stderr);
    const output = parseOutput(planned.stdout);
    assert.equal(output.result.status, "planned");
    assert.equal(output.result.target.path, defaultTarget);
    assert.equal(output.result.target.source, "default");
    assert.deepEqual(
      output.result.directRequirements.map(
        (entry) => entry.coordinate
      ),
      [ROUTER]
    );
    assert.deepEqual(
      output.result.packages.map(
        (entry) => entry.packageCoordinate
      ),
      [...SUITE]
    );
    assert.equal(output.result.acceptedState, null);
    assert.equal(existsSync(defaultTarget), false);
  });
});

test("noninteractive bootstrap requires --yes and installs specialists only through Router dependencies", async () => {
  await withCliRuntime(async ({ home, cwd, defaultTarget }) => {
    const blocked = await runCli(
      ["bootstrap", "--json"],
      { home, cwd, mode: "first-party" }
    );
    assert.equal(blocked.code, 3);
    const blockedOutput = parseOutput(blocked.stdout);
    assert.equal(blockedOutput.ok, false);
    assert.equal(
      blockedOutput.error?.code,
      "InteractionRequired"
    );
    assert.equal(existsSync(defaultTarget), false);

    const installed = await runCli(
      ["bootstrap", "--yes", "--json"],
      { home, cwd, mode: "first-party" }
    );
    assert.equal(installed.code, 0);
    const output = parseOutput(installed.stdout);
    assert.equal(output.result.status, "installed");
    assert.deepEqual(
      output.result.directRequirements.map(
        (entry) => entry.coordinate
      ),
      [ROUTER]
    );
    assert.deepEqual(
      output.result.packages.map(
        (entry) => entry.packageCoordinate
      ),
      [...SUITE]
    );
    assert.equal(output.result.acceptedState?.generation, 1);
    for (const packageCoordinate of SUITE) {
      const activationName =
        packageCoordinate.split("/").at(-1)!;
      assert.equal(
        existsSync(join(defaultTarget, activationName)),
        true,
        activationName
      );
    }
  });
});

test("bootstrap Target selection supports Host presets and explicit paths one Target at a time", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    const host = await runCli(
      [
        "bootstrap",
        "--host",
        "claude",
        "--scope",
        "workspace",
        "--plan",
        "--json"
      ],
      { home, cwd, mode: "first-party" }
    );
    assert.equal(host.code, 0);
    const hostOutput = parseOutput(host.stdout);
    assert.equal(
      hostOutput.result.target.path,
      join(cwd, ".claude", "skills")
    );
    assert.equal(hostOutput.result.target.host, "claude");

    const explicitPath = "custom-skills";
    const explicit = await runCli(
      [
        "bootstrap",
        "--target",
        explicitPath,
        "--plan",
        "--json"
      ],
      { home, cwd, mode: "first-party" }
    );
    assert.equal(explicit.code, 0);
    const explicitOutput = parseOutput(explicit.stdout);
    assert.equal(
      explicitOutput.result.target.path,
      join(cwd, explicitPath)
    );
    assert.equal(explicitOutput.result.target.source, "explicit");
    assert.equal(
      existsSync(join(cwd, ".claude", "skills")),
      false
    );
    assert.equal(existsSync(join(cwd, explicitPath)), false);
  });
});

test("bootstrap is an idempotent no-op without network when the Router direct root already exists", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    const installed = await runCli(
      ["bootstrap", "--yes", "--json"],
      { home, cwd, mode: "first-party" }
    );
    assert.equal(installed.code, 0);
    const installedOutput = parseOutput(installed.stdout);
    assert.equal(installedOutput.result.acceptedState?.generation, 1);

    const repeated = await runCli(
      ["bootstrap", "--yes", "--json"],
      { home, cwd, mode: "forbid-network" }
    );

    assert.equal(repeated.code, 0);
    const output = parseOutput(repeated.stdout);
    assert.equal(output.result.status, "no-op");
    assert.deepEqual(
      output.result.directRequirements.map(
        (entry) => entry.coordinate
      ),
      [ROUTER]
    );
    assert.equal(output.result.acceptedState?.generation, 1);
  });
});

test("bootstrap does not no-op a different accepted Router requirement", async () => {
  await withCliRuntime(async ({ home, cwd }) => {
    const constrained = await runCli(
      [
        "install",
        ROUTER,
        "--version",
        "^0.8.0",
        "--yes",
        "--json"
      ],
      { home, cwd, mode: "first-party" }
    );
    assert.equal(constrained.code, 0);

    const bootstrapped = await runCli(
      ["bootstrap", "--yes", "--json"],
      { home, cwd, mode: "first-party" }
    );

    assert.equal(bootstrapped.code, 0);
    const output = parseOutput(bootstrapped.stdout);
    assert.equal(output.result.status, "applied");
    assert.equal(output.result.acceptedState?.generation, 2);
    assert.deepEqual(
      output.result.directRequirements.map(
        (entry) => entry.coordinate
      ),
      [ROUTER]
    );
    assert.equal(
      output.result.directRequirements[0]?.versionRequirement,
      undefined
    );
  });
});

test("package lifecycle and first ordinary CLI startup do not bootstrap any Target", async () => {
  await withCliRuntime(async ({ home, cwd, defaultTarget }) => {
    const packageJson = JSON.parse(
      await readFile("package.json", "utf8")
    ) as {
      scripts: Record<string, string | undefined>;
    };
    for (const lifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepare"
    ]) {
      assert.equal(
        packageJson.scripts[lifecycle],
        undefined,
        lifecycle
      );
    }

    const status = await runCli(
      ["status", "--json"],
      { home, cwd, mode: "forbid-network" }
    );
    assert.equal(status.code, 0);
    assert.equal(existsSync(defaultTarget), false);
    assert.equal(
      existsSync(join(cwd, ".claude", "skills")),
      false
    );
  });
});

async function withCliRuntime(
  run: (input: Readonly<{
    home: string;
    cwd: string;
    defaultTarget: string;
  }>) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(
    join(tmpdir(), "skiloom-cli-bootstrap-")
  );
  const home = join(temp, "home");
  const cwd = join(temp, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  try {
    await run({
      home,
      cwd,
      defaultTarget: join(cwd, ".agents", "skills")
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
    injectLockHelper?: boolean;
  }>
): Promise<Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolveResult, reject) => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: options.home,
      USERPROFILE: options.home,
      SKILOOM_TEST_GITHUB_MODE: options.mode
    };
    if (options.injectLockHelper === false) {
      delete environment.SKILOOM_LOCK_TEST_BINARY;
    } else {
      environment.SKILOOM_LOCK_TEST_BINARY = LOCK_HELPER;
    }

    const child = spawn(
      process.execPath,
      ["--import", FETCH_PRELOAD, CLI_ENTRY, ...args],
      {
        cwd: options.cwd,
        env: environment,
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

function parseOutput(source: string): ParsedBootstrapOutput {
  return JSON.parse(source) as ParsedBootstrapOutput;
}

function assertNoUnexpectedStderr(stderr: string): void {
  const normalized = stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u,
    ""
  );
  assert.equal(normalized, "");
}
