import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { detachTargetProjection } from "../../../../src/runtime/orchestration/local-lifecycle.js";
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
import { publishPackageSnapshot } from "../../../../src/runtime/store.js";
import { materializeManagedProjection } from "../../../../src/runtime/target-projection/index.js";

const helperExecutable = requiredHelperExecutable();
const packageCoordinate = "acme/demo/demo";

test("modified managed content blocks detach without changing Registry authority or user-visible bytes", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const snapshot = snapshotFor("original managed bytes\n");
    const published = await publishPackageSnapshot(paths, snapshot);
    assert.equal(published.ok, true);

    const projection = projectionFor(snapshot.contentDigest);
    const current: TargetOwnedProjection = {
      projection,
      ownership: "managed",
      materialization: "copy"
    };
    const materialized = await materializeManagedProjection({
      home: paths,
      targetRoot,
      projection,
      materialization: "copy"
    });
    assert.equal(materialized.ok, true);

    const acceptedState = registryState(targetRoot, snapshot.contentDigest);
    seedRawState(paths, acceptedState);

    const modifiedBytes =
      "---\nname: demo\ndescription: lifecycle safety fixture\n---\nuser modified bytes\n";
    await writeFile(
      join(targetRoot, "demo", "SKILL.md"),
      modifiedBytes,
      "utf8"
    );

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const detached = await detachTargetProjection({
          home: paths,
          targetRoot,
          operationId: "detach-modified-managed",
          lock,
          registry,
          acceptedState,
          packageCoordinate,
          current
        });
        assert.equal(detached.ok, false);
        if (!detached.ok) {
          assert.equal(detached.error.code, "ManagedProjectionContentMismatch");
        }

        const state = registry.readTargetState(acceptedState.targetId);
        assert.equal(state.ok, true);
        if (state.ok) {
          assert.equal(state.value?.generation, 1);
          assert.equal(state.value?.projections[0]?.ownership, "managed");
          assert.deepEqual(state.value?.detachedBaselines, []);
        }
      } finally {
        registry.close();
      }
    });

    assert.equal(
      await readFile(join(targetRoot, "demo", "SKILL.md"), "utf8"),
      modifiedBytes
    );
  });
});

test("foreign content at a planned activation fails preflight under the operation lock and remains untouched", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const foreignPath = join(targetRoot, "demo");
    await mkdir(foreignPath);
    await writeFile(join(foreignPath, "KEEP"), "foreign bytes\n");

    const acceptedState: RegistryTargetStateInput = {
      targetId: "target-foreign-safety",
      locations: [{ path: targetRoot, observedGeneration: 1 }],
      directRequirements: [],
      resolvedSources: [],
      resolvedPackages: [],
      dependencyEdges: [],
      projections: [],
      detachedBaselines: [],
      dependencyObservations: []
    };
    seedRawState(paths, acceptedState);

    const projection: TargetProjection = {
      packageCoordinate,
      packageRoot: ".",
      contentDigest: "sha256:" + "f".repeat(64),
      activationName: "demo",
      projectionKind: "direct",
      transform: null
    };
    const desiredPlan: TargetPlan = {
      projections: [projection],
      reachablePackages: [packageCoordinate],
      unreachableManagedPackages: []
    };

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const preflight = preflightTargetOwnership({
          desiredPlan,
          currentProjections: [],
          observedPaths: [
            {
              activationName: "demo",
              kind: "existing"
            }
          ]
        });
        assert.equal(preflight.ok, false);
        if (!preflight.ok) {
          assert.deepEqual(preflight.error, {
            code: "ForeignTargetPathConflict",
            facts: {
              activationName: "demo",
              desiredPackageCoordinate: packageCoordinate
            }
          });
        }

        const state = registry.readTargetState(acceptedState.targetId);
        assert.equal(state.ok, true);
        if (state.ok) {
          assert.equal(state.value?.generation, 1);
          assert.deepEqual(state.value?.projections, []);
        }
      } finally {
        registry.close();
      }
    });

    assert.equal(
      await readFile(join(foreignPath, "KEEP"), "utf8"),
      "foreign bytes\n"
    );
  });
});

function snapshotFor(body: string) {
  const snapshot = createPackageSnapshot([
    {
      path: "SKILL.md",
      executable: false,
      content: Buffer.from(
        "---\nname: demo\ndescription: lifecycle safety fixture\n---\n" + body,
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

function registryState(
  targetRoot: string,
  contentDigest: string
): RegistryTargetStateInput {
  return {
    targetId: "target-lifecycle-safety",
    locations: [{ path: targetRoot, observedGeneration: 1 }],
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

async function withRuntime(
  run: (input: Readonly<{
    paths: SkiloomHomePaths;
    targetRoot: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skiloom-lifecycle-safety-"));
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
