import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { packLockHelper, runNpm } from "./pack-lock-helper.mjs";

const { operationLockPlatformPackage } = await import(
  "../dist/native/operation-lock-helper.js"
);

const libc =
  process.platform === "linux" &&
  typeof process.report.getReport().header?.glibcVersionRuntime === "string"
    ? "glibc"
    : process.platform === "linux"
      ? "other"
      : null;
const selected = operationLockPlatformPackage(
  process.platform,
  process.arch,
  libc
);

if (selected === undefined) {
  throw new Error(
    `current platform is outside the v0 lock-helper matrix: ${process.platform}/${process.arch}/${libc ?? "n/a"}`
  );
}

const target = selected.packageName.replace("skiloom-lock-", "");
const binary = await resolveBuiltHelper(selected.executablePath.endsWith(".exe"));
const root = await mkdtemp(join(tmpdir(), "skiloom-package-install-"));
const packDirectory = join(root, "pack");
const installDirectory = join(root, "install");
const omittedInstallDirectory = join(root, "install-omit-optional");
const home = join(root, "home");
const omittedHome = join(root, "home-omit-optional");
const targetDirectory = join(root, "target");
const omittedTargetDirectory = join(root, "target-omit-optional");

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(omittedHome, { recursive: true });
  await mkdir(targetDirectory, { recursive: true });
  await mkdir(omittedTargetDirectory, { recursive: true });

  const helperTarball = await packLockHelper(target, binary, packDirectory);
  const packedMain = await runNpm([
    "pack",
    resolve("."),
    "--pack-destination",
    packDirectory,
    "--json"
  ]);
  const mainFilename = JSON.parse(packedMain.stdout)?.[0]?.filename;
  assert.equal(typeof mainFilename, "string");
  const mainTarball = join(packDirectory, mainFilename);

  await runNpm([
    "install",
    "--prefix",
    omittedInstallDirectory,
    "--no-audit",
    "--no-fund",
    "--fetch-retries=0",
    "--fetch-timeout=1000",
    "--omit=optional",
    mainTarball
  ]);
  const omittedMain = join(
    omittedInstallDirectory,
    "node_modules",
    "skiloom",
    "dist",
    "cli",
    "main.js"
  );
  const omittedResult = await runNode(
    omittedMain,
    ["sync", "--target", omittedTargetDirectory, "--json"],
    runtimeEnvironment(omittedHome)
  );
  assert.equal(omittedResult.code, 1);
  assert.equal(omittedResult.stderr, "");
  assert.deepEqual(JSON.parse(omittedResult.stdout).error, {
    code: "UnsupportedPlatformCapability",
    facts: {
      capability: "operation-lock",
      reason: "helper-missing"
    }
  });

  await runNpm([
    "install",
    "--prefix",
    installDirectory,
    "--no-audit",
    "--no-fund",
    "--fetch-retries=0",
    "--fetch-timeout=1000",
    helperTarball,
    mainTarball
  ]);

  const installedHelper = join(
    installDirectory,
    "node_modules",
    selected.packageName,
    ...selected.executablePath.split("/")
  );
  await access(installedHelper);

  const installedMain = join(
    installDirectory,
    "node_modules",
    "skiloom",
    "dist",
    "cli",
    "main.js"
  );
  const result = await runNode(
    installedMain,
    ["sync", "--target", targetDirectory, "--json"],
    runtimeEnvironment(home)
  );

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.error, {
    code: "MaintenanceTargetUnavailable",
    facts: {
      path: targetDirectory,
      reason: "target-not-registered"
    }
  });

  process.stdout.write(
    `packed install smoke passed for ${selected.packageName}\n`
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function resolveBuiltHelper(windowsExecutable) {
  const configured = process.env.SKILOOM_LOCK_PACKAGE_BINARY?.trim();
  if (configured !== undefined && configured.length > 0) {
    return resolve(configured);
  }

  const executable = windowsExecutable ? "skiloom-lock.exe" : "skiloom-lock";
  for (const profile of ["release", "debug"]) {
    const candidate = resolve(
      "native",
      "skiloom-lock",
      "target",
      profile,
      executable
    );
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next profile.
    }
  }
  throw new Error(
    "no built skiloom-lock helper found; set SKILOOM_LOCK_PACKAGE_BINARY"
  );
}

function runtimeEnvironment(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SKILOOM_LOCK_TEST_BINARY: undefined,
    SKILOOM_LOCK_PACKAGE_BINARY: undefined
  };
}

function runNode(entry, args, env) {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined)
  );
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: process.cwd(),
      env: cleanEnvironment,
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
        reject(new Error(`packed CLI terminated by ${signal}`));
        return;
      }
      resolveResult({ code, stdout, stderr });
    });
  });
}
