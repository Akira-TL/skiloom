import type { DatabaseSync } from "node:sqlite";

import type {
  RegistryDependencyObservation,
  RegistryDetachedBaseline,
  RegistryDirectRequirement,
  RegistryProjection,
  RegistryResolvedSource,
  RegistryTargetStateInput
} from "./model.js";

export function replaceTargetRows(
  database: DatabaseSync,
  state: RegistryTargetStateInput
): number {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("INSERT INTO targets(target_id, generation) VALUES (?, 0) ON CONFLICT(target_id) DO NOTHING")
      .run(state.targetId);

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
    const row = database
      .prepare("SELECT generation FROM targets WHERE target_id = ?")
      .get(state.targetId);
    const generation = row?.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation)) {
      throw new Error("registry generation is not a safe integer");
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
