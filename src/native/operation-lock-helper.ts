import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  productError,
  type Result
} from "../domain/errors/index.js";
import type { UnsupportedPlatformCapability } from "./skiloom-lock.js";

const TEST_HELPER_ENVIRONMENT = "SKILOOM_LOCK_TEST_BINARY";
const moduleRequire = createRequire(import.meta.url);

export type OperationLockPlatformPackage = Readonly<{
  packageName: string;
  executablePath: string;
}>;

export function operationLockPlatformPackage(
  platform: string,
  arch: string,
  libc: string | null
): OperationLockPlatformPackage | undefined {
  if (platform === "linux" && arch === "x64" && libc === "glibc") {
    return {
      packageName: "skiloom-lock-linux-x64-gnu",
      executablePath: "bin/skiloom-lock"
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      packageName: "skiloom-lock-darwin-x64",
      executablePath: "bin/skiloom-lock"
    };
  }
  if (platform === "darwin" && arch === "arm64") {
    return {
      packageName: "skiloom-lock-darwin-arm64",
      executablePath: "bin/skiloom-lock"
    };
  }
  if (platform === "win32" && arch === "x64") {
    return {
      packageName: "skiloom-lock-win32-x64",
      executablePath: "bin/skiloom-lock.exe"
    };
  }
  return undefined;
}

export function resolveOperationLockHelperExecutable(
  environment: NodeJS.ProcessEnv = process.env
): Result<string, UnsupportedPlatformCapability> {
  const testOverride = environment[TEST_HELPER_ENVIRONMENT]?.trim();
  if (testOverride !== undefined && testOverride.length > 0) {
    return {
      ok: true,
      value: resolve(testOverride)
    };
  }

  const checkoutHelper = resolveCheckoutHelper();
  if (checkoutHelper !== undefined) {
    return {
      ok: true,
      value: checkoutHelper
    };
  }

  const installedHelper = resolveInstalledPlatformHelper();
  if (installedHelper !== undefined) {
    return {
      ok: true,
      value: installedHelper
    };
  }

  return {
    ok: false,
    error: productError("UnsupportedPlatformCapability", {
      capability: "operation-lock",
      reason: "helper-missing"
    })
  };
}

function resolveCheckoutHelper(): string | undefined {
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (packageRoot === undefined) {
    return undefined;
  }

  const executableName =
    process.platform === "win32" ? "skiloom-lock.exe" : "skiloom-lock";
  for (const profile of ["release", "debug"] as const) {
    const candidate = join(
      packageRoot,
      "native",
      "skiloom-lock",
      "target",
      profile,
      executableName
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveInstalledPlatformHelper(): string | undefined {
  const selected = operationLockPlatformPackage(
    process.platform,
    process.arch,
    currentLibc()
  );
  if (selected === undefined) {
    return undefined;
  }

  try {
    return moduleRequire.resolve(
      `${selected.packageName}/${selected.executablePath}`
    );
  } catch {
    return undefined;
  }
}

function currentLibc(): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  const report = process.report.getReport() as Readonly<{
    header?: Readonly<{
      glibcVersionRuntime?: unknown;
    }>;
  }>;
  return typeof report.header?.glibcVersionRuntime === "string"
    ? "glibc"
    : "other";
}

function findPackageRoot(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
