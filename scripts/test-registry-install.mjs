import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";

const packageMetadata = JSON.parse(
  await readFile(resolve("package.json"), "utf8")
);
const version = packageMetadata.version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("package.json version is unavailable");
}
const packageSpec = `skiloom@${version}`;
const helperSpec = `${currentHelperPackage()}@${version}`;
const npmExecPath = process.env.npm_execpath;
if (npmExecPath === undefined || npmExecPath.length === 0) {
  throw new Error("registry install smoke must run through npm run");
}
const npmCli = resolve(npmExecPath);
const npxCli = join(dirname(npmCli), "npx-cli.js");
await Promise.all([access(npmCli), access(npxCli)]);

const root = await mkdtemp(join(tmpdir(), "skiloom-registry-install-"));
const prefix = join(root, "global");
const globalHome = join(root, "home-global");
const npxHome = join(root, "home-npx");
const globalTarget = join(root, "target-global");
const npxTarget = join(root, "target-npx");

try {
  await Promise.all([
    mkdir(globalHome, { recursive: true }),
    mkdir(npxHome, { recursive: true }),
    mkdir(globalTarget, { recursive: true }),
    mkdir(npxTarget, { recursive: true })
  ]);

  await Promise.all([
    waitForPublishedPackage(packageSpec),
    waitForPublishedPackage(helperSpec)
  ]);

  await runNpm(
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      packageSpec
    ],
    process.env
  );

  const globalBinDirectory =
    process.platform === "win32" ? prefix : join(prefix, "bin");
  const globalShim =
    process.platform === "win32"
      ? join(prefix, "skiloom.cmd")
      : join(globalBinDirectory, "skiloom");
  await access(globalShim);
  const globalEntry = join(
    prefix,
    process.platform === "win32" ? "node_modules" : "lib/node_modules",
    "skiloom",
    "dist",
    "cli",
    "main.js"
  );
  await access(globalEntry);
  const globalResult = await runCommand(
    process.execPath,
    [globalEntry, "sync", "--target", globalTarget, "--json"],
    runtimeEnvironment(globalHome, globalBinDirectory)
  );
  assertLockedCommandReachedTargetState(globalResult, globalTarget);

  const npxResult = await runNpx(
    [
      "--yes",
      packageSpec,
      "sync",
      "--target",
      npxTarget,
      "--json"
    ],
    runtimeEnvironment(npxHome)
  );
  assertLockedCommandReachedTargetState(npxResult, npxTarget);

  process.stdout.write(
    `registry install smoke passed for ${packageSpec} on ${process.platform}/${process.arch}\n`
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function assertLockedCommandReachedTargetState(result, target) {
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()).error, {
    code: "MaintenanceTargetUnavailable",
    facts: {
      path: target,
      reason: "target-not-registered"
    }
  });
}

async function waitForPublishedPackage(packageSpec) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await runNpm(
        ["view", packageSpec, "version"],
        process.env
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    }
  }
  throw lastError;
}

function runtimeEnvironment(home, prependPath) {
  const path = process.env.PATH ?? "";
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH:
        prependPath === undefined
          ? path
          : prependPath + delimiter + path,
      SKILOOM_LOCK_TEST_BINARY: undefined,
      SKILOOM_LOCK_PACKAGE_BINARY: undefined
    }).filter(([, value]) => value !== undefined)
  );
}

function currentHelperPackage() {
  if (process.platform === "linux" && process.arch === "x64") {
    const report = process.report.getReport();
    if (typeof report.header?.glibcVersionRuntime === "string") {
      return "skiloom-lock-linux-x64-gnu";
    }
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "skiloom-lock-darwin-x64";
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "skiloom-lock-darwin-arm64";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "skiloom-lock-win32-x64";
  }
  throw new Error(
    `registry smoke platform is outside the v0 matrix: ${process.platform}/${process.arch}`
  );
}

function runNpm(args, env) {
  return runCommand(process.execPath, [npmCli, ...args], env);
}

function runNpx(args, env) {
  return runCommand(process.execPath, [npxCli, ...args], env);
}

function runCommand(command, args, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} terminated by ${signal}`));
        return;
      }
      if (code !== 0 && !looksLikeSkiloomStructuredFailure(stdout)) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with code ${code}: ${stderr.trim() || stdout.trim()}`
          )
        );
        return;
      }
      resolveResult({ code, stdout, stderr });
    });
  });
}

function looksLikeSkiloomStructuredFailure(stdout) {
  try {
    const value = JSON.parse(stdout);
    return value?.schema === "SKILOOM-CLI-V1" && value?.ok === false;
  } catch {
    return false;
  }
}
