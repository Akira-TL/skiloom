import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  prepareTargetReconciliation
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
