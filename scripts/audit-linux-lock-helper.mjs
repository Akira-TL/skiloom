import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function auditLinuxLockHelper(
  binaryPath,
  maximumGlibc = "2.17"
) {
  const binary = resolve(binaryPath);
  const fileOutput = await runCapture("file", [binary]);
  if (
    !fileOutput.includes("ELF 64-bit") ||
    !fileOutput.includes("x86-64")
  ) {
    throw new Error(
      "Linux lock helper must be an ELF 64-bit x86-64 executable"
    );
  }

  const symbols = await runCapture("objdump", ["-T", binary]);
  const required = requiredGlibcVersions(symbols);
  if (required.length === 0) {
    throw new Error(
      "Linux lock helper has no auditable GLIBC symbol requirements"
    );
  }
  const highest = required.at(-1);
  if (
    highest === undefined ||
    compareVersions(highest, maximumGlibc) > 0
  ) {
    throw new Error(
      "Linux lock helper requires GLIBC " +
        String(highest ?? "unknown") +
        ", above the supported " +
        maximumGlibc +
        " baseline"
    );
  }

  process.stdout.write(
    "Linux lock helper GLIBC baseline OK: max required " +
      highest +
      " <= " +
      maximumGlibc +
      "\n"
  );
  return highest;
}

export function requiredGlibcVersions(symbolTable) {
  const versions = new Set();
  for (const match of symbolTable.matchAll(
    /GLIBC_(\d+(?:\.\d+)+)/gu
  )) {
    const version = match[1];
    if (version !== undefined) {
      versions.add(version);
    }
  }
  return [...versions].sort(compareVersions);
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(
    leftParts.length,
    rightParts.length
  );
  for (let index = 0; index < length; index += 1) {
    const difference =
      (leftParts[index] ?? 0) -
      (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function runCapture(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
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
            command +
              " " +
              args.join(" ") +
              " failed with code " +
              String(code ?? "null") +
              (signal === null ? "" : " signal " + signal) +
              (stderr.length === 0
                ? ""
                : ": " + stderr.trim())
          )
        );
        return;
      }
      resolveResult(stdout);
    });
  });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href ===
    import.meta.url
) {
  const binaryPath = process.argv[2];
  const maximumGlibc = process.argv[3] ?? "2.17";
  if (binaryPath === undefined) {
    throw new Error(
      "usage: node scripts/audit-linux-lock-helper.mjs " +
        "<binary> [max-glibc]"
    );
  }
  await auditLinuxLockHelper(
    binaryPath,
    maximumGlibc
  );
}
