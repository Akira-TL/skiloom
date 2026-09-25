import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = new Map([
  [
    "linux-x64-gnu",
    {
      packageName: "skiloom-lock-linux-x64-gnu",
      executable: "skiloom-lock",
      os: ["linux"],
      cpu: ["x64"],
      libc: "glibc"
    }
  ],
  [
    "darwin-x64",
    {
      packageName: "skiloom-lock-darwin-x64",
      executable: "skiloom-lock",
      os: ["darwin"],
      cpu: ["x64"],
      libc: undefined
    }
  ],
  [
    "darwin-arm64",
    {
      packageName: "skiloom-lock-darwin-arm64",
      executable: "skiloom-lock",
      os: ["darwin"],
      cpu: ["arm64"],
      libc: undefined
    }
  ],
  [
    "win32-x64",
    {
      packageName: "skiloom-lock-win32-x64",
      executable: "skiloom-lock.exe",
      os: ["win32"],
      cpu: ["x64"],
      libc: undefined
    }
  ]
]);

export async function packLockHelper(target, binaryPath, outputDirectory) {
  const metadata = TARGETS.get(target);
  if (metadata === undefined) {
    throw new Error(`unsupported lock helper package target: ${target}`);
  }

  const sourceDirectory = resolve("packages", metadata.packageName);
  const binary = resolve(binaryPath);
  const output = resolve(outputDirectory);
  await stat(binary);

  const rootPackage = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const helperPackage = JSON.parse(
    await readFile(join(sourceDirectory, "package.json"), "utf8")
  );
  if (helperPackage.name !== metadata.packageName) {
    throw new Error(`unexpected helper package name for ${target}`);
  }
  if (helperPackage.version !== rootPackage.version) {
    throw new Error(
      `helper package ${metadata.packageName} version ${helperPackage.version} does not match skiloom ${rootPackage.version}`
    );
  }
  if (!sameStringArray(helperPackage.os, metadata.os)) {
    throw new Error(`unexpected os metadata for ${metadata.packageName}`);
  }
  if (!sameStringArray(helperPackage.cpu, metadata.cpu)) {
    throw new Error(`unexpected cpu metadata for ${metadata.packageName}`);
  }
  if (helperPackage.libc !== metadata.libc) {
    throw new Error(`unexpected libc metadata for ${metadata.packageName}`);
  }
  if (rootPackage.optionalDependencies?.[metadata.packageName] !== rootPackage.version) {
    throw new Error(
      `skiloom optional dependency for ${metadata.packageName} must equal ${rootPackage.version}`
    );
  }

  await mkdir(output, { recursive: true });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "skiloom-lock-package-"));
  const stagingDirectory = join(temporaryRoot, metadata.packageName);

  try {
    await cp(sourceDirectory, stagingDirectory, { recursive: true });
    const stagedBinDirectory = join(stagingDirectory, "bin");
    await mkdir(stagedBinDirectory, { recursive: true });
    const stagedBinary = join(stagedBinDirectory, metadata.executable);
    await copyFile(binary, stagedBinary);
    if (!target.startsWith("win32-")) {
      await chmod(stagedBinary, 0o755);
    }

    const packed = await runNpm([
      "pack",
      stagingDirectory,
      "--pack-destination",
      output,
      "--json"
    ]);
    const parsed = JSON.parse(packed.stdout);
    const filename = parsed?.[0]?.filename;
    if (typeof filename !== "string" || filename.length === 0) {
      throw new Error("npm pack did not return a helper tarball filename");
    }
    return resolve(output, basename(filename));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export async function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath === undefined ? "npm" : process.execPath;
  const commandArgs = npmExecPath === undefined ? args : [npmExecPath, ...args];

  return new Promise((resolveResult, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
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
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `npm ${args.join(" ")} failed with code ${code ?? "null"}${signal === null ? "" : ` signal ${signal}`}: ${stderr.trim()}`
          )
        );
        return;
      }
      resolveResult({ stdout, stderr });
    });
  });
}

async function main() {
  const [target, binaryPath, outputDirectory] = process.argv.slice(2);
  if (
    target === undefined ||
    binaryPath === undefined ||
    outputDirectory === undefined
  ) {
    throw new Error(
      "usage: node scripts/pack-lock-helper.mjs <target> <binary-path> <output-directory>"
    );
  }
  const tarball = await packLockHelper(target, binaryPath, outputDirectory);
  process.stdout.write(`${tarball}\n`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
