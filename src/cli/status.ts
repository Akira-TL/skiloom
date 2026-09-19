import { lstat } from "node:fs/promises";
import { homedir } from "node:os";

import {
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
import type {
  ResolvedCliTarget
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
