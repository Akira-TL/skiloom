import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  const registry = await readRegistryStatus(
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

async function readRegistryStatus(
  registryPath: string,
  targetPath: string,
  markerTargetId: string | undefined
): Promise<
  Result<
    CliRegistryStatus | null,
    StatusRegistryReadFailed | StatusRegistryAmbiguousTarget
  >
> {
  if (!(await regularFileExists(registryPath))) {
    return { ok: true, value: null };
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(registryPath, {
      readOnly: true
    });
  } catch {
    return registryReadFailed(registryPath);
  }

  try {
    const targetIds = lookupTargetIds(
      database,
      resolve(targetPath),
      markerTargetId
    );
    if (targetIds.length === 0) {
      return { ok: true, value: null };
    }
    if (targetIds.length > 1) {
      return {
        ok: false,
        error: productError("StatusRegistryAmbiguousTarget", {
          path: resolve(targetPath),
          targetIds
        })
      };
    }

    const targetId = targetIds[0]!;
    const target = database
      .prepare(
        "SELECT generation FROM targets WHERE target_id = ?"
      )
      .get(targetId);
    if (
      target === undefined ||
      typeof target.generation !== "number" ||
      !Number.isSafeInteger(target.generation)
    ) {
      return registryReadFailed(registryPath);
    }

    return {
      ok: true,
      value: {
        targetId,
        generation: target.generation,
        directRequirements: countRows(
          database,
          "direct_requirements",
          targetId
        ),
        sources: countRows(
          database,
          "resolved_sources",
          targetId
        ),
        packages: countRows(
          database,
          "resolved_packages",
          targetId
        ),
        dependencyEdges: countRows(
          database,
          "dependency_edges",
          targetId
        ),
        projections: countRows(
          database,
          "projections",
          targetId
        ),
        detached: countRows(
          database,
          "detached_baselines",
          targetId
        ),
        dependencyObservations: countRows(
          database,
          "dependency_observations",
          targetId
        ),
        pendingOperations: countRows(
          database,
          "pending_operations",
          targetId
        )
      }
    };
  } catch {
    return registryReadFailed(registryPath);
  } finally {
    database.close();
  }
}

function lookupTargetIds(
  database: DatabaseSync,
  targetPath: string,
  markerTargetId: string | undefined
): ReadonlyArray<string> {
  const ids = new Set<string>();

  if (markerTargetId !== undefined) {
    const target = database
      .prepare(
        "SELECT target_id FROM targets WHERE target_id = ?"
      )
      .get(markerTargetId);
    if (typeof target?.target_id === "string") {
      ids.add(target.target_id);
    }
  }

  const rows = database
    .prepare(
      "SELECT target_id FROM target_locations WHERE path = ? ORDER BY target_id"
    )
    .all(targetPath);
  for (const row of rows) {
    if (typeof row.target_id !== "string") {
      throw new Error("invalid target_id");
    }
    ids.add(row.target_id);
  }

  return [...ids].sort(compareUtf8);
}

function countRows(
  database: DatabaseSync,
  table: string,
  targetId: string
): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE target_id = ?`
    )
    .get(targetId);
  if (
    row === undefined ||
    typeof row.count !== "number" ||
    !Number.isSafeInteger(row.count)
  ) {
    throw new Error("invalid count");
  }
  return row.count;
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

function registryReadFailed(
  path: string
): Result<never, StatusRegistryReadFailed> {
  return {
    ok: false,
    error: productError("StatusRegistryReadFailed", {
      path
    })
  };
}

function compareUtf8(
  left: string,
  right: string
): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
