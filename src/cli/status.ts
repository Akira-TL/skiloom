import { lstat } from "node:fs/promises";
import { homedir } from "node:os";

import {
  productError,
  type ProductError,
  type Result
} from "../domain/errors/index.js";
import type {
  TargetRecoveryMarkerFacts
} from "../domain/target/recovery.js";
import {
  resolveSkiloomHomePaths
} from "../runtime/home.js";
import {
  readTargetStateMarkerFile,
  type ReadTargetStateMarkerFileError
} from "../runtime/target-state-marker.js";
import {
  resolveCliTarget,
  type ResolvedCliTarget
} from "./target-selector.js";

export type StatusRegistryReadFailed = ProductError<
  "StatusRegistryReadFailed",
  Readonly<{ path: string }>
>;

export type StatusRegistryAmbiguousTarget = ProductError<
  "StatusRegistryAmbiguousTarget",
  Readonly<{
    path: string;
    targetIds: ReadonlyArray<string>;
  }>
>;

export type ReadCliStatusError =
  | ReadTargetStateMarkerFileError
  | StatusRegistryReadFailed
  | StatusRegistryAmbiguousTarget;

export type CliRegistryStatus = Readonly<{
  targetId: string;
  generation: number;
  directRequirements: number;
  sources: number;
  packages: number;
  dependencyEdges: number;
  projections: number;
  detached: number;
  dependencyObservations: number;
  pendingOperations: number;
}>;

export type CliStatusResult = Readonly<{
  target: ResolvedCliTarget;
  marker: TargetRecoveryMarkerFacts | null;
  registry: CliRegistryStatus | null;
}>;

export type TargetCopyRequiresSyncOrFork = ProductError<
  "TargetCopyRequiresSyncOrFork",
  Readonly<{
    markerGeneration: number;
    registryGeneration: number;
    actions: ReadonlyArray<"sync" | "fork">;
  }>
>;

export function requireCurrentTargetCopy(
  status: CliStatusResult
): Result<void, TargetCopyRequiresSyncOrFork> {
  if (
    status.marker !== null &&
    status.registry !== null &&
    status.marker.targetId === status.registry.targetId &&
    status.marker.generation < status.registry.generation
  ) {
    return {
      ok: false,
      error: productError("TargetCopyRequiresSyncOrFork", {
        markerGeneration: status.marker.generation,
        registryGeneration: status.registry.generation,
        actions: ["sync", "fork"] as const
      })
    };
  }
  return {
    ok: true,
    value: undefined
  };
}

export async function preflightCurrentTargetCopy(
  target: ResolvedCliTarget,
  userHome: string
): Promise<
  Result<
    void,
    ReadCliStatusError | TargetCopyRequiresSyncOrFork
  >
> {
  const status = await readCliStatus(target, userHome);
  if (!status.ok) {
    return status;
  }
  return requireCurrentTargetCopy(status.value);
}

export function parseCliStatusArguments(
  argv: ReadonlyArray<string>,
  cwd: string
):
  | Readonly<{ ok: true; value: ResolvedCliTarget }>
  | Readonly<{ ok: false; reason: string }> {
  let target: string | undefined;
  let host: string | undefined;
  let scope: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (
      option !== "--target" &&
      option !== "--host" &&
      option !== "--scope"
    ) {
      return {
        ok: false,
        reason: "unknown option: " + option
      };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        reason: "missing value for " + option
      };
    }
    index += 1;

    if (option === "--target") {
      if (target !== undefined) {
        return {
          ok: false,
          reason: "duplicate --target"
        };
      }
      target = value;
    } else if (option === "--host") {
      if (host !== undefined) {
        return {
          ok: false,
          reason: "duplicate --host"
        };
      }
      host = value;
    } else {
      if (scope !== undefined) {
        return {
          ok: false,
          reason: "duplicate --scope"
        };
      }
      scope = value;
    }
  }

  return resolveCliTarget({
    cwd,
    ...(target === undefined ? {} : { target }),
    ...(host === undefined ? {} : { host }),
    ...(scope === undefined ? {} : { scope })
  });
}

export async function readCliStatus(
  target: ResolvedCliTarget,
  userHome: string = process.env.HOME ??
    process.env.USERPROFILE ??
    homedir()
): Promise<Result<CliStatusResult, ReadCliStatusError>> {
  const marker = await readTargetStateMarkerFile(target.path);
  if (!marker.ok) {
    return marker;
  }

  const home = resolveSkiloomHomePaths(userHome);
  if (!(await regularFileExists(home.registryPath))) {
    return {
      ok: true,
      value: {
        target,
        marker: marker.value,
        registry: null
      }
    };
  }

  const { readRegistryStatus } =
    await import("./status-registry.js");
  const registry = readRegistryStatus(
    home.registryPath,
    target.path,
    marker.value?.targetId
  );
  if (!registry.ok) {
    return registry;
  }

  return {
    ok: true,
    value: {
      target,
      marker: marker.value,
      registry: registry.value
    }
  };
}

async function regularFileExists(
  path: string
): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
