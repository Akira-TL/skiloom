import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type {
  RegistryDependencyEdge,
  RegistryDependencyObservation,
  RegistryDetachedBaseline,
  RegistryDirectRequirement,
  RegistryProjection,
  RegistryResolvedPackage,
  RegistryResolvedSource,
  RegistryTargetLocation,
  RegistryTargetState,
  RegistryPendingOperation,
  RegistryPendingProjectionAction
} from "./model.js";

export function withRegistryReadSnapshot<Value>(
  database: DatabaseSync,
  read: () => Value
): Value {
  database.exec("BEGIN");
  try {
    const value = read();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original read failure.
    }
    throw error;
  }
}

export function readTargetRows(
  database: DatabaseSync,
  targetId: string
): RegistryTargetState | undefined {
  const target = database
    .prepare("SELECT generation FROM targets WHERE target_id = ?")
    .get(targetId);
  if (target === undefined) {
    return undefined;
  }

  return {
    targetId,
    generation: numberField(target, "generation"),
    locations: readLocations(database, targetId),
    directRequirements: readDirectRequirements(database, targetId),
    resolvedSources: readResolvedSources(database, targetId),
    resolvedPackages: readResolvedPackages(database, targetId),
    dependencyEdges: readDependencyEdges(database, targetId),
    projections: readProjections(database, targetId),
    detachedBaselines: readDetachedBaselines(database, targetId),
    dependencyObservations: readObservations(database, targetId)
  };
}

function readLocations(
  database: DatabaseSync,
  targetId: string
): ReadonlyArray<RegistryTargetLocation> {
  return database
    .prepare(`
      SELECT path, observed_generation
      FROM target_locations
      WHERE target_id = ?
      ORDER BY path
    `)
    .all(targetId)
    .map((row) => ({
      path: stringField(row, "path"),
      observedGeneration: nullableNumberField(row, "observed_generation")
    }));
}

function readDirectRequirements(
  database: DatabaseSync,
  targetId: string
): ReadonlyArray<RegistryDirectRequirement> {
  return database
    .prepare(`
      SELECT requirement_kind, target_coordinate, source_kind,
             version_requirement, git_requested_ref
      FROM direct_requirements
      WHERE target_id = ?
      ORDER BY requirement_kind, target_coordinate
    `)
    .all(targetId)
    .map((row) => {
      const kind = stringField(row, "requirement_kind");
      const coordinate = stringField(row, "target_coordinate");
      const sourceKind = stringField(row, "source_kind");
      if (kind !== "package" && kind !== "repository") {
        throw new Error(`invalid registry requirement kind: ${kind}`);
      }
      if (sourceKind === "github-release") {
        return {
          kind,
          coordinate,
          sourceKind,
          versionRequirement: nullableStringField(row, "version_requirement")
        };
      }
      if (sourceKind === "git") {
        return {
          kind,
          coordinate,
          sourceKind,
          requestedRef: stringField(row, "git_requested_ref")
        };
      }
      throw new Error(`invalid registry source kind: ${sourceKind}`);
    });
}

function readResolvedSources(
  database: DatabaseSync,
  targetId: string
): ReadonlyArray<RegistryResolvedSource> {
  return database
    .prepare(`
      SELECT repository_coordinate, source_kind, release_version,
             actual_tag, git_requested_ref, exact_commit, immutable_signal
      FROM resolved_sources
      WHERE target_id = ?
      ORDER BY repository_coordinate
    `)
    .all(targetId)
    .map((row) => {
      const repositoryCoordinate = stringField(row, "repository_coordinate");
      const sourceKind = stringField(row, "source_kind");
      const exactCommit = stringField(row, "exact_commit");
      if (sourceKind === "github-release") {
        const immutable = nullableNumberField(row, "immutable_signal");
        return {
          repositoryCoordinate,
          sourceKind,
          version: stringField(row, "release_version"),
          actualTag: stringField(row, "actual_tag"),
          exactCommit,
          immutable: immutable === null ? null : immutable === 1
        };
      }
      if (sourceKind === "git") {
        return {
          repositoryCoordinate,
          sourceKind,
          requestedRef: stringField(row, "git_requested_ref"),
          exactCommit
        };
      }
      throw new Error(`invalid registry source kind: ${sourceKind}`);
    });
}

function readResolvedPackages(
  database: DatabaseSync,
  targetId: string
): ReadonlyArray<RegistryResolvedPackage> {
  return database
    .prepare(`
      SELECT package_coordinate, repository_coordinate, package_root, content_digest
      FROM resolved_packages
      WHERE target_id = ?
      ORDER BY package_coordinate
    `)
    .all(targetId)
    .map((row) => ({
      packageCoordinate: stringField(row, "package_coordinate"),
      repositoryCoordinate: stringField(row, "repository_coordinate"),
      packageRoot: stringField(row, "package_root"),
      contentDigest: stringField(row, "content_digest")
    }));
}

function readDependencyEdges(
  database: DatabaseSync,
  targetId: string
): ReadonlyArray<RegistryDependencyEdge> {
  return database
    .prepare(`
      SELECT from_package, to_package
      FROM dependency_edges
      WHERE target_id = ?
      ORDER BY from_package, to_package
    `)
    .all(targetId)
    .map((row) => ({
      fromPackage: stringField(row, "from_package"),
      toPackage: stringField(row, "to_package")
    }));
}

function readProjections(
  database: DatabaseSync,
  targetId: string
): ReadonlyArray<RegistryProjection> {
  return database
    .prepare(`
      SELECT package_coordinate, activation_name, ownership, materialization, transform_json
      FROM projections
      WHERE target_id = ?
      ORDER BY package_coordinate
    `)
    .all(targetId)
    .map((row) => {
      const ownership = stringField(row, "ownership");
      const materialization = stringField(row, "materialization");
      if (ownership !== "managed" && ownership !== "detached") {
        throw new Error(`invalid registry projection ownership: ${ownership}`);
      }
      if (
        materialization !== "symlink" &&
        materialization !== "junction" &&
        materialization !== "copy"
      ) {
        throw new Error(`invalid registry materialization: ${materialization}`);
      }
      return {
        packageCoordinate: stringField(row, "package_coordinate"),
        activationName: stringField(row, "activation_name"),
        ownership,
        materialization,
        transformJson: nullableStringField(row, "transform_json")
      };
    });
}

function readDetachedBaselines(
  database: DatabaseSync,
  targetId: string
): ReadonlyArray<RegistryDetachedBaseline> {
  return database
    .prepare(`
      SELECT package_coordinate, repository_coordinate, source_kind,
             release_version, actual_tag, git_requested_ref, exact_commit,
             package_root, content_digest
      FROM detached_baselines
      WHERE target_id = ?
      ORDER BY package_coordinate
    `)
    .all(targetId)
    .map((row) => {
      const packageCoordinate = stringField(row, "package_coordinate");
      const repositoryCoordinate = stringField(row, "repository_coordinate");
      const sourceKind = stringField(row, "source_kind");
      const exactCommit = stringField(row, "exact_commit");
      const packageRoot = stringField(row, "package_root");
      const contentDigest = stringField(row, "content_digest");
      if (sourceKind === "github-release") {
        return {
          packageCoordinate,
          repositoryCoordinate,
          sourceKind,
          version: stringField(row, "release_version"),
          actualTag: stringField(row, "actual_tag"),
          exactCommit,
          packageRoot,
          contentDigest
        };
      }
      if (sourceKind === "git") {
        return {
          packageCoordinate,
          repositoryCoordinate,
          sourceKind,
          requestedRef: stringField(row, "git_requested_ref"),
          exactCommit,
          packageRoot,
          contentDigest
        };
      }
      throw new Error(`invalid registry source kind: ${sourceKind}`);
    });
}

function readObservations(
  database: DatabaseSync,
  targetId: string
): ReadonlyArray<RegistryDependencyObservation> {
  return database
    .prepare(`
      SELECT package_coordinate, package_content_digest, kind, name, status,
             detected_version, location, note
      FROM dependency_observations
      WHERE target_id = ?
      ORDER BY package_coordinate, kind, name
    `)
    .all(targetId)
    .map((row) => {
      const kind = stringField(row, "kind");
      if (kind !== "software" && kind !== "special") {
        throw new Error(`invalid registry observation kind: ${kind}`);
      }
      return {
        packageCoordinate: stringField(row, "package_coordinate"),
        packageContentDigest: stringField(row, "package_content_digest"),
        kind,
        name: stringField(row, "name"),
        status: stringField(row, "status"),
        detectedVersion: nullableStringField(row, "detected_version"),
        location: nullableStringField(row, "location"),
        note: nullableStringField(row, "note")
      };
    });
}

export function readPendingOperations(database: DatabaseSync): ReadonlyArray<RegistryPendingOperation> {
  return database.prepare(`
    SELECT operation_id, target_id, base_generation, next_generation
    FROM pending_operations
    ORDER BY operation_id
  `).all().map((row) => {
    const operationId = stringField(row, "operation_id");
    return {
      operationId,
      targetId: stringField(row, "target_id"),
      baseGeneration: numberField(row, "base_generation"),
      nextGeneration: numberField(row, "next_generation"),
      actions: readPendingActions(database, operationId)
    };
  });
}

function readPendingActions(database: DatabaseSync, operationId: string): ReadonlyArray<RegistryPendingProjectionAction> {
  return database.prepare(`
    SELECT staging_path, activation_name
    FROM pending_projection_actions
    WHERE operation_id = ?
    ORDER BY staging_path, activation_name
  `).all(operationId).map((row) => ({
    stagingPath: stringField(row, "staging_path"),
    activationName: stringField(row, "activation_name")
  }));
}

function stringField(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`invalid registry ${key}`);
  }
  return value;
}

function nullableStringField(
  row: Record<string, SQLOutputValue>,
  key: string
): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid registry ${key}`);
  }
  return value;
}

function numberField(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid registry ${key}`);
  }
  return value;
}

function nullableNumberField(
  row: Record<string, SQLOutputValue>,
  key: string
): number | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid registry ${key}`);
  }
  return value;
}
