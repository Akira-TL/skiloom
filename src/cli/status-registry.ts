import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  productError,
  type Result
} from "../domain/errors/index.js";
import {
  withRegistryReadSnapshot
} from "../runtime/registry/read.js";
import type {
  CliRegistryStatus,
  StatusRegistryAmbiguousTarget,
  StatusRegistryReadFailed
} from "./status.js";

export function readRegistryStatus(
  registryPath: string,
  targetPath: string,
  markerTargetId: string | undefined
): Result<
  CliRegistryStatus | null,
  StatusRegistryReadFailed | StatusRegistryAmbiguousTarget
> {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(registryPath, {
      readOnly: true
    });
  } catch {
    return registryReadFailed(registryPath);
  }

  try {
    return readRegistryStatusFromDatabase(
      database,
      registryPath,
      targetPath,
      markerTargetId
    );
  } catch {
    return registryReadFailed(registryPath);
  } finally {
    database.close();
  }
}

export function readRegistryStatusFromDatabase(
  database: DatabaseSync,
  registryPath: string,
  targetPath: string,
  markerTargetId: string | undefined
): Result<
  CliRegistryStatus | null,
  StatusRegistryReadFailed | StatusRegistryAmbiguousTarget
> {
  return withRegistryReadSnapshot(database, () => {
    const resolvedTargetPath = resolve(targetPath);
    const targetIds = lookupTargetIds(
      database,
      resolvedTargetPath,
      markerTargetId
    );
    if (targetIds.length === 0) {
      return { ok: true, value: null };
    }
    if (targetIds.length > 1) {
      return {
        ok: false,
        error: productError("StatusRegistryAmbiguousTarget", {
          path: resolvedTargetPath,
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
  });
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
