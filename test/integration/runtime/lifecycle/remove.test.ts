import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type {
  TargetOwnedProjection
} from "../../../../src/domain/target/preflight.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../../../../src/native/skiloom-lock.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../../../../src/runtime/home.js";
import {
  detachTargetProjection
} from "../../../../src/runtime/orchestration/detached-lifecycle.js";
import {
  executeFirstAcceptedInstall
} from "../../../../src/runtime/orchestration/lifecycle/first-install.js";
import {
  removeAcceptedTargetRequirement
} from "../../../../src/runtime/orchestration/lifecycle/remove.js";
import {
  openMachineRegistry,
  type MachineRegistry,
  type RegistryTargetState
} from "../../../../src/runtime/registry/index.js";
import {
  release,
  releasePackageRequirement,
  releaseRepository,
  releaseRepositoryRequirement,
  skillPackage,
  sourceFixture
} from "./github-source-fixture.js";

const helperExecutable = requiredHelperExecutable();
const targetId = "55555555-5555-4555-8555-555555555555";

test("removing one root commits first, removes only unreachable managed projection, and keeps shared dependency", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = sharedRootsFixture();
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture,
          requirements: [
            releasePackageRequirement("acme/app/app"),
            releasePackageRequirement("acme/tool/tool")
          ]
        });
        assert.equal(initial.generation, 1);
        assert.equal(readdirSync(paths.storePath).length, 3);

        const observedRegistry = observeRegistry(
          registry,
          (state) => {
            assert.equal(state.generation, 2);
            assert.equal(
              state.resolvedPackages.some(
                (entry) =>
                  entry.packageCoordinate === "acme/app/app"
              ),
              false
            );
            assert.equal(
              existsSync(join(targetRoot, "app")),
              true,
              "unreachable live projection must remain until after DB commit"
            );
            assert.equal(existsSync(join(targetRoot, "tool")), true);
            assert.equal(existsSync(join(targetRoot, "shared")), true);
          }
        );

        const result = await removeAcceptedTargetRequirement({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry: observedRegistry,
          remove: {
            kind: "package",
            coordinate: "acme/app/app"
          },
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "remove-app-root",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "removed") {
          return;
        }
        assert.equal(result.value.state.generation, 2);
        assert.deepEqual(
          result.value.state.directRequirements.map(
            (entry) => entry.coordinate
          ),
          ["acme/tool/tool"]
        );
        assert.deepEqual(
          result.value.state.resolvedPackages.map(
            (entry) => entry.packageCoordinate
          ),
          ["acme/shared/shared", "acme/tool/tool"]
        );
        assert.equal(existsSync(join(targetRoot, "app")), false);
        assert.equal(existsSync(join(targetRoot, "tool")), true);
        assert.equal(existsSync(join(targetRoot, "shared")), true);
        assert.equal(
          readdirSync(paths.storePath).length,
          3,
          "remove must not garbage-collect immutable Store entries"
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("removing a repository-wide root removes all of its roots while preserving another direct Package", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = sourceFixture([
        releaseRepository("acme/suite", [
          release(
            "v1.0.0",
            "4",
            [
              skillPackage(
                "skills/alpha",
                "alpha",
                "Alpha package."
              ),
              skillPackage(
                "skills/beta",
                "beta",
                "Beta package."
              )
            ],
            `schema = 1

[discovery]
include = ["skills/*"]
`
          )
        ]),
        releaseRepository("acme/keeper", [
          release("v1.0.0", "5", [
            skillPackage(".", "keeper", "Keeper package.")
          ])
        ])
      ]);
      try {
        await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture,
          requirements: [
            releaseRepositoryRequirement("acme/suite"),
            releasePackageRequirement("acme/keeper/keeper")
          ]
        });
        assert.equal(readdirSync(paths.storePath).length, 3);

        const result = await removeAcceptedTargetRequirement({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          remove: {
            kind: "repository",
            coordinate: "ACME/SUITE"
          },
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "remove-suite-root",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "removed") {
          return;
        }
        assert.deepEqual(
          result.value.state.directRequirements.map(
            (entry) => [entry.kind, entry.coordinate]
          ),
          [["package", "acme/keeper/keeper"]]
        );
        assert.equal(existsSync(join(targetRoot, "alpha")), false);
        assert.equal(existsSync(join(targetRoot, "beta")), false);
        assert.equal(existsSync(join(targetRoot, "keeper")), true);
        assert.equal(readdirSync(paths.storePath).length, 3);
      } finally {
        registry.close();
      }
    });
  });
});

test("removing the final root accepts an empty managed graph and preserves foreign content and Store", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = singleAppFixture();
      try {
        await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture,
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        const storeBefore = [...readdirSync(paths.storePath)].sort();
        const foreign = join(targetRoot, "manual-skill");
        await mkdir(foreign);
        await writeFile(
          join(foreign, "KEEP"),
          "manual foreign bytes\n"
        );

        const result = await removeAcceptedTargetRequirement({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          remove: {
            kind: "package",
            coordinate: "acme/app/app"
          },
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "remove-final-root",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "removed") {
          return;
        }
        assert.equal(result.value.state.generation, 2);
        assert.deepEqual(result.value.state.directRequirements, []);
        assert.deepEqual(result.value.state.resolvedSources, []);
        assert.deepEqual(result.value.state.resolvedPackages, []);
        assert.deepEqual(result.value.state.dependencyEdges, []);
        assert.deepEqual(result.value.state.projections, []);
        assert.equal(existsSync(join(targetRoot, "app")), false);
        assert.equal(
          await readFile(join(foreign, "KEEP"), "utf8"),
          "manual foreign bytes\n"
        );
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("removing a detached final root drops only logical binding and baseline while preserving user bytes", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = singleAppFixture();
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture,
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        const packageFact = initial.resolvedPackages[0]!;
        const projection = initial.projections[0]!;
        const current: TargetOwnedProjection = {
          projection: {
            packageCoordinate: packageFact.packageCoordinate,
            packageRoot: packageFact.packageRoot,
            contentDigest: packageFact.contentDigest,
            activationName: projection.activationName,
            projectionKind: "direct",
            transform: null
          },
          ownership: "managed",
          materialization: projection.materialization
        };
        const detached = await detachTargetProjection({
          home: paths,
          targetRoot,
          operationId: "detach-before-remove",
          lock,
          registry,
          acceptedState: initial,
          packageCoordinate: "acme/app/app",
          current
        });
        assert.equal(detached.ok, true);
        if (!detached.ok) {
          return;
        }
        await writeFile(
          join(targetRoot, "app", "USER-NOTE"),
          "keep detached bytes\n"
        );
        const storeBefore = [...readdirSync(paths.storePath)].sort();

        const result = await removeAcceptedTargetRequirement({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          remove: {
            kind: "package",
            coordinate: "acme/app/app"
          },
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "remove-detached-root",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "removed") {
          return;
        }
        assert.equal(result.value.state.generation, 3);
        assert.deepEqual(result.value.state.directRequirements, []);
        assert.deepEqual(result.value.state.resolvedPackages, []);
        assert.deepEqual(result.value.state.projections, []);
        assert.deepEqual(result.value.state.detachedBaselines, []);
        assert.equal(
          await readFile(join(targetRoot, "app", "USER-NOTE"), "utf8"),
          "keep detached bytes\n"
        );
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("declined remove preserves prior accepted Registry Store and live Target", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = sharedRootsFixture();
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture,
          requirements: [
            releasePackageRequirement("acme/app/app"),
            releasePackageRequirement("acme/tool/tool")
          ]
        });
        const storeBefore = [...readdirSync(paths.storePath)].sort();
        let markerCalls = 0;

        const result = await removeAcceptedTargetRequirement({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          remove: {
            kind: "package",
            coordinate: "acme/app/app"
          },
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => false,
          createOperationId: () => "declined-remove",
          syncMarker: () => {
            markerCalls += 1;
          }
        });

        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.status, "declined");
          assert.deepEqual(result.value.state, initial);
        }
        assert.equal(markerCalls, 0);
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: initial }
        );
        assert.equal(existsSync(join(targetRoot, "app")), true);
        assert.equal(existsSync(join(targetRoot, "tool")), true);
        assert.equal(existsSync(join(targetRoot, "shared")), true);
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("modified managed bytes make remove fail closed without deleting live content or changing Registry", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = singleAppFixture();
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture,
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        const storeBefore = [...readdirSync(paths.storePath)].sort();
        await rm(join(targetRoot, "app"), {
          recursive: true,
          force: true
        });
        await mkdir(join(targetRoot, "app"));
        await writeFile(
          join(targetRoot, "app", "KEEP"),
          "modified user-visible bytes\n"
        );

        const result = await removeAcceptedTargetRequirement({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          remove: {
            kind: "package",
            coordinate: "acme/app/app"
          },
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "failed-modified-remove",
          syncMarker: () => {}
        });

        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error.code, "ModifiedManagedProjection");
        }
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: initial }
        );
        assert.equal(
          await readFile(join(targetRoot, "app", "KEEP"), "utf8"),
          "modified user-visible bytes\n"
        );
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );
      } finally {
        registry.close();
      }
    });
  });
});

function singleAppFixture() {
  return sourceFixture([
    releaseRepository("acme/app", [
      release("v1.0.0", "1", [
        skillPackage(".", "app", "Application.")
      ])
    ])
  ]);
}

function sharedRootsFixture() {
  return sourceFixture([
    releaseRepository("acme/app", [
      release("v1.0.0", "1", [
        skillPackage(
          ".",
          "app",
          "Application.",
          { "acme/shared/shared": "^1.0.0" }
        )
      ])
    ]),
    releaseRepository("acme/tool", [
      release("v1.0.0", "2", [
        skillPackage(
          ".",
          "tool",
          "Tool.",
          { "acme/shared/shared": "^1.0.0" }
        )
      ])
    ]),
    releaseRepository("acme/shared", [
      release("v1.0.0", "3", [
        skillPackage(".", "shared", "Shared.")
      ])
    ])
  ]);
}

async function install(input: Readonly<{
  paths: SkiloomHomePaths;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  fixture: ReturnType<typeof sourceFixture>;
  requirements: Parameters<
    typeof executeFirstAcceptedInstall
  >[0]["directRequirements"];
}>): Promise<RegistryTargetState> {
  const installed = await executeFirstAcceptedInstall({
    home: input.paths,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry,
    directRequirements: input.requirements,
    repositoryTransport: input.fixture.repositoryTransport,
    transport: input.fixture.transport,
    acceptCandidate: () => true,
    createTargetId: () => targetId,
    createOperationId: () => "initial-remove-fixture",
    syncMarker: () => {}
  });
  assert.equal(installed.ok, true);
  if (!installed.ok || installed.value.status !== "installed") {
    throw new Error("initial remove fixture install failed");
  }
  return installed.value.state;
}

function observeRegistry(
  registry: MachineRegistry,
  afterReplace: (state: RegistryTargetState) => void
): MachineRegistry {
  return {
    close: () => registry.close(),
    pragmas: () => registry.pragmas(),
    readTargetState: (id) => registry.readTargetState(id),
    readPendingOperations: () => registry.readPendingOperations(),
    beginPendingOperation: (id, pending) =>
      registry.beginPendingOperation(id, pending),
    beginPendingReconciliation: (id, pending) =>
      registry.beginPendingReconciliation(id, pending),
    completePendingOperation: (operationId) =>
      registry.completePendingOperation(operationId),
    observeTargetLocation: (
      targetId,
      path,
      observedGeneration
    ) =>
      registry.observeTargetLocation(
        targetId,
        path,
        observedGeneration
      ),
    replaceDependencyObservations: (
      targetId,
      kind,
      observations
    ) =>
      registry.replaceDependencyObservations(
        targetId,
        kind,
        observations
      ),
    replaceTargetState: (state, pendingOperationId) => {
      const replaced = registry.replaceTargetState(
        state,
        pendingOperationId
      );
      if (replaced.ok) {
        afterReplace(replaced.value);
      }
      return replaced;
    }
  };
}

async function requireRegistry(
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
  const root = await mkdtemp(join(tmpdir(), "skiloom-remove-"));
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
