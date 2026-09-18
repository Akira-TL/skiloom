import { lstat, rm, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  resolve
} from "node:path";

import type {
  RegistryTargetState,
  RegistryTargetStateInput
} from "../registry/index.js";

export function sameAcceptedState(
  actual: RegistryTargetState,
  expected: RegistryTargetStateInput
): boolean {
  return (
    canonicalAcceptedStateKey({
      targetId: actual.targetId,
      locations: actual.locations,
      directRequirements: actual.directRequirements,
      resolvedSources: actual.resolvedSources,
      resolvedPackages: actual.resolvedPackages,
      dependencyEdges: actual.dependencyEdges,
      projections: actual.projections,
      detachedBaselines: actual.detachedBaselines,
      dependencyObservations: actual.dependencyObservations
    }) === canonicalAcceptedStateKey(expected)
  );
}

export function isSafePendingStagingPath(
  targetRoot: string,
  action: Readonly<{
    stagingPath: string;
    activationName: string;
  }>
): boolean {
  if (!isAbsolute(action.stagingPath)) {
    return false;
  }
  if (resolve(dirname(action.stagingPath)) !== resolve(targetRoot)) {
    return false;
  }
  return basename(action.stagingPath).startsWith(
    ".skiloom-stage-" + action.activationName + "-"
  );
}

export async function removePendingStagingPath(
  path: string
): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error("pending staging path is not a directory");
  }
  await rm(path, { recursive: true, force: false });
}

function canonicalAcceptedStateKey(
  state: RegistryTargetStateInput
): string {
  return JSON.stringify({
    targetId: state.targetId,
    locations: [...state.locations].sort((left, right) =>
      compareStrings(left.path, right.path)
    ),
    directRequirements: [...state.directRequirements].sort((left, right) =>
      compareStrings(
        `${left.kind}\u0000${left.coordinate}`,
        `${right.kind}\u0000${right.coordinate}`
      )
    ),
    resolvedSources: [...state.resolvedSources].sort((left, right) =>
      compareStrings(
        left.repositoryCoordinate,
        right.repositoryCoordinate
      )
    ),
    resolvedPackages: [...state.resolvedPackages].sort((left, right) =>
      compareStrings(left.packageCoordinate, right.packageCoordinate)
    ),
    dependencyEdges: [...state.dependencyEdges].sort((left, right) =>
      compareStrings(
        `${left.fromPackage}\u0000${left.toPackage}`,
        `${right.fromPackage}\u0000${right.toPackage}`
      )
    ),
    projections: [...state.projections].sort((left, right) =>
      compareStrings(left.packageCoordinate, right.packageCoordinate)
    ),
    detachedBaselines: [...state.detachedBaselines].sort((left, right) =>
      compareStrings(left.packageCoordinate, right.packageCoordinate)
    ),
    dependencyObservations: [...state.dependencyObservations].sort(
      (left, right) =>
        compareStrings(
          `${left.packageCoordinate}\u0000${left.kind}\u0000${left.name}`,
          `${right.packageCoordinate}\u0000${right.kind}\u0000${right.name}`
        )
    )
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
