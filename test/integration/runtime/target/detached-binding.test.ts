import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  acquireOperationLock,
  type OperationLockSession
} from "../../../../src/native/skiloom-lock.js";
import {
  forgetDetachedProjection
} from "../../../../src/runtime/orchestration/detached-binding.js";
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

const helperExecutable = requiredHelperExecutable();
const packageCoordinate = "acme/demo/demo";
const digest = `sha256:${"a".repeat(64)}`;

test("forget removes only the detached logical binding and baseline while preserving user bytes and exact graph facts", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const userPath = join(targetRoot, "demo");
    await mkdir(userPath);
    await writeFile(
      join(userPath, "SKILL.md"),
      "---\nname: demo\ndescription: detached fixture\n---\nuser-owned bytes\n",
      "utf8"
    );

    const acceptedState = detachedState(targetRoot);
    seedRawState(paths, acceptedState);

    await withRealLock(paths, async (lock) => {
      const registry = await requireLockedRegistry(paths, lock);
      try {
        const forgotten = await forgetDetachedProjection({
          lock,
          registry,
          acceptedState,
          packageCoordinate
        });
        assert.equal(forgotten.ok, true);
        if (!forgotten.ok) {
          return;
        }

        assert.equal(forgotten.value.generation, 2);
        assert.deepEqual(forgotten.value.projections, []);
        assert.deepEqual(forgotten.value.detachedBaselines, []);
        assert.deepEqual(
          forgotten.value.resolvedPackages,
          acceptedState.resolvedPackages
        );
        assert.deepEqual(
          forgotten.value.directRequirements,
          acceptedState.directRequirements
        );
      } finally {
        registry.close();
      }
    });

    assert.match(
      await readFile(join(userPath, "SKILL.md"), "utf8"),
      /user-owned bytes/u
    );
  });
});

function detachedState(targetRoot: string): RegistryTargetStateInput {
  return {
    targetId: "target-detached-binding",
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
        contentDigest: digest
      }
    ],
    dependencyEdges: [],
    projections: [
      {
        packageCoordinate,
        activationName: "demo",
        ownership: "detached",
        materialization: "copy",
        transformJson: null
      }
    ],
    detachedBaselines: [
      {
        packageCoordinate,
        repositoryCoordinate: "acme/demo",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit: "1111111111111111111111111111111111111111",
        packageRoot: ".",
        contentDigest: digest
      }
    ],
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
  const root = await mkdtemp(join(tmpdir(), "skiloom-detached-binding-"));
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
