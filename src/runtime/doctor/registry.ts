import type { DatabaseSync } from "node:sqlite";

import type {
  RegistryPendingOperation,
  RegistryTargetState
} from "../registry/model.js";
import {
  readPendingOperations,
  readTargetRows,
  withRegistryReadSnapshot
} from "../registry/read.js";
import {
  CURRENT_REGISTRY_SCHEMA_VERSION
} from "../registry/schema.js";

export type DoctorRegistryConnectionIssue =
  | Readonly<{
      kind: "schema-mismatch";
      actualVersion: number | null;
      currentVersion: number;
    }>
  | Readonly<{
      kind: "integrity-failed";
      reason:
        | "integrity-check"
        | "integrity-check-failed";
    }>;

export type DoctorRegistrySnapshot = Readonly<{
  connectionIssues: ReadonlyArray<DoctorRegistryConnectionIssue>;
  locationTargetIds: ReadonlyArray<string>;
  targetLookupFailed: boolean;
  targetId: string | null;
  state: RegistryTargetState | undefined;
  stateReadFailed: boolean;
  pendingOperations: ReadonlyArray<RegistryPendingOperation>;
  pendingReadFailed: boolean;
}>;

export function readDoctorRegistrySnapshot(
  database: DatabaseSync,
  targetRoot: string,
  markerTargetId: string | null
): DoctorRegistrySnapshot {
  return withRegistryReadSnapshot(database, () => {
    const connectionIssues =
      inspectRegistryConnection(database);

    let locationTargetIds: ReadonlyArray<string> = [];
    let targetLookupFailed = false;
    try {
      locationTargetIds = targetIdsAtPath(
        database,
        targetRoot
      );
    } catch {
      targetLookupFailed = true;
    }

    const targetId =
      locationTargetIds[0] ?? markerTargetId;
    let state: RegistryTargetState | undefined;
    let stateReadFailed = false;
    let pendingOperations:
      ReadonlyArray<RegistryPendingOperation> = [];
    let pendingReadFailed = false;

    if (targetId !== null) {
      try {
        state = readTargetRows(database, targetId);
      } catch {
        stateReadFailed = true;
      }
      if (state !== undefined) {
        try {
          pendingOperations =
            readPendingOperations(database);
        } catch {
          pendingReadFailed = true;
        }
      }
    }

    return {
      connectionIssues,
      locationTargetIds,
      targetLookupFailed,
      targetId,
      state,
      stateReadFailed,
      pendingOperations,
      pendingReadFailed
    };
  });
}

export function targetIdsAtPath(
  database: DatabaseSync,
  targetRoot: string
): ReadonlyArray<string> {
  const rows = database
    .prepare(
      "SELECT target_id FROM target_locations WHERE path = ? ORDER BY target_id"
    )
    .all(targetRoot);
  return rows.flatMap((row) =>
    typeof row.target_id === "string"
      ? [row.target_id]
      : []
  );
}

export function inspectRegistryConnection(
  database: DatabaseSync
): ReadonlyArray<DoctorRegistryConnectionIssue> {
  const issues: DoctorRegistryConnectionIssue[] = [];
  try {
    const versionRow = database
      .prepare("PRAGMA user_version")
      .get();
    const version = versionRow === undefined
      ? undefined
      : Object.values(versionRow)[0];
    if (version !== CURRENT_REGISTRY_SCHEMA_VERSION) {
      issues.push({
        kind: "schema-mismatch",
        actualVersion:
          typeof version === "number"
            ? version
            : null,
        currentVersion:
          CURRENT_REGISTRY_SCHEMA_VERSION
      });
    }

    const rows = database
      .prepare("PRAGMA integrity_check")
      .all();
    if (
      rows.length !== 1 ||
      Object.values(rows[0] ?? {})[0] !== "ok"
    ) {
      issues.push({
        kind: "integrity-failed",
        reason: "integrity-check"
      });
    }
  } catch {
    issues.push({
      kind: "integrity-failed",
      reason: "integrity-check-failed"
    });
  }
  return issues;
}
