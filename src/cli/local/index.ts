import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  isValidSkillName,
  parsePackageCoordinate
} from "../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../../native/skiloom-lock.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../../runtime/home.js";
import {
  detachAcceptedProjection,
  forgetAcceptedProjection,
  rebindAcceptedProjection,
  renameAcceptedProjection,
  type LocalProjectionOperationResult
} from "../../runtime/orchestration/local-projection/operations.js";
import type {
  MachineRegistry
} from "../../runtime/registry/index.js";
import {
  currentUserHome
} from "../candidate-acceptance.js";
import {
  parseCliStatusArguments,
  readCliStatus
} from "../status.js";
import type {
  ResolvedCliTarget
} from "../target-selector.js";

export type CliLocalOperation =
  | "rename"
  | "detach"
  | "rebind"
  | "forget";

export type CliLocalInvocation = Readonly<{
  operation: CliLocalOperation;
  target: ResolvedCliTarget;
  packageCoordinate: string;
  activationName?: string;
  json: boolean;
}>;

export type CliLocalResult = Readonly<{
  status: LocalProjectionOperationResult["status"];
  target: ResolvedCliTarget;
  targetId: string;
  generation: number;
  packageCoordinate: string;
  projections: ReadonlyArray<Readonly<{
    packageCoordinate: string;
    activationName: string;
    ownership: "managed" | "detached";
  }>>;
  detached: ReadonlyArray<Readonly<{
    packageCoordinate: string;
  }>>;
}>;

export type ParseCliLocalResult =
  | Readonly<{ ok: true; value: CliLocalInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliLocalArguments(
  operation: CliLocalOperation,
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliLocalResult {
  const packageText = argv[0];
  if (
    packageText === undefined ||
    packageText.startsWith("-")
  ) {
    return {
      ok: false,
      reason: operation + " requires a Package coordinate"
    };
  }
  const packageCoordinate =
    parsePackageCoordinate(packageText);
  if (!packageCoordinate.ok) {
    return {
      ok: false,
      reason: operation + " requires owner/repo/package"
    };
  }

  const needsActivation =
    operation === "rename" || operation === "rebind";
  const activationName = needsActivation
    ? argv[1]
    : undefined;
  if (
    needsActivation &&
    (
      activationName === undefined ||
      activationName.startsWith("-") ||
      !isValidSkillName(activationName)
    )
  ) {
    return {
      ok: false,
      reason:
        operation + " requires a valid activation name"
    };
  }

  const optionStart = needsActivation ? 2 : 1;
  const target = parseCliStatusArguments(
    argv.slice(optionStart),
    process.cwd()
  );
  if (!target.ok) {
    return target;
  }

  return {
    ok: true,
    value: {
      operation,
      target: target.value,
      packageCoordinate:
        packageCoordinate.value.canonical,
      ...(activationName === undefined
        ? {}
        : { activationName }),
      json
    }
  };
}

export async function executeCliLocalOperation(
  input: CliLocalInvocation
): Promise<Result<CliLocalResult, ProductError>> {
  const userHome = currentUserHome();
  const home = resolveSkiloomHomePaths(userHome);
  try {
    await mkdir(home.homeRoot, { recursive: true });
  } catch {
    return {
      ok: false,
      error: productError("SkiloomHomeUnavailable", {
        path: home.homeRoot
      })
    };
  }

  const helperExecutable =
    process.env.SKILOOM_LOCK_TEST_BINARY;
  if (helperExecutable === undefined) {
    return {
      ok: false,
      error: productError("UnsupportedPlatformCapability", {
        capability: "operation-lock",
        reason: "helper-missing"
      })
    };
  }

  const acquired = await acquireOperationLock({
    helperExecutable: resolve(helperExecutable),
    lockPath: home.operationLockPath
  });
  if (!acquired.ok) {
    return acquired;
  }

  const operated = await executeWhileLocked(
    input,
    home,
    userHome,
    acquired.value
  );
  const released = await acquired.value.release();
  if (operated.ok && !released.ok) {
    return released;
  }
  return operated;
}

async function executeWhileLocked(
  input: CliLocalInvocation,
  home: SkiloomHomePaths,
  userHome: string,
  lock: OperationLockSession
): Promise<Result<CliLocalResult, ProductError>> {
  const status = await readCliStatus(input.target, userHome);
  if (!status.ok) {
    return status;
  }
  if (status.value.registry === null) {
    return {
      ok: false,
      error: productError("LocalOperationTargetUnavailable", {
        path: input.target.path,
        reason:
          status.value.marker === null
            ? "target-not-registered"
            : "recovery-required"
      })
    };
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

    const base = {
      home,
      targetId: status.value.registry.targetId,
      targetRoot: input.target.path,
      lock,
      registry,
      packageCoordinate: input.packageCoordinate
    };
    const operated =
      input.operation === "rename"
        ? await renameAcceptedProjection({
            ...base,
            activationName: input.activationName!
          })
        : input.operation === "detach"
          ? await detachAcceptedProjection(base)
          : input.operation === "rebind"
            ? await rebindAcceptedProjection({
                ...base,
                activationName: input.activationName!
              })
            : await forgetAcceptedProjection(base);
    if (!operated.ok) {
      return operated;
    }

    return {
      ok: true,
      value: presentLocalResult(
        input,
        operated.value
      )
    };
  } finally {
    registry?.close();
  }
}

function presentLocalResult(
  input: CliLocalInvocation,
  operated: LocalProjectionOperationResult
): CliLocalResult {
  return {
    status: operated.status,
    target: input.target,
    targetId: operated.state.targetId,
    generation: operated.state.generation,
    packageCoordinate: input.packageCoordinate,
    projections: operated.state.projections.map(
      (projection) => ({
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName,
        ownership: projection.ownership
      })
    ),
    detached: operated.state.detachedBaselines.map(
      (baseline) => ({
        packageCoordinate: baseline.packageCoordinate
      })
    )
  };
}

export function formatCliLocalResult(
  result: CliLocalResult
): string {
  const lines = [
    "Target: " + result.target.path,
    "Status: " + result.status,
    "Target ID: " + result.targetId,
    "Generation: " + result.generation,
    "Package: " + result.packageCoordinate,
    "Projections:"
  ];
  if (result.projections.length === 0) {
    lines.push("- none");
  } else {
    for (const projection of result.projections) {
      lines.push(
        "- " + projection.packageCoordinate +
        " -> " + projection.activationName +
        " (" + projection.ownership + ")"
      );
    }
  }
  return lines.join("\n") + "\n";
}
