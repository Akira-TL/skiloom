import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  cleanupPendingTargetStaging,
  prepareTargetReconciliation,
  reconcileAcceptedTargetState
} from "../../../../src/runtime/orchestration/target-reconcile.js";
import { publishPackageSnapshot } from "../../../../src/runtime/store.js";
import {
  materializeManagedProjection
} from "../../../../src/runtime/target-projection/index.js";

const helperExecutable = requiredHelperExecutable();
const packageCoordinate = "acme/demo/demo";

test("DB-first reconciliation keeps live bytes old until accepted state commits, then converges and clears pending staging", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const currentSnapshot = snapshotFor("current bytes\n");
    const nextSnapshot = snapshotFor("next bytes\n");
    await publish(paths, currentSnapshot);
    await publish(paths, nextSnapshot);

    const currentProjection = projectionFor(currentSnapshot.contentDigest);
    const nextProjection = projectionFor(nextSnapshot.contentDigest);
    const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
      {
        projection: currentProjection,
        ownership: "managed",
        materialization: "copy"
      }
    ];

    const live = await materializeManagedProjection({
      home: paths,
      targetRoot,
      projection: currentProjection,
      materialization: "copy"
    });
    assert.equal(live.ok, true);

    const initialState = registryState(
      targetRoot,
      currentSnapshot.contentDigest,
      0
    );
    seedRawState(paths, initialState);

    const preflight = preflightTargetOwnership({
      desiredPlan: targetPlan(nextProjection),
      currentProjections: currentOwned,
      observedPaths: [
        {
          activationName: "demo",
          kind: "managed",
          packageCoordinate,
          contentDigest: currentSnapshot.contentDigest,
          materialization: "copy",
          expectedViewMatches: true
        }
      ]
    });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) {
      return;
    }
    assert.equal(preflight.value.actions[0]?.action, "replace");

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const prepared = await prepareTargetReconciliation({
          home: paths,
          targetRoot,
          operationId: "reconcile-db-first",
          lock,
          registry,
          desiredPlan: targetPlan(nextProjection),
          preflight: preflight.value,
          currentProjections: currentOwned,
          nextState: registryState(
            targetRoot,
            nextSnapshot.contentDigest,
            1
          )
        });
        assert.equal(prepared.ok, true);
        if (!prepared.ok) {
          return;
        }

        assert.equal(
          await liveBody(targetRoot),
          "current bytes\n",
          "staging preparation must not replace live bytes"
        );
        const beforeCommit = registry.readTargetState(initialState.targetId);
        assert.equal(beforeCommit.ok, true);
        if (beforeCommit.ok) {
          assert.equal(beforeCommit.value?.generation, 1);
          assert.equal(
            beforeCommit.value?.resolvedPackages[0]?.contentDigest,
            currentSnapshot.contentDigest
          );
        }
        const pendingBeforeCommit = registry.readPendingOperations();
        assert.equal(pendingBeforeCommit.ok, true);
        if (pendingBeforeCommit.ok) {
          assert.equal(pendingBeforeCommit.value.length, 1);
          assert.equal(
            pendingBeforeCommit.value[0]?.actions[0]?.activationName,
            "demo"
          );
        }

        const committed = await prepared.value.commitAcceptedState();
        assert.equal(committed.ok, true);
        if (!committed.ok) {
          return;
        }

        assert.equal(
          await liveBody(targetRoot),
          "current bytes\n",
          "Registry commit must happen before live activation"
        );
        const afterCommit = registry.readTargetState(initialState.targetId);
        assert.equal(afterCommit.ok, true);
        if (afterCommit.ok) {
          assert.equal(afterCommit.value?.generation, 2);
          assert.equal(
            afterCommit.value?.resolvedPackages[0]?.contentDigest,
            nextSnapshot.contentDigest
          );
        }

        const reconciled = await committed.value.reconcileLiveTarget();
        assert.equal(reconciled.ok, true);
        assert.equal(await liveBody(targetRoot), "next bytes\n");

        const pendingAfter = registry.readPendingOperations();
        assert.deepEqual(pendingAfter, { ok: true, value: [] });
      } finally {
        registry.close();
      }
    });
  });
});

test("pre-commit interruption leaves old authority and live bytes, then a new lock cleans only recorded staging", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const currentSnapshot = snapshotFor("old authority\n");
    const nextSnapshot = snapshotFor("uncommitted candidate\n");
    await publish(paths, currentSnapshot);
    await publish(paths, nextSnapshot);

    const currentProjection = projectionFor(currentSnapshot.contentDigest);
    const nextProjection = projectionFor(nextSnapshot.contentDigest);
    const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
      {
        projection: currentProjection,
        ownership: "managed",
        materialization: "copy"
      }
    ];

    const live = await materializeManagedProjection({
      home: paths,
      targetRoot,
      projection: currentProjection,
      materialization: "copy"
    });
    assert.equal(live.ok, true);
    const initialState = registryState(
      targetRoot,
      currentSnapshot.contentDigest,
      0
    );
    seedRawState(paths, initialState);

    const preflight = preflightTargetOwnership({
      desiredPlan: targetPlan(nextProjection),
      currentProjections: currentOwned,
      observedPaths: [
        {
          activationName: "demo",
          kind: "managed",
          packageCoordinate,
          contentDigest: currentSnapshot.contentDigest,
          materialization: "copy",
          expectedViewMatches: true
        }
      ]
    });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) {
      return;
    }

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const prepared = await prepareTargetReconciliation({
          home: paths,
          targetRoot,
          operationId: "reconcile-precommit-interruption",
          lock,
          registry,
          desiredPlan: targetPlan(nextProjection),
          preflight: preflight.value,
          currentProjections: currentOwned,
          nextState: registryState(
            targetRoot,
            nextSnapshot.contentDigest,
            1
          )
        });
        assert.equal(prepared.ok, true);
        assert.equal(await liveBody(targetRoot), "old authority\n");

        const pending = registry.readPendingOperations();
        assert.equal(pending.ok, true);
        if (pending.ok) {
          assert.equal(pending.value.length, 1);
        }
      } finally {
        registry.close();
      }
    });

    assert.equal(
      (await readdir(targetRoot)).some((name) =>
        name.startsWith(".skiloom-stage-demo-")
      ),
      true
    );

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const cleaned = await cleanupPendingTargetStaging({
          targetId: initialState.targetId,
          targetRoot,
          lock,
          registry
        });
        assert.deepEqual(cleaned, { ok: true, value: undefined });

        const state = registry.readTargetState(initialState.targetId);
        assert.equal(state.ok, true);
        if (state.ok) {
          assert.equal(state.value?.generation, 1);
          assert.equal(
            state.value?.resolvedPackages[0]?.contentDigest,
            currentSnapshot.contentDigest
          );
        }
        assert.deepEqual(registry.readPendingOperations(), {
          ok: true,
          value: []
        });
      } finally {
        registry.close();
      }
    });

    assert.equal(await liveBody(targetRoot), "old authority\n");
    assert.equal(
      (await readdir(targetRoot)).some((name) =>
        name.startsWith(".skiloom-stage-demo-")
      ),
      false
    );
  });
});

test("managed removal commits the empty accepted state before deleting a re-verified pristine live projection", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const currentSnapshot = snapshotFor("remove me after commit\n");
    await publish(paths, currentSnapshot);
    const currentProjection = projectionFor(currentSnapshot.contentDigest);
    const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
      {
        projection: currentProjection,
        ownership: "managed",
        materialization: "copy"
      }
    ];

    const live = await materializeManagedProjection({
      home: paths,
      targetRoot,
      projection: currentProjection,
      materialization: "copy"
    });
    assert.equal(live.ok, true);

    const initialState = registryState(
      targetRoot,
      currentSnapshot.contentDigest,
      0
    );
    seedRawState(paths, initialState);

    const desiredPlan: TargetPlan = {
      projections: [],
      reachablePackages: [],
      unreachableManagedPackages: [packageCoordinate]
    };
    const preflight = preflightTargetOwnership({
      desiredPlan,
      currentProjections: currentOwned,
      observedPaths: [
        {
          activationName: "demo",
          kind: "managed",
          packageCoordinate,
          contentDigest: currentSnapshot.contentDigest,
          materialization: "copy",
          expectedViewMatches: true
        }
      ]
    });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) {
      return;
    }
    assert.equal(preflight.value.actions[0]?.action, "remove");

    const nextState: RegistryTargetStateInput = {
      targetId: initialState.targetId,
      locations: [{ path: targetRoot, observedGeneration: 1 }],
      directRequirements: [],
      resolvedSources: [],
      resolvedPackages: [],
      dependencyEdges: [],
      projections: [],
      detachedBaselines: [],
      dependencyObservations: []
    };

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const prepared = await prepareTargetReconciliation({
          home: paths,
          targetRoot,
          operationId: "reconcile-remove",
          lock,
          registry,
          desiredPlan,
          preflight: preflight.value,
          currentProjections: currentOwned,
          nextState
        });
        assert.equal(prepared.ok, true);
        if (!prepared.ok) {
          return;
        }

        const committed = await prepared.value.commitAcceptedState();
        assert.equal(committed.ok, true);
        if (!committed.ok) {
          return;
        }

        assert.equal(await liveBody(targetRoot), "remove me after commit\n");
        const accepted = registry.readTargetState(initialState.targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(accepted.value?.generation, 2);
          assert.deepEqual(accepted.value?.projections, []);
        }

        const reconciled = await committed.value.reconcileLiveTarget();
        assert.equal(reconciled.ok, true);
        await assert.rejects(readFile(join(targetRoot, "demo", "SKILL.md")));
      } finally {
        registry.close();
      }
    });
  });
});

test("managed preflight actions reject an accepted Registry state that contradicts the approved removal", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const currentSnapshot = snapshotFor("must remain because state is invalid\n");
    await publish(paths, currentSnapshot);
    const currentProjection = projectionFor(currentSnapshot.contentDigest);
    const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
      {
        projection: currentProjection,
        ownership: "managed",
        materialization: "copy"
      }
    ];

    const live = await materializeManagedProjection({
      home: paths,
      targetRoot,
      projection: currentProjection,
      materialization: "copy"
    });
    assert.equal(live.ok, true);

    const initialState = registryState(
      targetRoot,
      currentSnapshot.contentDigest,
      0
    );
    seedRawState(paths, initialState);

    const desiredPlan: TargetPlan = {
      projections: [],
      reachablePackages: [],
      unreachableManagedPackages: [packageCoordinate]
    };
    const preflight = preflightTargetOwnership({
      desiredPlan,
      currentProjections: currentOwned,
      observedPaths: [
        {
          activationName: "demo",
          kind: "managed",
          packageCoordinate,
          contentDigest: currentSnapshot.contentDigest,
          materialization: "copy",
          expectedViewMatches: true
        }
      ]
    });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) {
      return;
    }

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const rejected = await prepareTargetReconciliation({
          home: paths,
          targetRoot,
          operationId: "reconcile-invalid-removal-state",
          lock,
          registry,
          desiredPlan,
          preflight: preflight.value,
          currentProjections: currentOwned,
          nextState: {
            ...initialState,
            locations: [{ path: targetRoot, observedGeneration: 1 }]
          }
        });
        assert.equal(rejected.ok, false);
        if (!rejected.ok) {
          assert.equal(
            rejected.error.code,
            "InvalidTargetReconciliationInput"
          );
        }

        const accepted = registry.readTargetState(initialState.targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(accepted.value?.generation, 1);
          assert.equal(accepted.value?.projections.length, 1);
        }
        assert.deepEqual(registry.readPendingOperations(), {
          ok: true,
          value: []
        });
      } finally {
        registry.close();
      }
    });

    assert.equal(
      await liveBody(targetRoot),
      "must remain because state is invalid\n"
    );
  });
});

test("post-commit managed drift fails closed instead of deleting modified live bytes", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const fixture = await removalFixture(
      paths,
      targetRoot,
      "pristine before commit\n"
    );

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const prepared = await prepareTargetReconciliation({
          home: paths,
          targetRoot,
          operationId: "reconcile-remove-drift",
          lock,
          registry,
          desiredPlan: fixture.desiredPlan,
          preflight: fixture.preflight,
          currentProjections: fixture.currentOwned,
          nextState: fixture.nextState
        });
        assert.equal(prepared.ok, true);
        if (!prepared.ok) {
          return;
        }

        const committed = await prepared.value.commitAcceptedState();
        assert.equal(committed.ok, true);
        if (!committed.ok) {
          return;
        }

        await writeFile(
          join(targetRoot, "demo", "SKILL.md"),
          "---\nname: demo\ndescription: reconciliation fixture\n---\nuser changed after commit\n",
          "utf8"
        );

        const blocked = await committed.value.reconcileLiveTarget();
        assert.equal(blocked.ok, false);
        if (!blocked.ok) {
          assert.equal(blocked.error.code, "ManagedProjectionContentMismatch");
        }
        assert.equal(
          await liveBody(targetRoot),
          "user changed after commit\n"
        );

        const accepted = registry.readTargetState(
          fixture.initialState.targetId
        );
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(accepted.value?.generation, 2);
          assert.deepEqual(accepted.value?.projections, []);
        }
      } finally {
        registry.close();
      }
    });
  });
});

test("pending cleanup validates every recorded path before deleting any staging directory", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const safePath = join(
      targetRoot,
      ".skiloom-stage-demo-safe"
    );
    const outsideRoot = join(targetRoot, "..", "outside-pending");
    const unsafePath = join(
      outsideRoot,
      ".skiloom-stage-demo-unsafe"
    );
    await mkdir(safePath, { recursive: true });
    await mkdir(unsafePath, { recursive: true });
    await writeFile(join(safePath, "KEEP"), "safe staging\n");
    await writeFile(join(unsafePath, "KEEP"), "outside\n");

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const pending = registry.beginPendingOperation(
          "target-invalid-pending",
          {
            operationId: "invalid-pending-paths",
            actions: [
              {
                stagingPath: safePath,
                activationName: "demo"
              },
              {
                stagingPath: unsafePath,
                activationName: "demo"
              }
            ]
          }
        );
        assert.equal(pending.ok, true);

        const blocked = await cleanupPendingTargetStaging({
          targetId: "target-invalid-pending",
          targetRoot,
          lock,
          registry
        });
        assert.equal(blocked.ok, false);
        if (!blocked.ok) {
          assert.equal(
            blocked.error.code,
            "InvalidTargetReconciliationInput"
          );
        }

        assert.equal(
          await readFile(join(safePath, "KEEP"), "utf8"),
          "safe staging\n"
        );
        assert.equal(
          await readFile(join(unsafePath, "KEEP"), "utf8"),
          "outside\n"
        );
        const remaining = registry.readPendingOperations();
        assert.equal(remaining.ok, true);
        if (remaining.ok) {
          assert.equal(remaining.value.length, 1);
        }
      } finally {
        registry.close();
      }
    });
  });
});

test("post-commit operation-lock loss blocks live side effects while the new Registry state remains authoritative", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const fixture = await replacementFixture(
      paths,
      targetRoot,
      "live stays old after lock loss\n",
      "accepted but not yet live\n"
    );

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const prepared = await prepareTargetReconciliation({
          home: paths,
          targetRoot,
          operationId: "reconcile-lock-loss",
          lock,
          registry,
          desiredPlan: fixture.desiredPlan,
          preflight: fixture.preflight,
          currentProjections: fixture.currentOwned,
          nextState: fixture.nextState
        });
        assert.equal(prepared.ok, true);
        if (!prepared.ok) {
          return;
        }

        const committed = await prepared.value.commitAcceptedState();
        assert.equal(committed.ok, true);
        if (!committed.ok) {
          return;
        }
        assert.equal(
          await liveBody(targetRoot),
          "live stays old after lock loss\n"
        );

        const pid = lock.helperPid;
        if (pid === undefined) {
          assert.fail("operation-lock helper has no pid after acquisition");
        }
        process.kill(pid);
        const lost = await withTimeout(
          lock.waitForLoss(),
          5_000,
          "target reconciliation lock loss"
        );
        assert.equal(lost.code, "OperationLockLost");

        const blocked = await committed.value.reconcileLiveTarget();
        assert.equal(blocked.ok, false);
        if (!blocked.ok) {
          assert.equal(blocked.error.code, "OperationLockLost");
        }
      } finally {
        registry.close();
      }
    });

    assert.equal(
      await liveBody(targetRoot),
      "live stays old after lock loss\n"
    );

    const raw = openRawMachineRegistry(paths);
    assert.equal(raw.ok, true);
    if (raw.ok) {
      try {
        const accepted = raw.value.readTargetState(
          fixture.initialState.targetId
        );
        assert.equal(accepted?.generation, 2);
        assert.equal(
          accepted?.resolvedPackages[0]?.contentDigest,
          fixture.nextSnapshot.contentDigest
        );
        assert.equal(raw.value.readPendingOperations().length, 1);
      } finally {
        raw.value.close();
      }
    }

    const resumePreflight = preflightTargetOwnership({
      desiredPlan: fixture.desiredPlan,
      currentProjections: fixture.currentOwned,
      observedPaths: [
        {
          activationName: "demo",
          kind: "managed",
          packageCoordinate,
          contentDigest: fixture.currentSnapshot.contentDigest,
          materialization: "copy",
          expectedViewMatches: true
        }
      ]
    });
    assert.equal(resumePreflight.ok, true);
    if (!resumePreflight.ok) {
      return;
    }

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const resumed = await reconcileAcceptedTargetState({
          home: paths,
          targetRoot,
          operationId: "reconcile-after-interruption",
          lock,
          registry,
          desiredPlan: fixture.desiredPlan,
          preflight: resumePreflight.value,
          currentProjections: fixture.currentOwned,
          acceptedState: fixture.nextState
        });
        assert.equal(resumed.ok, true);

        const accepted = registry.readTargetState(
          fixture.initialState.targetId
        );
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(
            accepted.value?.generation,
            2,
            "resume must not create a third accepted generation"
          );
        }
        assert.deepEqual(registry.readPendingOperations(), {
          ok: true,
          value: []
        });
      } finally {
        registry.close();
      }
    });

    assert.equal(
      await liveBody(targetRoot),
      "accepted but not yet live\n"
    );
  });
});

async function removalFixture(
  paths: SkiloomHomePaths,
  targetRoot: string,
  body: string
) {
  const currentSnapshot = snapshotFor(body);
  await publish(paths, currentSnapshot);
  const currentProjection = projectionFor(currentSnapshot.contentDigest);
  const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
    {
      projection: currentProjection,
      ownership: "managed",
      materialization: "copy"
    }
  ];

  const live = await materializeManagedProjection({
    home: paths,
    targetRoot,
    projection: currentProjection,
    materialization: "copy"
  });
  assert.equal(live.ok, true);

  const initialState = registryState(
    targetRoot,
    currentSnapshot.contentDigest,
    0
  );
  seedRawState(paths, initialState);

  const desiredPlan: TargetPlan = {
    projections: [],
    reachablePackages: [],
    unreachableManagedPackages: [packageCoordinate]
  };
  const preflight = preflightTargetOwnership({
    desiredPlan,
    currentProjections: currentOwned,
    observedPaths: [
      {
        activationName: "demo",
        kind: "managed",
        packageCoordinate,
        contentDigest: currentSnapshot.contentDigest,
        materialization: "copy",
        expectedViewMatches: true
      }
    ]
  });
  if (!preflight.ok) {
    throw new Error(preflight.error.code);
  }

  return {
    currentSnapshot,
    currentOwned,
    initialState,
    desiredPlan,
    preflight: preflight.value,
    nextState: {
      targetId: initialState.targetId,
      locations: [{ path: targetRoot, observedGeneration: 1 }],
      directRequirements: [],
      resolvedSources: [],
      resolvedPackages: [],
      dependencyEdges: [],
      projections: [],
      detachedBaselines: [],
      dependencyObservations: []
    } satisfies RegistryTargetStateInput
  };
}

async function replacementFixture(
  paths: SkiloomHomePaths,
  targetRoot: string,
  currentBody: string,
  nextBody: string
) {
  const currentSnapshot = snapshotFor(currentBody);
  const nextSnapshot = snapshotFor(nextBody);
  await publish(paths, currentSnapshot);
  await publish(paths, nextSnapshot);

  const currentProjection = projectionFor(currentSnapshot.contentDigest);
  const nextProjection = projectionFor(nextSnapshot.contentDigest);
  const currentOwned: ReadonlyArray<TargetOwnedProjection> = [
    {
      projection: currentProjection,
      ownership: "managed",
      materialization: "copy"
    }
  ];

  const live = await materializeManagedProjection({
    home: paths,
    targetRoot,
    projection: currentProjection,
    materialization: "copy"
  });
  assert.equal(live.ok, true);

  const initialState = registryState(
    targetRoot,
    currentSnapshot.contentDigest,
    0
  );
  seedRawState(paths, initialState);

  const desiredPlan = targetPlan(nextProjection);
  const preflight = preflightTargetOwnership({
    desiredPlan,
    currentProjections: currentOwned,
    observedPaths: [
      {
        activationName: "demo",
        kind: "managed",
        packageCoordinate,
        contentDigest: currentSnapshot.contentDigest,
        materialization: "copy",
        expectedViewMatches: true
      }
    ]
  });
  if (!preflight.ok) {
    throw new Error(preflight.error.code);
  }

  return {
    currentSnapshot,
    nextSnapshot,
    currentOwned,
    initialState,
    desiredPlan,
    preflight: preflight.value,
    nextState: registryState(
      targetRoot,
      nextSnapshot.contentDigest,
      1
    )
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function snapshotFor(body: string) {
  const snapshot = createPackageSnapshot([
    {
      path: "SKILL.md",
      executable: false,
      content: Buffer.from(
        `---\nname: demo\ndescription: reconciliation fixture\n---\n${body}`,
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
  observedGeneration: number
): RegistryTargetStateInput {
  return {
    targetId: "target-db-first",
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
        materialization: "copy",
        transformJson: null
      }
    ],
    detachedBaselines: [],
    dependencyObservations: []
  };
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

async function publish(
  paths: SkiloomHomePaths,
  snapshot: ReturnType<typeof snapshotFor>
): Promise<void> {
  const published = await publishPackageSnapshot(paths, snapshot);
  if (!published.ok) {
    throw new Error(published.error.code);
  }
}

async function liveBody(targetRoot: string): Promise<string> {
  const markdown = await readFile(join(targetRoot, "demo", "SKILL.md"), "utf8");
  return markdown.slice(markdown.indexOf("---\n", 4) + 4);
}

async function withRuntime(
  run: (input: Readonly<{
    paths: SkiloomHomePaths;
    targetRoot: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skiloom-reconciliation-"));
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
