import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import process from "node:process";

import type {
  ExactExportManifest
} from "../../domain/export-package/index.js";
import {
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../../native/skiloom-lock.js";
import {
  exportFullTarget,
  exportManagedDependencies,
  type ExactExportWarning
} from "../../runtime/export/index.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../../runtime/home.js";
import type {
  MachineRegistry
} from "../../runtime/registry/index.js";
import {
  currentUserHome
} from "../candidate-acceptance.js";
import {
  parseCliStatusArguments,
  preflightCurrentTargetCopy,
  readCliStatus,
  requireCurrentTargetCopy
} from "../status.js";
import type {
  ResolvedCliTarget
} from "../target-selector.js";

export type CliExportInvocation = Readonly<{
  file: string;
  full: boolean;
  target: ResolvedCliTarget;
  json: boolean;
}>;

export type CliExportResult = Readonly<{
  mode: "dependencies" | "full";
  file: string;
  manifest: ExactExportManifest;
}>;

export type CliExportExecution = Readonly<{
  result: CliExportResult;
  warnings: ReadonlyArray<ProductError>;
}>;

export type ParseCliExportResult =
  | Readonly<{ ok: true; value: CliExportInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliExportArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliExportResult {
  const file = argv[0];
  if (file === undefined || file.startsWith("-")) {
    return {
      ok: false,
      reason: "export requires exactly one file"
    };
  }

  let full = false;
  const targetArgs: string[] = [];
  for (const argument of argv.slice(1)) {
    if (argument === "--full") {
      if (full) {
        return {
          ok: false,
          reason: "duplicate --full"
        };
      }
      full = true;
      continue;
    }
    targetArgs.push(argument);
  }

  const target = parseCliStatusArguments(
    targetArgs,
    process.cwd()
  );
  if (!target.ok) {
    return target;
  }
  return {
    ok: true,
    value: {
      file,
      full,
      target: target.value,
      json
    }
  };
}

export async function executeCliExport(
  input: CliExportInvocation
): Promise<Result<CliExportExecution, ProductError>> {
  const userHome = currentUserHome();
  const current = await preflightCurrentTargetCopy(
    input.target,
    userHome
  );
  if (!current.ok) {
    return transferFailure(current.error);
  }
  const home = resolveSkiloomHomePaths(userHome);
  try {
    await mkdir(home.homeRoot, { recursive: true });
  } catch {
    return transferFailure({
      code: "SkiloomHomeUnavailable",
      facts: {}
    });
  }

  const helperExecutable =
    process.env.SKILOOM_LOCK_TEST_BINARY;
  if (helperExecutable === undefined) {
    return transferFailure({
      code: "UnsupportedPlatformCapability",
      facts: {
        capability: "operation-lock",
        reason: "helper-missing"
      }
    });
  }

  const acquired = await acquireOperationLock({
    helperExecutable: resolve(helperExecutable),
    lockPath: home.operationLockPath
  });
  if (!acquired.ok) {
    return transferFailure(acquired.error);
  }

  const exported = await executeExportWhileLocked(
    input,
    home,
    userHome,
    acquired.value
  );
  const released = await acquired.value.release();
  if (exported.ok && !released.ok) {
    return transferFailure(released.error);
  }
  return exported.ok
    ? exported
    : transferFailure(exported.error, input.file);
}

async function executeExportWhileLocked(
  input: CliExportInvocation,
  home: SkiloomHomePaths,
  userHome: string,
  lock: OperationLockSession
): Promise<Result<CliExportExecution, ProductError>> {
  const status = await readCliStatus(
    input.target,
    userHome
  );
  if (!status.ok) {
    return status;
  }
  if (status.value.registry === null) {
    return {
      ok: false,
      error: {
        code: "ExportTargetUnavailable",
        facts: {
          reason:
            status.value.marker === null
              ? "target-not-registered"
              : "recovery-required"
        }
      }
    };
  }
  const current = requireCurrentTargetCopy(status.value);
  if (!current.ok) {
    return current;
  }

  let registry: MachineRegistry | undefined;
  try {
    const { openMachineRegistry } =
      await import("../../runtime/registry/index.js");
    const opened = await openMachineRegistry(home, lock);
    if (!opened.ok) {
      return opened;
    }
    registry = opened.value;

    const common = {
      home,
      targetId: status.value.registry.targetId,
      targetRoot: input.target.path,
      destinationPath: input.file,
      lock,
      registry
    };
    const exported = input.full
      ? await exportFullTarget(common)
      : await exportManagedDependencies(common);
    if (!exported.ok) {
      return exported;
    }

    return {
      ok: true,
      value: {
        result: {
          mode: exported.value.manifest.mode,
          file: basename(input.file),
          manifest: exported.value.manifest
        },
        warnings: exported.value.warnings
      }
    };
  } finally {
    registry?.close();
  }
}

export function formatCliExportResult(
  result: CliExportResult
): string {
  return [
    "Exported: " + result.file,
    "Mode: " + result.mode,
    "Packages: " + result.manifest.packages.length,
    "Sources: " + result.manifest.sources.length
  ].join("\n") + "\n";
}

export function sanitizeTransferError(
  error: ProductError,
  safeFile?: string
): ProductError {
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error.facts)) {
    if (key === "targetId") {
      continue;
    }
    if (key.toLowerCase().includes("path")) {
      continue;
    }
    if (
      key === "subject" &&
      typeof value === "string" &&
      isAbsolute(value)
    ) {
      continue;
    }
    facts[key] = value;
  }
  if (
    safeFile !== undefined &&
    (
      error.code === "ExactExportDestinationExists" ||
      error.code === "ExactExportWriteFailed"
    )
  ) {
    facts.path = basename(safeFile);
  }
  return {
    code: error.code,
    facts
  };
}

function transferFailure(
  error: ProductError,
  safeFile?: string
): Result<never, ProductError> {
  return {
    ok: false,
    error: sanitizeTransferError(error, safeFile)
  };
}

export type { ExactExportWarning };
