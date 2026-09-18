import type { DatabaseSync } from "node:sqlite";

import type {
  RegistryDependencyObservation,
  RegistryDetachedBaseline,
  RegistryDirectRequirement,
  RegistryPendingOperation,
  RegistryPendingOperationInput,
  RegistryProjection,
  RegistryResolvedSource,
  RegistryTargetStateInput
} from "./model.js";

export class RegistryPendingOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryPendingOperationConflictError";
  }
}

export function beginPendingOperationRows(
  database: DatabaseSync,
  targetId: string,
  pending: RegistryPendingOperationInput
): RegistryPendingOperation {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("INSERT INTO targets(target_id, generation) VALUES (?, 0) ON CONFLICT(target_id) DO NOTHING")
      .run(targetId);

    const generation = readGeneration(database, targetId);
    const existingPending = database
      .prepare("SELECT COUNT(*) AS pending_count FROM pending_operations WHERE target_id = ?")
      .get(targetId);
    const count = existingPending?.pending_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count)) {
      throw new Error("invalid pending operation count");
    }
    if (count !== 0) {
      throw new RegistryPendingOperationConflictError(
        "registry target already has a pending operation"
      );
    }

    const operation = insertPendingOperation(
      database,
      targetId,
      generation,
      generation + 1,
      pending
    );
    database.exec("COMMIT");
    return operation;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

export function beginPendingReconciliationRows(
  database: DatabaseSync,
  targetId: string,
  pending: RegistryPendingOperationInput
): RegistryPendingOperation {
  database.exec("BEGIN IMMEDIATE");
  try {
    const generation = readGeneration(database, targetId);
    if (generation < 1) {
      throw new RegistryPendingOperationConflictError(
        "registry target has no accepted generation to reconcile"
      );
    }

    const existingPending = database
      .prepare("SELECT COUNT(*) AS pending_count FROM pending_operations WHERE target_id = ?")
      .get(targetId);
    const count = existingPending?.pending_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count)) {
      throw new Error("invalid pending operation count");
    }
    if (count !== 0) {
      throw new RegistryPendingOperationConflictError(
        "registry target already has a pending operation"
      );
    }

    const operation = insertPendingOperation(
      database,
      targetId,
      generation - 1,
      generation,
      pending
    );
    database.exec("COMMIT");
    return operation;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

export function completePendingOperationRows(
  database: DatabaseSync,
  operationId: string
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("DELETE FROM pending_operations WHERE operation_id = ?")
      .run(operationId);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

export function replaceTargetRows(
  database: DatabaseSync,
  state: RegistryTargetStateInput,
  pendingOperationId?: string
): number {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("INSERT INTO targets(target_id, generation) VALUES (?, 0) ON CONFLICT(target_id) DO NOTHING")
      .run(state.targetId);

    const generationBefore = readGeneration(database, state.targetId);
    validatePendingOperationForReplacement(
      database,
      state.targetId,
      generationBefore,
      pendingOperationId
    );

    database.prepare("DELETE FROM target_locations WHERE target_id = ?").run(state.targetId);
    database.prepare("DELETE FROM direct_requirements WHERE target_id = ?").run(state.targetId);
    database.prepare("DELETE FROM resolved_sources WHERE target_id = ?").run(state.targetId);

    insertLocations(database, state);
    insertDirectRequirements(database, state.targetId, state.directRequirements);
    insertResolvedSources(database, state.targetId, state.resolvedSources);
    insertResolvedPackages(database, state);
    insertDependencyEdges(database, state);
    insertProjections(database, state.targetId, state.projections);
    insertDetachedBaselines(database, state.targetId, state.detachedBaselines);
    insertObservations(database, state.targetId, state.dependencyObservations);

    database.prepare("UPDATE targets SET generation = generation + 1 WHERE target_id = ?").run(state.targetId);
    const generation = readGeneration(database, state.targetId);
    if (generation !== generationBefore + 1) {
      throw new Error("registry generation did not advance exactly once");
    }

    database.exec("COMMIT");
    return generation;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

function validatePendingOperationForReplacement(
  database: DatabaseSync,
  targetId: string,
  generation: number,
  pendingOperationId: string | undefined
): void {
  const rows = database
    .prepare(`
      SELECT operation_id, target_id, base_generation, next_generation
      FROM pending_operations
      WHERE target_id = ?
      ORDER BY operation_id
    `)
    .all(targetId);

  if (pendingOperationId === undefined) {
    if (rows.length !== 0) {
      throw new RegistryPendingOperationConflictError(
        "registry target has a pending operation"
      );
    }
    return;
  }

  const row = rows.find((candidate) => candidate.operation_id === pendingOperationId);
  if (row === undefined) {
    throw new RegistryPendingOperationConflictError(
      "registry pending operation does not match target"
    );
  }
  if (
    row.target_id !== targetId ||
    row.base_generation !== generation ||
    row.next_generation !== generation + 1
  ) {
    throw new RegistryPendingOperationConflictError(
      "registry pending operation generation does not match target"
    );
  }
}

function readGeneration(database: DatabaseSync, targetId: string): number {
  const row = database
    .prepare("SELECT generation FROM targets WHERE target_id = ?")
    .get(targetId);
  const generation = row?.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation)) {
    throw new Error("registry generation is not a safe integer");
  }
  return generation;
}

function insertPendingOperation(
  database: DatabaseSync,
  targetId: string,
  baseGeneration: number,
  nextGeneration: number,
  pending: RegistryPendingOperationInput
): RegistryPendingOperation {
  database.prepare(`
    INSERT INTO pending_operations(
      operation_id, target_id, base_generation, next_generation
    ) VALUES (?, ?, ?, ?)
  `).run(
    pending.operationId,
    targetId,
    baseGeneration,
    nextGeneration
  );

  const actions = [...pending.actions].sort((left, right) => {
    const activation = compareStrings(left.activationName, right.activationName);
    return activation !== 0
      ? activation
      : compareStrings(left.stagingPath, right.stagingPath);
  });
  const insertAction = database.prepare(`
    INSERT INTO pending_projection_actions(
      operation_id, staging_path, activation_name
    ) VALUES (?, ?, ?)
  `);
  for (const action of actions) {
    insertAction.run(
      pending.operationId,
      action.stagingPath,
      action.activationName
    );
  }

  return {
    operationId: pending.operationId,
    targetId,
    baseGeneration,
    nextGeneration,
    actions
  };
}

function insertLocations(database: DatabaseSync, state: RegistryTargetStateInput): void {
  const statement = database.prepare(
    "INSERT INTO target_locations(path, target_id, observed_generation) VALUES (?, ?, ?)"
  );
  for (const location of state.locations) {
    statement.run(location.path, state.targetId, location.observedGeneration);
  }
}

function insertDirectRequirements(
  database: DatabaseSync,
  targetId: string,
  requirements: ReadonlyArray<RegistryDirectRequirement>
): void {
  const statement = database.prepare(`
    INSERT INTO direct_requirements(
      target_id, requirement_kind, target_coordinate, source_kind,
      version_requirement, git_requested_ref
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const requirement of requirements) {
    if (requirement.sourceKind === "github-release") {
      statement.run(
        targetId,
        requirement.kind,
        requirement.coordinate,
        requirement.sourceKind,
        requirement.versionRequirement,
        null
      );
    } else {
      statement.run(
        targetId,
        requirement.kind,
        requirement.coordinate,
        requirement.sourceKind,
        null,
        requirement.requestedRef
      );
    }
  }
}

function insertResolvedSources(
  database: DatabaseSync,
  targetId: string,
  sources: ReadonlyArray<RegistryResolvedSource>
): void {
  const statement = database.prepare(`
    INSERT INTO resolved_sources(
      target_id, repository_coordinate, source_kind, release_version,
      actual_tag, git_requested_ref, exact_commit, immutable_signal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const source of sources) {
    if (source.sourceKind === "github-release") {
      statement.run(
        targetId,
        source.repositoryCoordinate,
        source.sourceKind,
        source.version,
        source.actualTag,
        null,
        source.exactCommit,
        source.immutable === null ? null : source.immutable ? 1 : 0
      );
    } else {
      statement.run(
        targetId,
        source.repositoryCoordinate,
        source.sourceKind,
        null,
        null,
        source.requestedRef,
        source.exactCommit,
        null
      );
    }
  }
}

function insertResolvedPackages(database: DatabaseSync, state: RegistryTargetStateInput): void {
  const statement = database.prepare(`
    INSERT INTO resolved_packages(
      target_id, package_coordinate, repository_coordinate, package_root, content_digest
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const packageFact of state.resolvedPackages) {
    statement.run(
      state.targetId,
      packageFact.packageCoordinate,
      packageFact.repositoryCoordinate,
      packageFact.packageRoot,
      packageFact.contentDigest
    );
  }
}

function insertDependencyEdges(database: DatabaseSync, state: RegistryTargetStateInput): void {
  const statement = database.prepare(
    "INSERT INTO dependency_edges(target_id, from_package, to_package) VALUES (?, ?, ?)"
  );
  for (const edge of state.dependencyEdges) {
    statement.run(state.targetId, edge.fromPackage, edge.toPackage);
  }
}

function insertProjections(
  database: DatabaseSync,
  targetId: string,
  projections: ReadonlyArray<RegistryProjection>
): void {
  const statement = database.prepare(`
    INSERT INTO projections(
      target_id, package_coordinate, activation_name, ownership, materialization, transform_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const projection of projections) {
    statement.run(
      targetId,
      projection.packageCoordinate,
      projection.activationName,
      projection.ownership,
      projection.materialization,
      projection.transformJson
    );
  }
}

function insertDetachedBaselines(
  database: DatabaseSync,
  targetId: string,
  baselines: ReadonlyArray<RegistryDetachedBaseline>
): void {
  const statement = database.prepare(`
    INSERT INTO detached_baselines(
      target_id, package_coordinate, repository_coordinate, source_kind,
      release_version, actual_tag, git_requested_ref, exact_commit,
      package_root, content_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const baseline of baselines) {
    if (baseline.sourceKind === "github-release") {
      statement.run(
        targetId,
        baseline.packageCoordinate,
        baseline.repositoryCoordinate,
        baseline.sourceKind,
        baseline.version,
        baseline.actualTag,
        null,
        baseline.exactCommit,
        baseline.packageRoot,
        baseline.contentDigest
      );
    } else {
      statement.run(
        targetId,
        baseline.packageCoordinate,
        baseline.repositoryCoordinate,
        baseline.sourceKind,
        null,
        null,
        baseline.requestedRef,
        baseline.exactCommit,
        baseline.packageRoot,
        baseline.contentDigest
      );
    }
  }
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

function insertObservations(
  database: DatabaseSync,
  targetId: string,
  observations: ReadonlyArray<RegistryDependencyObservation>
): void {
  const statement = database.prepare(`
    INSERT INTO dependency_observations(
      target_id, package_coordinate, package_content_digest, kind, name,
      status, detected_version, location, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const observation of observations) {
    statement.run(
      targetId,
      observation.packageCoordinate,
      observation.packageContentDigest,
      observation.kind,
      observation.name,
      observation.status,
      observation.detectedVersion,
      observation.location,
      observation.note
    );
  }
}
