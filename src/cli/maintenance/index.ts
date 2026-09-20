import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

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
  repairExactAcceptedTarget,
  syncExactAcceptedTarget
} from "../../runtime/orchestration/exact-state-maintenance.js";
import type {
  MachineRegistry
} from "../../runtime/registry/index.js";
import {
  createGitHubJsonFetchTransport
} from "../../runtime/source/github/index.js";
import {
  currentUserHome
} from "../candidate-acceptance.js";
import {
  resolveGitHubCredentialEnvironment
} from "../github-credential/index.js";
import {
  parseCliStatusArguments,
  readCliStatus
} from "../status.js";
import type {
  ResolvedCliTarget
} from "../target-selector.js";

export type CliSyncInvocation = Readonly<{
  target: ResolvedCliTarget;
  json: boolean;
}>;

export type CliRepairInvocation = CliSyncInvocation;

export type CliMaintenanceResult = Readonly<{
  status: "no-op" | "synchronized" | "repaired";
  target: ResolvedCliTarget;
  targetId: string;
  generation: number;
  actions: ReadonlyArray<Readonly<{
    activationName: string;
    action: string;
    classification: string;
  }>>;
  repairedPackages: ReadonlyArray<string>;
  repairedProjections: ReadonlyArray<string>;
}>;

export type ParseCliSyncResult =
  | Readonly<{ ok: true; value: CliSyncInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export type ParseCliRepairResult = ParseCliSyncResult;

export function parseCliSyncArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliSyncResult {
  const target = parseCliStatusArguments(
    argv,
    process.cwd()
  );
  return target.ok
    ? {
        ok: true,
        value: {
          target: target.value,
          json
        }
      }
    : target;
}

export function parseCliRepairArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliRepairResult {
  return parseCliSyncArguments(argv, json);
}

export async function executeCliSync(
  input: CliSyncInvocation
): Promise<Result<CliMaintenanceResult, ProductError>> {
  return executeCliMaintenance(input, "sync");
}

export async function executeCliRepair(
  input: CliRepairInvocation
): Promise<Result<CliMaintenanceResult, ProductError>> {
  return executeCliMaintenance(input, "repair");
}

async function executeCliMaintenance(
  input: CliSyncInvocation,
  kind: "sync" | "repair"
): Promise<Result<CliMaintenanceResult, ProductError>> {
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

  const operated = await executeMaintenanceWhileLocked(
    input,
    home,
    userHome,
    acquired.value,
    kind
  );
  const released = await acquired.value.release();
  if (operated.ok && !released.ok) {
    return released;
  }
  return operated;
}

async function executeMaintenanceWhileLocked(
  input: CliSyncInvocation,
  home: SkiloomHomePaths,
  userHome: string,
  lock: OperationLockSession,
  kind: "sync" | "repair"
): Promise<Result<CliMaintenanceResult, ProductError>> {
  const status = await readCliStatus(input.target, userHome);
  if (!status.ok) {
    return status;
  }
  if (status.value.registry === null) {
    return {
      ok: false,
      error: productError("MaintenanceTargetUnavailable", {
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

    const maintained =
      kind === "sync"
        ? await syncExactAcceptedTarget({
            home,
            targetId: status.value.registry.targetId,
            targetRoot: input.target.path,
            lock,
            registry
          })
        : await repairExactAcceptedTarget({
            home,
            targetId: status.value.registry.targetId,
            targetRoot: input.target.path,
            lock,
            registry,
            transport: createGitHubJsonFetchTransport(),
            sourceCachePath: home.sourceCachePath,
            ...credentialOption()
          });
    if (!maintained.ok) {
      return maintained;
    }

    return {
      ok: true,
      value: {
        status: maintained.value.status,
        target: input.target,
        targetId: maintained.value.state.targetId,
        generation: maintained.value.state.generation,
        actions: maintained.value.actions.map((action) => ({
          activationName: action.activationName,
          action: action.action,
          classification: action.classification
        })),
        repairedPackages:
          "repairedPackages" in maintained.value
            ? maintained.value.repairedPackages
            : [],
        repairedProjections:
          "repairedProjections" in maintained.value
            ? maintained.value.repairedProjections
            : []
      }
    };
  } finally {
    registry?.close();
  }
}

function credentialOption():
  | Readonly<{ credential: string }>
  | Readonly<Record<never, never>> {
  const credential =
    resolveGitHubCredentialEnvironment(process.env);
  return credential === undefined
    ? {}
    : { credential };
}

export function formatCliMaintenanceResult(
  result: CliMaintenanceResult
): string {
  const lines = [
    "Target: " + result.target.path,
    "Status: " + result.status,
    "Target ID: " + result.targetId,
    "Generation: " + result.generation,
    "Actions:"
  ];
  if (result.actions.length === 0) {
    lines.push("- none");
  } else {
    for (const action of result.actions) {
      lines.push(
        "- " + action.activationName +
        ": " + action.action +
        " (" + action.classification + ")"
      );
    }
  }
  lines.push("Repaired Packages:");
  if (result.repairedPackages.length === 0) {
    lines.push("- none");
  } else {
    for (const packageCoordinate of result.repairedPackages) {
      lines.push("- " + packageCoordinate);
    }
  }
  lines.push("Repaired Projections:");
  if (result.repairedProjections.length === 0) {
    lines.push("- none");
  } else {
    for (const packageCoordinate of result.repairedProjections) {
      lines.push("- " + packageCoordinate);
    }
  }
  return lines.join("\n") + "\n";
}
