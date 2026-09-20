import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

export const CLI_ENTRY = resolve(
  ".test-dist/src/cli/main.js"
);
export const GITHUB_PRELOAD = resolve(
  "test/integration/cli/fixtures/github-install-fetch.mjs"
);
export const SKILLSMP_PRELOAD = resolve(
  "test/integration/cli/fixtures/skillsmp-fetch.mjs"
);
export const LOCK_HELPER =
  process.env.SKILOOM_LOCK_TEST_BINARY ??
  resolve(
    "native/skiloom-lock/target/debug/skiloom-lock"
  );

export type CliRunResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

export type GateRuntime = Readonly<{
  home: string;
  cwd: string;
  target: string;
}>;

export async function withGateRuntime(
  run: (input: GateRuntime) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(
    join(tmpdir(), "skiloom-cli-gate-")
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

export function runGateCli(
  args: ReadonlyArray<string>,
  options: Readonly<{
    home: string;
    cwd: string;
    githubMode?: string;
    skillsmpMode?: string;
    combinedPreloads?: boolean;
  }>
): Promise<CliRunResult> {
  const combined = options.combinedPreloads ?? false;
  const preloads = combined
    ? [
        "--import",
        SKILLSMP_PRELOAD,
        "--import",
        GITHUB_PRELOAD
      ]
    : ["--import", GITHUB_PRELOAD];

  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [...preloads, CLI_ENTRY, ...args],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          HOME: options.home,
          USERPROFILE: options.home,
          SKILOOM_LOCK_TEST_BINARY: LOCK_HELPER,
          SKILOOM_TEST_GITHUB_MODE:
            options.githubMode ?? "base",
          SKILOOM_TEST_SKILLSMP_MODE:
            options.skillsmpMode ?? "success"
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
    child.once("close", (code, signal) => {
      resolveResult({
        code,
        signal,
        stdout,
        stderr
      });
    });
  });
}

export function runInteractiveGateCli(
  args: ReadonlyArray<string>,
  options: Readonly<{
    home: string;
    cwd: string;
    githubMode?: string;
    skillsmpMode?: string;
    input: string;
  }>
): Promise<CliRunResult> {
  const command = [
    process.execPath,
    "--import",
    GITHUB_PRELOAD,
    CLI_ENTRY,
    ...args
  ].map(shellQuote).join(" ");

  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "/usr/bin/script",
      ["-qefc", command, "/dev/null"],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          HOME: options.home,
          USERPROFILE: options.home,
          SKILOOM_LOCK_TEST_BINARY: LOCK_HELPER,
          SKILOOM_TEST_GITHUB_MODE:
            options.githubMode ?? "base",
          SKILOOM_TEST_SKILLSMP_MODE:
            options.skillsmpMode ?? "success"
        },
        stdio: ["pipe", "pipe", "pipe"]
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
    child.once("close", (code, signal) => {
      resolveResult({
        code,
        signal,
        stdout,
        stderr
      });
    });
    child.stdin.end(options.input);
  });
}

export function parseJson<T>(source: string): T {
  return JSON.parse(source) as T;
}

export function assertSingleJsonDocument(
  source: string
): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(source) as unknown;
  assert.equal(
    typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed),
    true
  );
  assert.equal(source.trimEnd().endsWith("}"), true);
  assert.equal(source.trimEnd().startsWith("{"), true);
  return parsed as Readonly<Record<string, unknown>>;
}

function shellQuote(source: string): string {
  return "'" + source.replace(/'/gu, "'\\''") + "'";
}

export function assertNoUnexpectedStderr(
  stderr: string
): void {
  const normalized = stderr.replace(
    /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u,
    ""
  );
  assert.equal(normalized, "");
}
