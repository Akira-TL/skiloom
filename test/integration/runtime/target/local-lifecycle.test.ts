import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createPackageSnapshot } from "../../../../src/domain/snapshot/index.js";
import {
  preflightTargetOwnership,
  type TargetOwnedProjection
} from "../../../../src/domain/target/preflight.js";
import type {
  TargetPlan,
  TargetProjection
} from "../../../../src/domain/target/index.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../../../../src/native/skiloom-lock.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../../../../src/runtime/home.js";
import { openMachineRegistry as openRawMachineRegistry } from "../../../../src/runtime/registry/database.js";
import {
  openMachineRegistry,
  type MachineRegistry,
  type RegistryTargetStateInput
} from "../../../../src/runtime/registry/index.js";
import {
  detachTargetProjection,
  repairAcceptedTargetState,
  syncAcceptedTargetState
} from "../../../../src/runtime/orchestration/local-lifecycle.js";
import {
  publishPackageSnapshot,
  verifyPackageStoreEntry
} from "../../../../src/runtime/store.js";
import {
  materializeManagedProjection
} from "../../../../src/runtime/target-projection/index.js";

const helperExecutable = requiredHelperExecutable();
const packageCoordinate = "acme/demo/demo";

test("sync restores a missing managed projection strictly from the current accepted Registry state", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const snapshot = snapshotFor("sync exact state\n");
    const published = await publishPackageSnapshot(paths, snapshot);
    assert.equal(published.ok, true);

    const projection = projectionFor(snapshot.contentDigest);
    const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
      {
        projection,
        ownership: "managed",
        materialization: "copy"
      }
    ];
    const acceptedState = registryState(
      targetRoot,
      snapshot.contentDigest,
      0
    );
    seedRawState(paths, acceptedState);

    const desiredPlan = targetPlan(projection);
    const preflight = preflightTargetOwnership({
      desiredPlan,
      currentProjections: currentOwned,
      observedPaths: []
    });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) {
      return;
    }
    assert.equal(preflight.value.actions[0]?.action, "materialize");

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const synced = await syncAcceptedTargetState({
          home: paths,
          targetRoot,
          operationId: "sync-missing-managed",
          lock,
          registry,
          desiredPlan,
          preflight: preflight.value,
          currentProjections: currentOwned,
          acceptedState
        });
        assert.equal(synced.ok, true);

        const state = registry.readTargetState(acceptedState.targetId);
        assert.equal(state.ok, true);
        if (state.ok) {
          assert.equal(
            state.value?.generation,
            1,
            "sync must not create a new accepted generation"
          );
          assert.equal(
            state.value?.resolvedPackages[0]?.contentDigest,
            snapshot.contentDigest
          );
        }
      } finally {
        registry.close();
      }
    });

    assert.match(
      await readFile(join(targetRoot, "demo", "SKILL.md"), "utf8"),
      /sync exact state/u
    );
  });
});

test("repair restores a missing Store entry only from exact accepted provenance and digest, then syncs without a new generation", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const snapshot = snapshotFor("repair exact state\n");
    const projection = projectionFor(snapshot.contentDigest);
    const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
      {
        projection,
        ownership: "managed",
        materialization: "copy"
      }
    ];
    const acceptedState = registryState(
      targetRoot,
      snapshot.contentDigest,
      0
    );
    seedRawState(paths, acceptedState);

    const desiredPlan = targetPlan(projection);
    const preflight = preflightTargetOwnership({
      desiredPlan,
      currentProjections: currentOwned,
      observedPaths: []
    });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) {
      return;
    }

    const missingBefore = await verifyPackageStoreEntry(
      paths,
      snapshot.contentDigest
    );
    assert.equal(missingBefore.ok, false);
    if (!missingBefore.ok) {
      assert.equal(missingBefore.error.code, "StoreEntryNotFound");
    }

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const repaired = await repairAcceptedTargetState({
          home: paths,
          targetRoot,
          operationId: "repair-missing-store",
          lock,
          registry,
          desiredPlan,
          preflight: preflight.value,
          currentProjections: currentOwned,
          acceptedState,
          repairs: [
            {
              package: acceptedState.resolvedPackages[0]!,
              source: acceptedState.resolvedSources[0]!,
              snapshot
            }
          ]
        });
        assert.equal(repaired.ok, true);

        const state = registry.readTargetState(acceptedState.targetId);
        assert.equal(state.ok, true);
        if (state.ok) {
          assert.equal(state.value?.generation, 1);
          assert.deepEqual(
            state.value?.resolvedSources[0],
            acceptedState.resolvedSources[0]
          );
        }
      } finally {
        registry.close();
      }
    });

    const restored = await verifyPackageStoreEntry(
      paths,
      snapshot.contentDigest
    );
    assert.equal(restored.ok, true);
    assert.match(
      await readFile(join(targetRoot, "demo", "SKILL.md"), "utf8"),
      /repair exact state/u
    );
  });
});

test("repair rejects source substitution before writing Store or Target bytes", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const snapshot = snapshotFor("must not publish from retarget\n");
    const projection = projectionFor(snapshot.contentDigest);
    const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
      {
        projection,
        ownership: "managed",
        materialization: "copy"
      }
    ];
    const acceptedState = registryState(
      targetRoot,
      snapshot.contentDigest,
      0
    );
    seedRawState(paths, acceptedState);
    const desiredPlan = targetPlan(projection);
    const preflight = preflightTargetOwnership({
      desiredPlan,
      currentProjections: currentOwned,
      observedPaths: []
    });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) {
      return;
    }

    const acceptedSource = acceptedState.resolvedSources[0]!;
    if (acceptedSource.sourceKind !== "github-release") {
      assert.fail("fixture source must be github-release");
    }

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const rejected = await repairAcceptedTargetState({
          home: paths,
          targetRoot,
          operationId: "repair-source-substitution",
          lock,
          registry,
          desiredPlan,
          preflight: preflight.value,
          currentProjections: currentOwned,
          acceptedState,
          repairs: [
            {
              package: acceptedState.resolvedPackages[0]!,
              source: {
                ...acceptedSource,
                exactCommit: "2222222222222222222222222222222222222222"
              },
              snapshot
            }
          ]
        });
        assert.equal(rejected.ok, false);
        if (!rejected.ok) {
          assert.deepEqual(rejected.error, {
            code: "InvalidExactRepairInput",
            facts: {
              packageCoordinate,
              reason: "source-mismatch"
            }
          });
        }
      } finally {
        registry.close();
      }
    });

    const store = await verifyPackageStoreEntry(
      paths,
      snapshot.contentDigest
    );
    assert.equal(store.ok, false);
    if (!store.ok) {
      assert.equal(store.error.code, "StoreEntryNotFound");
    }
    await assert.rejects(
      readFile(join(targetRoot, "demo", "SKILL.md"))
    );
  });
});

test("repair replaces a corrupt Store entry for the accepted digest before restoring the managed projection", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const snapshot = snapshotFor("repair corrupt store\n");
    const published = await publishPackageSnapshot(paths, snapshot);
    assert.equal(published.ok, true);
    if (!published.ok) {
      return;
    }
    await writeFile(
      join(published.value.payloadPath, "SKILL.md"),
      "corrupt\n",
      "utf8"
    );

    const corruptBefore = await verifyPackageStoreEntry(
      paths,
      snapshot.contentDigest
    );
    assert.equal(corruptBefore.ok, false);
    if (!corruptBefore.ok) {
      assert.equal(corruptBefore.error.code, "CorruptStoreEntry");
    }

    const projection = projectionFor(snapshot.contentDigest);
    const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
      {
        projection,
        ownership: "managed",
        materialization: "copy"
      }
    ];
    const acceptedState = registryState(
      targetRoot,
      snapshot.contentDigest,
      0
    );
    seedRawState(paths, acceptedState);
    const desiredPlan = targetPlan(projection);
    const preflight = preflightTargetOwnership({
      desiredPlan,
      currentProjections: currentOwned,
      observedPaths: []
    });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) {
      return;
    }

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const repaired = await repairAcceptedTargetState({
          home: paths,
          targetRoot,
          operationId: "repair-corrupt-store",
          lock,
          registry,
          desiredPlan,
          preflight: preflight.value,
          currentProjections: currentOwned,
          acceptedState,
          repairs: [
            {
              package: acceptedState.resolvedPackages[0]!,
              source: acceptedState.resolvedSources[0]!,
              snapshot
            }
          ]
        });
        assert.equal(repaired.ok, true);
      } finally {
        registry.close();
      }
    });

    const restored = await verifyPackageStoreEntry(
      paths,
      snapshot.contentDigest
    );
    assert.equal(restored.ok, true);
    assert.match(
      await readFile(join(targetRoot, "demo", "SKILL.md"), "utf8"),
      /repair corrupt store/u
    );
  });
});

test("detach transfers a verified managed link into an in-place user-owned copy and later sync preserves user edits", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const snapshot = snapshotFor("detach baseline\n");
    const published = await publishPackageSnapshot(paths, snapshot);
    assert.equal(published.ok, true);
    if (!published.ok) {
      return;
    }

    const projection = projectionFor(snapshot.contentDigest);
    const current: TargetOwnedProjection = {
      projection,
      ownership: "managed",
      materialization: "symlink"
    };
    const live = await materializeManagedProjection({
      home: paths,
      targetRoot,
      projection,
      materialization: "symlink"
    });
    assert.equal(live.ok, true);

    const acceptedState = registryState(
      targetRoot,
      snapshot.contentDigest,
      0,
      "symlink"
    );
    seedRawState(paths, acceptedState);

    let detachedState;
    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const detached = await detachTargetProjection({
          home: paths,
          targetRoot,
          operationId: "detach-demo",
          lock,
          registry,
          acceptedState,
          packageCoordinate,
          current
        });
        assert.equal(detached.ok, true);
        if (!detached.ok) {
          return;
        }
        detachedState = detached.value;

        assert.equal(detached.value.generation, 2);
        assert.deepEqual(detached.value.projections, [
          {
            packageCoordinate,
            activationName: "demo",
            ownership: "detached",
            materialization: "copy",
            transformJson: null
          }
        ]);
        assert.deepEqual(detached.value.detachedBaselines, [
          {
            packageCoordinate,
            repositoryCoordinate: "acme/demo",
            sourceKind: "github-release",
            version: "1.0.0",
            actualTag: "v1.0.0",
            exactCommit: "1111111111111111111111111111111111111111",
            packageRoot: ".",
            contentDigest: snapshot.contentDigest
          }
        ]);
      } finally {
        registry.close();
      }
    });

    const detachedStat = await lstat(join(targetRoot, "demo"));
    assert.equal(detachedStat.isDirectory(), true);
    assert.equal(detachedStat.isSymbolicLink(), false);
    assert.match(
      await readFile(join(targetRoot, "demo", "SKILL.md"), "utf8"),
      /detach baseline/u
    );

    await writeFile(
      join(targetRoot, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: lifecycle fixture\n---\nuser-owned edit\n",
      "utf8"
    );

    assert.notEqual(detachedState, undefined);
    const acceptedDetached = withoutGeneration(detachedState!);
    const desiredPlan = targetPlan(projection);
    const detachedOwned: TargetOwnedProjection = {
      projection,
      ownership: "detached",
      materialization: "copy"
    };
    const preflight = preflightTargetOwnership({
      desiredPlan,
      currentProjections: [detachedOwned],
      observedPaths: [
        {
          activationName: "demo",
          kind: "existing"
        }
      ]
    });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) {
      return;
    }
    assert.equal(preflight.value.actions[0]?.action, "preserve-user");

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const synced = await syncAcceptedTargetState({
          home: paths,
          targetRoot,
          operationId: "sync-detached-demo",
          lock,
          registry,
          desiredPlan,
          preflight: preflight.value,
          currentProjections: [detachedOwned],
          acceptedState: acceptedDetached
        });
        assert.equal(synced.ok, true);
      } finally {
        registry.close();
      }
    });

    assert.match(
      await readFile(join(targetRoot, "demo", "SKILL.md"), "utf8"),
      /user-owned edit/u
    );
  });
});

function snapshotFor(body: string) {
  const snapshot = createPackageSnapshot([
    {
      path: "SKILL.md",
      executable: false,
      content: Buffer.from(
        `---\nname: demo\ndescription: lifecycle fixture\n---\n${body}`,
        "utf8"
      )
    }
  ]);
  if (!snapshot.ok) {
    throw new Error(snapshot.error.code);
  }
  return snapshot.value;
}

function projectionFor(contentDigest: string): TargetProjection {
  return {
    packageCoordinate,
    packageRoot: ".",
    contentDigest,
    activationName: "demo",
    projectionKind: "direct",
    transform: null
  };
}

function targetPlan(projection: TargetProjection): TargetPlan {
  return {
    projections: [projection],
    reachablePackages: [projection.packageCoordinate],
    unreachableManagedPackages: []
  };
}

function registryState(
  targetRoot: string,
  contentDigest: string,
  observedGeneration: number,
  materialization: "symlink" | "junction" | "copy" = "copy"
): RegistryTargetStateInput {
  return {
    targetId: "target-local-lifecycle",
    locations: [{ path: targetRoot, observedGeneration }],
    directRequirements: [
      {
        kind: "package",
        coordinate: packageCoordinate,
        sourceKind: "github-release",
        versionRequirement: "^1"
      }
    ],
    resolvedSources: [
      {
        repositoryCoordinate: "acme/demo",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit: "1111111111111111111111111111111111111111",
        immutable: true
      }
    ],
    resolvedPackages: [
      {
        packageCoordinate,
        repositoryCoordinate: "acme/demo",
        packageRoot: ".",
        contentDigest
      }
    ],
    dependencyEdges: [],
    projections: [
      {
        packageCoordinate,
        activationName: "demo",
        ownership: "managed",
        materialization,
        transformJson: null
      }
    ],
    detachedBaselines: [],
    dependencyObservations: []
  };
}

function withoutGeneration(
  state: Readonly<{
    targetId: string;
    generation: number;
    locations: RegistryTargetStateInput["locations"];
    directRequirements: RegistryTargetStateInput["directRequirements"];
    resolvedSources: RegistryTargetStateInput["resolvedSources"];
    resolvedPackages: RegistryTargetStateInput["resolvedPackages"];
    dependencyEdges: RegistryTargetStateInput["dependencyEdges"];
    projections: RegistryTargetStateInput["projections"];
    detachedBaselines: RegistryTargetStateInput["detachedBaselines"];
    dependencyObservations: RegistryTargetStateInput["dependencyObservations"];
  }>
): RegistryTargetStateInput {
  const { generation: _generation, ...input } = state;
  return input;
}

function seedRawState(
  paths: SkiloomHomePaths,
  state: RegistryTargetStateInput
): void {
  const opened = openRawMachineRegistry(paths);
  if (!opened.ok) {
    throw new Error(opened.error.code);
  }
  try {
    const written = opened.value.replaceTargetState(state);
    assert.equal(written.ok, true);
  } finally {
    opened.value.close();
  }
}

async function requireLockedRegistry(
  paths: SkiloomHomePaths,
  lock: OperationLockSession
): Promise<MachineRegistry> {
  const opened = await openMachineRegistry(paths, lock);
  if (!opened.ok) {
    throw new Error(opened.error.code);
  }
  return opened.value;
}

async function withRuntime(
  run: (input: Readonly<{
    paths: SkiloomHomePaths;
    targetRoot: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skiloom-local-lifecycle-"));
  const paths = resolveSkiloomHomePaths(join(root, "home"));
  const targetRoot = join(root, "target");
  await mkdir(targetRoot, { recursive: true });
  try {
    await run({ paths, targetRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withRealLock(
  paths: SkiloomHomePaths,
  run: (lock: OperationLockSession) => Promise<void>
): Promise<void> {
  await mkdir(paths.homeRoot, { recursive: true });
  const acquired = await acquireOperationLock({
    helperExecutable,
    lockPath: paths.operationLockPath
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) {
    return;
  }

  try {
    await run(acquired.value);
  } finally {
    if (acquired.value.held) {
      assert.deepEqual(
        await acquired.value.release(),
        { ok: true, value: undefined }
      );
    }
  }
}

function requiredHelperExecutable(): string {
  const configured = process.env.SKILOOM_LOCK_TEST_BINARY;
  if (configured === undefined || configured.length === 0) {
    throw new Error(
      "SKILOOM_LOCK_TEST_BINARY must point to a real skiloom-lock executable"
    );
  }
  return resolve(configured);
}
