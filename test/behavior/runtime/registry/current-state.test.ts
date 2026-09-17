import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { resolveSkiloomHomePaths, type SkiloomHomePaths } from "../../../../src/runtime/home.js";
import { openMachineRegistry } from "../../../../src/runtime/registry/database.js";
import type { RegistryTargetStateInput } from "../../../../src/runtime/registry/model.js";
import { CURRENT_REGISTRY_SCHEMA_VERSION } from "../../../../src/runtime/registry/schema.js";

type Fixture = Readonly<{
  fixtureVersion: 1;
  state: RegistryTargetStateInput;
}>;

test("Machine Registry opens with the required SQLite pragmas and relational schema", async () => {
  await withTempHome(async (paths) => {
    const opened = openMachineRegistry(paths);
    assert.equal(opened.ok, true);
    if (!opened.ok) {
      return;
    }

    try {
      assert.deepEqual(opened.value.pragmas(), {
        foreignKeys: true,
        journalMode: "wal",
        synchronous: "full",
        userVersion: CURRENT_REGISTRY_SCHEMA_VERSION
      });
    } finally {
      opened.value.close();
    }

    const database = new DatabaseSync(paths.registryPath, {
      enableForeignKeyConstraints: true
    });
    try {
      const names = database
        .prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `)
        .all()
        .map((row) => row.name);
      assert.deepEqual(names, [
        "dependency_edges",
        "dependency_observations",
        "detached_baselines",
        "direct_requirements",
        "pending_operations",
        "pending_projection_actions",
        "projections",
        "resolved_packages",
        "resolved_sources",
        "target_locations",
        "targets"
      ]);
    } finally {
      database.close();
    }
  });
});

test("Machine Registry round-trips complete current state with canonical ordering and legal cycles", async () => {
  await withTempHome(async (paths) => {
    const fixture = await readFixture();
    const expected = canonicalState(fixture.state);

    let registry = requireRegistry(paths);
    const first = registry.replaceTargetState(fixture.state);
    assert.equal(first.ok, true);
    if (!first.ok) {
      registry.close();
      return;
    }
    assert.deepEqual(first.value, { ...expected, generation: 1 });
    registry.close();

    registry = requireRegistry(paths);
    try {
      assert.deepEqual(registry.readTargetState(fixture.state.targetId), {
        ...expected,
        generation: 1
      });

      const reduced = reducedState(fixture.state);
      const reducedExpected = canonicalState(reduced);
      const second = registry.replaceTargetState(reverseStateCollections(reduced));
      assert.equal(second.ok, true);
      if (second.ok) {
        assert.deepEqual(second.value, { ...reducedExpected, generation: 2 });
        assert.equal(
          second.value.resolvedSources.some(
            (source) => source.repositoryCoordinate === "vendor/gitpkg"
          ),
          false
        );
        assert.equal(
          second.value.resolvedPackages.some(
            (packageFact) => packageFact.packageCoordinate === "vendor/gitpkg/leaf"
          ),
          false
        );
      }

      const packageRequirements = expected.directRequirements.filter(
        (requirement) => requirement.kind === "package"
      );
      const repositoryRequirements = expected.directRequirements.filter(
        (requirement) => requirement.kind === "repository"
      );
      assert.equal(packageRequirements.length, 2);
      assert.equal(repositoryRequirements.length, 1);
      assert.equal(repositoryRequirements[0]?.coordinate, "acme/tools");
      assert.equal(packageRequirements[0]?.coordinate, "acme/tools/alpha");

      assert.deepEqual(expected.dependencyEdges, [
        { fromPackage: "acme/tools/alpha", toPackage: "acme/tools/beta" },
        { fromPackage: "acme/tools/alpha", toPackage: "vendor/gitpkg/leaf" },
        { fromPackage: "acme/tools/beta", toPackage: "acme/tools/alpha" }
      ]);
    } finally {
      registry.close();
    }
  });
});

test("Machine Registry replace is atomic and constraint failure preserves previous generation and state", async () => {
  await withTempHome(async (paths) => {
    const fixture = await readFixture();
    const expected = canonicalState(fixture.state);
    const registry = requireRegistry(paths);

    try {
      const first = registry.replaceTargetState(fixture.state);
      assert.equal(first.ok, true);
      if (!first.ok) {
        return;
      }

      const invalid: RegistryTargetStateInput = {
        ...fixture.state,
        resolvedPackages: [
          ...fixture.state.resolvedPackages,
          {
            packageCoordinate: "ghost/repo/ghost",
            repositoryCoordinate: "ghost/repo",
            packageRoot: ".",
            contentDigest: `sha256:${"d".repeat(64)}`
          }
        ]
      };
      const rejected = registry.replaceTargetState(invalid);
      assert.deepEqual(rejected, {
        ok: false,
        error: {
          code: "RegistryStateRejected",
          facts: {
            targetId: fixture.state.targetId,
            reason: "constraint"
          }
        }
      });

      assert.deepEqual(registry.readTargetState(fixture.state.targetId), {
        ...expected,
        generation: 1
      });

      const next = registry.replaceTargetState(fixture.state);
      assert.equal(next.ok, true);
      if (next.ok) {
        assert.equal(next.value.generation, 2);
      }
    } finally {
      registry.close();
    }
  });
});

test("Machine Registry SQLite constraints reject illegal source shapes and dangling graph rows", async () => {
  await withTempHome(async (paths) => {
    const registry = requireRegistry(paths);
    registry.close();

    const database = new DatabaseSync(paths.registryPath, {
      enableForeignKeyConstraints: true
    });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database
        .prepare("INSERT INTO targets(target_id, generation) VALUES (?, 0)")
        .run("constraint-target");

      assert.throws(
        () =>
          database.prepare(`
            INSERT INTO resolved_sources(
              target_id, repository_coordinate, source_kind, release_version,
              actual_tag, git_requested_ref, exact_commit, immutable_signal
            ) VALUES (?, ?, 'github-release', ?, ?, ?, ?, 1)
          `).run(
            "constraint-target",
            "acme/tools",
            "1.2.3",
            "v1.2.3",
            "main",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          ),
        /constraint failed/iu
      );

      assert.throws(
        () =>
          database.prepare(`
            INSERT INTO direct_requirements(
              target_id, requirement_kind, target_coordinate, source_kind,
              version_requirement, git_requested_ref
            ) VALUES (?, 'package', ?, 'git', ?, ?)
          `).run(
            "constraint-target",
            "acme/tools/alpha",
            "^1",
            "main"
          ),
        /constraint failed/iu
      );

      assert.throws(
        () =>
          database.prepare(`
            INSERT INTO resolved_packages(
              target_id, package_coordinate, repository_coordinate, package_root, content_digest
            ) VALUES (?, ?, ?, '.', ?)
          `).run(
            "constraint-target",
            "missing/repo/pkg",
            "missing/repo",
            `sha256:${"e".repeat(64)}`
          ),
        /foreign key constraint failed/iu
      );

      assert.throws(
        () =>
          database.prepare(`
            INSERT INTO dependency_edges(target_id, from_package, to_package)
            VALUES (?, ?, ?)
          `).run(
            "constraint-target",
            "missing/repo/a",
            "missing/repo/b"
          ),
        /foreign key constraint failed/iu
      );
    } finally {
      database.close();
    }
  });
});

function requireRegistry(paths: SkiloomHomePaths) {
  const opened = openMachineRegistry(paths);
  if (!opened.ok) {
    throw new Error(opened.error.code);
  }
  return opened.value;
}

async function readFixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      join("behavior-fixtures", "registry", "current-state.json"),
      "utf8"
    )
  ) as Fixture;
}

function canonicalState(state: RegistryTargetStateInput): RegistryTargetStateInput {
  return {
    targetId: state.targetId,
    locations: [...state.locations].sort((left, right) => compare(left.path, right.path)),
    directRequirements: [...state.directRequirements].sort((left, right) =>
      compare(`${left.kind}\u0000${left.coordinate}`, `${right.kind}\u0000${right.coordinate}`)
    ),
    resolvedSources: [...state.resolvedSources].sort((left, right) =>
      compare(left.repositoryCoordinate, right.repositoryCoordinate)
    ),
    resolvedPackages: [...state.resolvedPackages].sort((left, right) =>
      compare(left.packageCoordinate, right.packageCoordinate)
    ),
    dependencyEdges: [...state.dependencyEdges].sort((left, right) =>
      compare(
        `${left.fromPackage}\u0000${left.toPackage}`,
        `${right.fromPackage}\u0000${right.toPackage}`
      )
    ),
    projections: [...state.projections].sort((left, right) =>
      compare(left.packageCoordinate, right.packageCoordinate)
    ),
    detachedBaselines: [...state.detachedBaselines].sort((left, right) =>
      compare(left.packageCoordinate, right.packageCoordinate)
    ),
    dependencyObservations: [...state.dependencyObservations].sort((left, right) =>
      compare(
        `${left.packageCoordinate}\u0000${left.kind}\u0000${left.name}`,
        `${right.packageCoordinate}\u0000${right.kind}\u0000${right.name}`
      )
    )
  };
}

function reducedState(state: RegistryTargetStateInput): RegistryTargetStateInput {
  return {
    targetId: state.targetId,
    locations: state.locations,
    directRequirements: state.directRequirements.filter(
      (requirement) => requirement.coordinate !== "vendor/gitpkg/leaf"
    ),
    resolvedSources: state.resolvedSources.filter(
      (source) => source.repositoryCoordinate !== "vendor/gitpkg"
    ),
    resolvedPackages: state.resolvedPackages.filter(
      (packageFact) => packageFact.packageCoordinate !== "vendor/gitpkg/leaf"
    ),
    dependencyEdges: state.dependencyEdges.filter(
      (edge) =>
        edge.fromPackage !== "vendor/gitpkg/leaf" &&
        edge.toPackage !== "vendor/gitpkg/leaf"
    ),
    projections: state.projections.filter(
      (projection) => projection.packageCoordinate !== "vendor/gitpkg/leaf"
    ),
    detachedBaselines: state.detachedBaselines,
    dependencyObservations: state.dependencyObservations.filter(
      (observation) => observation.packageCoordinate !== "vendor/gitpkg/leaf"
    )
  };
}

function reverseStateCollections(state: RegistryTargetStateInput): RegistryTargetStateInput {
  return {
    targetId: state.targetId,
    locations: [...state.locations].reverse(),
    directRequirements: [...state.directRequirements].reverse(),
    resolvedSources: [...state.resolvedSources].reverse(),
    resolvedPackages: [...state.resolvedPackages].reverse(),
    dependencyEdges: [...state.dependencyEdges].reverse(),
    projections: [...state.projections].reverse(),
    detachedBaselines: [...state.detachedBaselines].reverse(),
    dependencyObservations: [...state.dependencyObservations].reverse()
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function withTempHome(
  run: (paths: SkiloomHomePaths) => Promise<void>
): Promise<void> {
  const userHome = await mkdtemp(join(tmpdir(), "skiloom-registry-"));
  try {
    await run(resolveSkiloomHomePaths(userHome));
  } finally {
    await rm(userHome, { recursive: true, force: true });
  }
}
