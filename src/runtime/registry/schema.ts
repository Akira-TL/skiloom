import type { DatabaseSync } from "node:sqlite";

export const CURRENT_REGISTRY_SCHEMA_VERSION = 1;

export function configureRegistryConnection(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
}

export function initializeRegistrySchema(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;

    CREATE TABLE IF NOT EXISTS targets (
      target_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL CHECK (generation >= 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS target_locations (
      path TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      observed_generation INTEGER NULL CHECK (
        observed_generation IS NULL OR observed_generation >= 0
      ),
      FOREIGN KEY (target_id) REFERENCES targets(target_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS direct_requirements (
      target_id TEXT NOT NULL,
      requirement_kind TEXT NOT NULL CHECK (requirement_kind IN ('package', 'repository')),
      target_coordinate TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('github-release', 'git')),
      version_requirement TEXT NULL,
      git_requested_ref TEXT NULL,
      PRIMARY KEY (target_id, requirement_kind, target_coordinate),
      FOREIGN KEY (target_id) REFERENCES targets(target_id) ON DELETE CASCADE,
      CHECK (
        (source_kind = 'github-release' AND git_requested_ref IS NULL)
        OR
        (source_kind = 'git' AND version_requirement IS NULL AND git_requested_ref IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS resolved_sources (
      target_id TEXT NOT NULL,
      repository_coordinate TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('github-release', 'git')),
      release_version TEXT NULL,
      actual_tag TEXT NULL,
      git_requested_ref TEXT NULL,
      exact_commit TEXT NOT NULL,
      immutable_signal INTEGER NULL CHECK (
        immutable_signal IS NULL OR immutable_signal IN (0, 1)
      ),
      PRIMARY KEY (target_id, repository_coordinate),
      FOREIGN KEY (target_id) REFERENCES targets(target_id) ON DELETE CASCADE,
      CHECK (
        (
          source_kind = 'github-release'
          AND release_version IS NOT NULL
          AND actual_tag IS NOT NULL
          AND git_requested_ref IS NULL
        )
        OR
        (
          source_kind = 'git'
          AND release_version IS NULL
          AND actual_tag IS NULL
          AND git_requested_ref IS NOT NULL
          AND immutable_signal IS NULL
        )
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS resolved_packages (
      target_id TEXT NOT NULL,
      package_coordinate TEXT NOT NULL,
      repository_coordinate TEXT NOT NULL,
      package_root TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      PRIMARY KEY (target_id, package_coordinate),
      FOREIGN KEY (target_id, repository_coordinate)
        REFERENCES resolved_sources(target_id, repository_coordinate)
        ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS dependency_edges (
      target_id TEXT NOT NULL,
      from_package TEXT NOT NULL,
      to_package TEXT NOT NULL,
      PRIMARY KEY (target_id, from_package, to_package),
      FOREIGN KEY (target_id, from_package)
        REFERENCES resolved_packages(target_id, package_coordinate)
        ON DELETE CASCADE,
      FOREIGN KEY (target_id, to_package)
        REFERENCES resolved_packages(target_id, package_coordinate)
        ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS projections (
      target_id TEXT NOT NULL,
      package_coordinate TEXT NOT NULL,
      activation_name TEXT NOT NULL,
      ownership TEXT NOT NULL CHECK (ownership IN ('managed', 'detached')),
      materialization TEXT NOT NULL CHECK (materialization IN ('symlink', 'junction', 'copy')),
      transform_json TEXT NULL,
      PRIMARY KEY (target_id, package_coordinate),
      UNIQUE (target_id, activation_name),
      FOREIGN KEY (target_id, package_coordinate)
        REFERENCES resolved_packages(target_id, package_coordinate)
        ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS detached_baselines (
      target_id TEXT NOT NULL,
      package_coordinate TEXT NOT NULL,
      repository_coordinate TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('github-release', 'git')),
      release_version TEXT NULL,
      actual_tag TEXT NULL,
      git_requested_ref TEXT NULL,
      exact_commit TEXT NOT NULL,
      package_root TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      PRIMARY KEY (target_id, package_coordinate),
      FOREIGN KEY (target_id, package_coordinate)
        REFERENCES projections(target_id, package_coordinate)
        ON DELETE CASCADE,
      CHECK (
        (
          source_kind = 'github-release'
          AND release_version IS NOT NULL
          AND actual_tag IS NOT NULL
          AND git_requested_ref IS NULL
        )
        OR
        (
          source_kind = 'git'
          AND release_version IS NULL
          AND actual_tag IS NULL
          AND git_requested_ref IS NOT NULL
        )
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS dependency_observations (
      target_id TEXT NOT NULL,
      package_coordinate TEXT NOT NULL,
      package_content_digest TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('software', 'special')),
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      detected_version TEXT NULL,
      location TEXT NULL,
      note TEXT NULL,
      PRIMARY KEY (target_id, package_coordinate, kind, name),
      FOREIGN KEY (target_id, package_coordinate)
        REFERENCES resolved_packages(target_id, package_coordinate)
        ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pending_operations (
      operation_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      base_generation INTEGER NOT NULL CHECK (base_generation >= 0),
      next_generation INTEGER NOT NULL CHECK (next_generation >= 0),
      FOREIGN KEY (target_id) REFERENCES targets(target_id) ON DELETE CASCADE,
      CHECK (next_generation = base_generation + 1)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pending_projection_actions (
      operation_id TEXT NOT NULL,
      staging_path TEXT NOT NULL,
      activation_name TEXT NOT NULL,
      PRIMARY KEY (operation_id, staging_path, activation_name),
      FOREIGN KEY (operation_id) REFERENCES pending_operations(operation_id) ON DELETE CASCADE
    ) STRICT;

    PRAGMA user_version = 1;
    COMMIT;
  `);
}
