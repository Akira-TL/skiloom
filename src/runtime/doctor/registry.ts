import type { DatabaseSync } from "node:sqlite";

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
