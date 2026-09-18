import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  parseExactExportPackage
} from "../../../../src/domain/export-package/index.js";
import type {
  TargetOwnedProjection
} from "../../../../src/domain/target/preflight.js";
import type {
  OperationLockSession
} from "../../../../src/native/skiloom-lock.js";
import type {
  SkiloomHomePaths
} from "../../../../src/runtime/home.js";
import {
  detachTargetProjection
} from "../../../../src/runtime/orchestration/detached-lifecycle.js";
import {
  executeFirstAcceptedInstall
} from "../../../../src/runtime/orchestration/lifecycle/first-install.js";
import {
  acceptedTargetPlan
} from "../../../../src/runtime/orchestration/lifecycle/recovery/target.js";
import {
  exportManagedDependencies
} from "../../../../src/runtime/export/dependencies.js";
import type {
  MachineRegistry,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../../../../src/runtime/registry/index.js";
import {
  readTargetStateMarkerFile,
  writeTargetStateMarkerFile
} from "../../../../src/runtime/target-state-marker.js";
import {
  targetStateMarkerFactsFromRegistryState
} from "../../../../src/runtime/target-state-recovery.js";
import {
  lifecycleFixture,
  requireRegistry,
  targetId,
  withRealLock,
  withRuntime
} from "../lifecycle/completion-fixture.js";
import {
  releasePackageRequirement
} from "../lifecycle/github-source-fixture.js";

test("reconciled Target exports deterministic exact managed dependencies and never overwrites an existing destination", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = lifecycleFixture("v1.0.0");
      try {
        const installed = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry,
          directRequirements: [
            releasePackageRequirement(
              "acme/app/app",
              "^1.0.0"
            )
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createTargetId: () => targetId,
          createOperationId: () => "export-initial-install"
        });
        assert.equal(installed.ok, true);
        if (
          !installed.ok ||
          installed.value.status !== "installed"
        ) {
          return;
        }

        const firstPath = join(targetRoot, "first.skiloom-export");
        const first = await exportManagedDependencies({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: firstPath,
          lock,
          registry
        });
        assert.equal(first.ok, true);
        if (!first.ok) {
          return;
        }
        assert.deepEqual(first.value.warnings, []);

        const firstBytes = await readFile(firstPath);
        const parsed = parseExactExportPackage(firstBytes);
        assert.equal(parsed.ok, true);
        if (!parsed.ok) {
          return;
        }
        assert.equal(parsed.value.manifest.mode, "dependencies");
        assert.deepEqual(
          parsed.value.manifest.requirements.map((entry) => [
            entry.kind,
            entry.coordinate,
            entry.sourceKind
          ]),
          [["package", "acme/app/app", "github-release"]]
        );
        assert.deepEqual(
          parsed.value.manifest.sources.map((entry) =>
            entry.repositoryCoordinate
          ),
          ["acme/app", "acme/shared"]
        );
        assert.deepEqual(
          parsed.value.manifest.packages.map((entry) =>
            entry.packageCoordinate
          ),
          ["acme/app/app", "acme/shared/shared"]
        );
        assert.deepEqual(
          parsed.value.manifest.dependencies,
          [
            {
              fromPackageCoordinate: "acme/app/app",
              toPackageCoordinate: "acme/shared/shared"
            }
          ]
        );
        assert.deepEqual(
          parsed.value.manifest.projections.map((entry) => [
            entry.packageCoordinate,
            entry.activationName
          ]),
          [
            ["acme/app/app", "app"],
            ["acme/shared/shared", "shared"]
          ]
        );
        assert.deepEqual(parsed.value.manifest.detached, []);
        assert.deepEqual(parsed.value.manifest.userSkills, []);
        assert.equal(
          new Set(
            parsed.value.frames.map(
              (frame) => frame.payloadId
            )
          ).size,
          new Set(
            installed.value.state.resolvedPackages.map(
              (entry) => entry.contentDigest
            )
          ).size
        );

        const text = firstBytes.toString("utf8");
        assert.equal(text.includes(targetId), false);
        assert.equal(text.includes(targetRoot), false);
        assert.equal(text.includes(paths.homeRoot), false);

        const secondPath = join(
          targetRoot,
          "second.skiloom-export"
        );
        const second = await exportManagedDependencies({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: secondPath,
          lock,
          registry: reverseReadRegistry(registry)
        });
        assert.equal(second.ok, true);
        assert.deepEqual(
          await readFile(secondPath),
          firstBytes,
          "Registry iteration order must not affect canonical export bytes"
        );

        const original = Buffer.from(firstBytes);
        const existing = await exportManagedDependencies({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: firstPath,
          lock,
          registry
        });
        assert.equal(existing.ok, false);
        if (!existing.ok) {
          assert.equal(
            existing.error.code,
            "ExactExportDestinationExists"
          );
        }
        assert.deepEqual(await readFile(firstPath), original);
      } finally {
        registry.close();
      }
    });
  });
});


test("dependencies export refuses pending operations and stale public markers before destination publication", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const state = await installExportFixture({
          paths,
          targetRoot,
          lock,
          registry
        });
        const destination = join(
          targetRoot,
          "blocked.skiloom-export"
        );

        const pending = registry.beginPendingOperation(
          targetId,
          {
            operationId: "export-pending-operation",
            actions: [
              {
                stagingPath: join(
                  targetRoot,
                  ".skiloom-stage-export-pending"
                ),
                activationName: "app"
              }
            ]
          }
        );
        assert.equal(pending.ok, true);

        const blockedPending = await exportManagedDependencies({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: destination,
          lock,
          registry
        });
        assert.equal(blockedPending.ok, false);
        if (!blockedPending.ok) {
          assert.equal(
            blockedPending.error.code,
            "ExactExportTargetNotReconciled"
          );
          if (
            blockedPending.error.code ===
            "ExactExportTargetNotReconciled"
          ) {
            assert.equal(
              blockedPending.error.facts.reason,
              "pending-operation"
            );
          }
        }
        await assert.rejects(lstat(destination));
        assert.deepEqual(
          registry.completePendingOperation(
            "export-pending-operation"
          ),
          { ok: true, value: undefined }
        );

        const marker = await readTargetStateMarkerFile(
          targetRoot
        );
        assert.equal(marker.ok, true);
        if (!marker.ok || marker.value === null) {
          return;
        }
        assert.deepEqual(
          await writeTargetStateMarkerFile(
            targetRoot,
            {
              ...marker.value,
              generation: state.generation - 1
            }
          ),
          { ok: true, value: undefined }
        );

        const blockedStale = await exportManagedDependencies({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: destination,
          lock,
          registry
        });
        assert.equal(blockedStale.ok, false);
        if (!blockedStale.ok) {
          assert.equal(
            blockedStale.error.code,
            "ExactExportTargetNotReconciled"
          );
          if (
            blockedStale.error.code ===
            "ExactExportTargetNotReconciled"
          ) {
            assert.equal(
              blockedStale.error.facts.reason,
              "marker-not-current"
            );
          }
        }
        await assert.rejects(lstat(destination));

        assert.deepEqual(
          await writeTargetStateMarkerFile(
            targetRoot,
            {
              ...marker.value,
              generation: state.generation,
              requirements: []
            }
          ),
          { ok: true, value: undefined }
        );
        const blockedContent =
          await exportManagedDependencies({
            home: paths,
            targetId,
            targetRoot,
            destinationPath: destination,
            lock,
            registry
          });
        assert.equal(blockedContent.ok, false);
        if (!blockedContent.ok) {
          assert.equal(
            blockedContent.error.code,
            "ExactExportTargetNotReconciled"
          );
          if (
            blockedContent.error.code ===
            "ExactExportTargetNotReconciled"
          ) {
            assert.equal(
              blockedContent.error.facts.subject,
              "marker-content-mismatch"
            );
          }
        }
        await assert.rejects(lstat(destination));
      } finally {
        registry.close();
      }
    });
  });
});

test("dependencies export fails closed on managed Target drift and missing immutable Store content", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        await installExportFixture({
          paths,
          targetRoot,
          lock,
          registry
        });
        await rm(join(targetRoot, "app"), {
          recursive: true,
          force: true
        });
        await mkdir(join(targetRoot, "app"));
        await writeFile(
          join(targetRoot, "app", "SKILL.md"),
          "---\nname: app\ndescription: drift\n---\n",
          "utf8"
        );

        const drift = await exportManagedDependencies({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: join(
            targetRoot,
            "drift.skiloom-export"
          ),
          lock,
          registry
        });
        assert.equal(drift.ok, false);
        if (!drift.ok) {
          assert.equal(
            drift.error.code,
            "ManagedProjectionMaterializationMismatch"
          );
        }
      } finally {
        registry.close();
      }
    });
  });

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const state = await installExportFixture({
          paths,
          targetRoot,
          lock,
          registry
        });
        const shared = state.resolvedPackages.find(
          (entry) =>
            entry.packageCoordinate === "acme/shared/shared"
        );
        assert.notEqual(shared, undefined);
        await rm(
          join(
            paths.storePath,
            `sha256-${shared!.contentDigest.slice("sha256:".length)}`
          ),
          { recursive: true, force: true }
        );

        const missingStore = await exportManagedDependencies({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: join(
            targetRoot,
            "missing-store.skiloom-export"
          ),
          lock,
          registry
        });
        assert.equal(missingStore.ok, false);
        if (!missingStore.ok) {
          assert.equal(
            missingStore.error.code,
            "StoreEntryNotFound"
          );
        }
      } finally {
        registry.close();
      }
    });
  });
});

test("dependencies export keeps detached baseline managed payload but omits current user bytes with a warning", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const state = await installExportFixture({
          paths,
          targetRoot,
          lock,
          registry
        });
        const plan = acceptedTargetPlan(state);
        assert.equal(plan.ok, true);
        if (!plan.ok) {
          return;
        }
        const projection = plan.value.projections.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        );
        const registryProjection = state.projections.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        );
        assert.notEqual(projection, undefined);
        assert.notEqual(registryProjection, undefined);

        const current: TargetOwnedProjection = {
          projection: projection!,
          ownership: "managed",
          materialization: registryProjection!.materialization
        };
        const detached = await detachTargetProjection({
          home: paths,
          targetRoot,
          operationId: "export-detach-app",
          lock,
          registry,
          acceptedState: withoutGeneration(state),
          packageCoordinate: "acme/app/app",
          current
        });
        assert.equal(detached.ok, true);
        if (!detached.ok) {
          return;
        }

        const marker =
          targetStateMarkerFactsFromRegistryState(detached.value);
        assert.equal(marker.ok, true);
        if (!marker.ok) {
          return;
        }
        assert.deepEqual(
          await writeTargetStateMarkerFile(
            targetRoot,
            marker.value
          ),
          { ok: true, value: undefined }
        );

        const userText =
          "---\nname: app\ndescription: user override\n---\nDO-NOT-EXPORT-USER-BYTES\n";
        await writeFile(
          join(targetRoot, "app", "SKILL.md"),
          userText,
          "utf8"
        );

        const destination = join(
          targetRoot,
          "detached.skiloom-export"
        );
        const exported = await exportManagedDependencies({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: destination,
          lock,
          registry
        });
        assert.equal(exported.ok, true);
        if (!exported.ok) {
          return;
        }
        assert.deepEqual(exported.value.warnings, [
          {
            code: "DetachedOverrideBytesOmitted",
            facts: {
              packageCoordinate: "acme/app/app",
              activationName: "app"
            }
          }
        ]);

        const bytes = await readFile(destination);
        assert.equal(
          bytes.includes(
            Buffer.from("DO-NOT-EXPORT-USER-BYTES", "utf8")
          ),
          false
        );
        const parsed = parseExactExportPackage(bytes);
        assert.equal(parsed.ok, true);
        if (parsed.ok) {
          assert.deepEqual(parsed.value.manifest.detached, []);
          assert.equal(
            parsed.value.manifest.packages.some(
              (entry) =>
                entry.packageCoordinate === "acme/app/app"
            ),
            true
          );
        }
      } finally {
        registry.close();
      }
    });
  });
});

async function installExportFixture(
  input: Readonly<{
    paths: SkiloomHomePaths;
    targetRoot: string;
    lock: OperationLockSession;
    registry: MachineRegistry;
  }>
): Promise<RegistryTargetState> {
  const fixture = lifecycleFixture("v1.0.0");
  const installed = await executeFirstAcceptedInstall({
    home: input.paths,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry,
    directRequirements: [
      releasePackageRequirement(
        "acme/app/app",
        "^1.0.0"
      )
    ],
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport,
    acceptCandidate: () => true,
    createTargetId: () => targetId,
    createOperationId: () => "export-fixture-install"
  });
  assert.equal(installed.ok, true);
  if (!installed.ok || installed.value.status !== "installed") {
    throw new Error("export fixture install failed");
  }
  return installed.value.state;
}

function withoutGeneration(
  state: RegistryTargetState
): RegistryTargetStateInput {
  const { generation: _generation, ...input } = state;
  return input;
}

function reverseReadRegistry(
  registry: MachineRegistry
): MachineRegistry {
  return {
    close: () => registry.close(),
    pragmas: () => registry.pragmas(),
    readTargetState: (id) => {
      const read = registry.readTargetState(id);
      if (!read.ok || read.value === undefined) {
        return read;
      }
      return {
        ok: true,
        value: reverseState(read.value)
      };
    },
    readPendingOperations: () => registry.readPendingOperations(),
    beginPendingOperation: (id, pending) =>
      registry.beginPendingOperation(id, pending),
    beginPendingReconciliation: (id, pending) =>
      registry.beginPendingReconciliation(id, pending),
    completePendingOperation: (operationId) =>
      registry.completePendingOperation(operationId),
    replaceTargetState: (state, pendingOperationId) =>
      registry.replaceTargetState(state, pendingOperationId)
  };
}

function reverseState(
  state: RegistryTargetState
): RegistryTargetState {
  return {
    ...state,
    locations: [...state.locations].reverse(),
    directRequirements: [...state.directRequirements].reverse(),
    resolvedSources: [...state.resolvedSources].reverse(),
    resolvedPackages: [...state.resolvedPackages].reverse(),
    dependencyEdges: [...state.dependencyEdges].reverse(),
    projections: [...state.projections].reverse(),
    detachedBaselines: [...state.detachedBaselines].reverse(),
    dependencyObservations: [
      ...state.dependencyObservations
    ].reverse()
  };
}
