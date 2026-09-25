import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  productError,
  type Result
} from "../domain/errors/index.js";
import type { UnsupportedPlatformCapability } from "./skiloom-lock.js";

const TEST_HELPER_ENVIRONMENT = "SKILOOM_LOCK_TEST_BINARY";

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

  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (packageRoot !== undefined) {
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
        return {
          ok: true,
          value: candidate
        };
      }
    }
  }

  return {
    ok: false,
    error: productError("UnsupportedPlatformCapability", {
      capability: "operation-lock",
      reason: "helper-missing"
    })
  };
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
