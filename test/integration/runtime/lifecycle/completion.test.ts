import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { preflightTargetOwnership } from "../../../../src/domain/target/preflight.js";
import { addAcceptedTargetRoots } from "../../../../src/runtime/orchestration/lifecycle/add-root.js";
import { removeAcceptedTargetRequirement } from "../../../../src/runtime/orchestration/lifecycle/remove.js";
import { updateAcceptedTarget } from "../../../../src/runtime/orchestration/lifecycle/update.js";
import { syncAcceptedTargetState } from "../../../../src/runtime/orchestration/local-lifecycle.js";
import { cleanupPendingTargetStaging } from "../../../../src/runtime/orchestration/target-reconcile.js";
import type { RegistryTargetState } from "../../../../src/runtime/registry/index.js";
import { releasePackageRequirement, releaseRepositoryRequirement } from "./github-source-fixture.js";
import {
  afterSuccessfulReplaceRegistry,
  countRegistryWrites,
  currentOwnedForOldState,
  failBeforeCommitRegistry,
  install,
  interruptAfterCommitLock,
  lifecycleFixture,
  requireRegistry,
  singleAppFixture,
  stateInput,
  targetId,
  targetPlanForState,
  withRealLock,
  withRuntime
} from "./completion-fixture.js";

test("identical complete update is a true no-op before acceptance or protected writes", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = singleAppFixture(
        "v1.0.0",
        "1",
        "No-op application."
      );
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture,
          requirements: [
            releasePackageRequirement(
              "acme/app/app",
              "^1.0.0"
            )
          ]
        });
        const storeBefore = [...readdirSync(paths.storePath)].sort();
        const liveBefore = await readFile(
          join(targetRoot, "app", "SKILL.md"),
          "utf8"
        );
        const counters = {
          beginPending: 0,
          beginReconciliation: 0,
          replace: 0,
          completePending: 0
        };
        const observedRegistry = countRegistryWrites(
          registry,
          counters
        );
        let acceptanceCalls = 0;
        let markerCalls = 0;

        const result = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry: observedRegistry,
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => {
            acceptanceCalls += 1;
            return true;
          },
          createOperationId: () => "must-not-be-used",
          syncMarker: () => {
            markerCalls += 1;
          }
        });

        assert.equal(result.ok, true);
        if (!result.ok) {
          return;
        }
        assert.equal(result.value.status, "no-op");
        assert.equal(result.value.plan.noChange, true);
        assert.equal(result.value.state.generation, 1);
        assert.equal(acceptanceCalls, 0);
        assert.equal(markerCalls, 0);
        assert.deepEqual(counters, {
          beginPending: 0,
          beginReconciliation: 0,
          replace: 0,
          completePending: 0
        });
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );
        assert.equal(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          liveBefore
        );
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: initial }
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("one temporary environment completes install add-package add-repository update and remove", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const initialFixture = lifecycleFixture("v1.0.0");
      try {
        const installed = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: initialFixture,
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        assert.equal(installed.generation, 1);

        const addedPackage = await addAcceptedTargetRoots({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          additions: [
            releasePackageRequirement("acme/tool/tool")
          ],
          repositoryTransport:
            initialFixture.repositoryTransport,
          transport: initialFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "completion-add-package",
          syncMarker: () => {}
        });
        assert.equal(addedPackage.ok, true);
        if (
          !addedPackage.ok ||
          addedPackage.value.status !== "applied"
        ) {
          return;
        }
        assert.equal(addedPackage.value.state.generation, 2);

        const addedRepository = await addAcceptedTargetRoots({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          additions: [
            releaseRepositoryRequirement("acme/suite")
          ],
          repositoryTransport:
            initialFixture.repositoryTransport,
          transport: initialFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "completion-add-repository",
          syncMarker: () => {}
        });
        assert.equal(addedRepository.ok, true);
        if (
          !addedRepository.ok ||
          addedRepository.value.status !== "applied"
        ) {
          return;
        }
        assert.equal(addedRepository.value.state.generation, 3);
        assert.equal(existsSync(join(targetRoot, "alpha")), true);
        assert.equal(existsSync(join(targetRoot, "beta")), true);

        const updateFixture = lifecycleFixture("v2.0.0");
        const updated = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          repositoryTransport:
            updateFixture.repositoryTransport,
          transport: updateFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "completion-update",
          syncMarker: () => {}
        });
        assert.equal(updated.ok, true);
        if (!updated.ok || updated.value.status !== "updated") {
          return;
        }
        assert.equal(updated.value.state.generation, 4);
        assert.match(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          /v2\.0\.0/u
        );
        assert.match(
          await readFile(join(targetRoot, "tool", "SKILL.md"), "utf8"),
          /v2\.0\.0/u
        );

        const storeBeforeRemove =
          [...readdirSync(paths.storePath)].sort();
        const removed = await removeAcceptedTargetRequirement({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          remove: {
            kind: "package",
            coordinate: "acme/tool/tool"
          },
          repositoryTransport:
            updateFixture.repositoryTransport,
          transport: updateFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "completion-remove",
          syncMarker: () => {}
        });
        assert.equal(removed.ok, true);
        if (!removed.ok || removed.value.status !== "removed") {
          return;
        }
        assert.equal(removed.value.state.generation, 5);
        assert.equal(existsSync(join(targetRoot, "tool")), false);
        assert.equal(existsSync(join(targetRoot, "app")), true);
        assert.equal(existsSync(join(targetRoot, "shared")), true);
        assert.equal(existsSync(join(targetRoot, "alpha")), true);
        assert.equal(existsSync(join(targetRoot, "beta")), true);
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBeforeRemove,
          "lifecycle remove must not garbage-collect Store"
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("pre-commit lifecycle interruption preserves old authority and live Target and recorded staging is safely cleanable", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const initialFixture = singleAppFixture(
        "v1.0.0",
        "2",
        "Precommit v1."
      );
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: initialFixture,
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        const interruptedRegistry =
          failBeforeCommitRegistry(
            registry,
            paths.operationLockPath
          );
        const updateFixture = singleAppFixture(
          "v2.0.0",
          "3",
          "Precommit v2."
        );

        const interrupted = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry: interruptedRegistry,
          repositoryTransport:
            updateFixture.repositoryTransport,
          transport: updateFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "precommit-interruption",
          syncMarker: () => {}
        });

        assert.equal(interrupted.ok, false);
        if (!interrupted.ok) {
          assert.equal(interrupted.error.code, "OperationLockLost");
        }
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: initial }
        );
        assert.match(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          /Precommit v1\./u
        );
        const pending = registry.readPendingOperations();
        assert.equal(pending.ok, true);
        if (pending.ok) {
          assert.equal(pending.value.length, 1);
        }

        const cleaned = await cleanupPendingTargetStaging({
          targetId,
          targetRoot,
          lock,
          registry
        });
        assert.deepEqual(cleaned, { ok: true, value: undefined });
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: initial }
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("post-commit lifecycle interruption leaves new DB authority and later sync converges live Target without a new generation", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    let oldState: RegistryTargetState | undefined;
    let acceptedAfterCommit: RegistryTargetState | undefined;

    await withRealLock(paths, async (realLock) => {
      const registry = await requireRegistry(paths, realLock);
      const initialFixture = singleAppFixture(
        "v1.0.0",
        "4",
        "Postcommit v1."
      );
      try {
        oldState = await install({
          paths,
          targetRoot,
          lock: realLock,
          registry,
          fixture: initialFixture,
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        const phase = interruptAfterCommitLock(
          realLock,
          paths.operationLockPath
        );
        const interruptingRegistry =
          afterSuccessfulReplaceRegistry(
            registry,
            () => phase.interrupt()
          );
        const updateFixture = singleAppFixture(
          "v2.0.0",
          "5",
          "Postcommit v2."
        );

        const interrupted = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock: phase.lock,
          registry: interruptingRegistry,
          repositoryTransport:
            updateFixture.repositoryTransport,
          transport: updateFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "postcommit-interruption",
          syncMarker: () => {}
        });

        assert.equal(interrupted.ok, false);
        if (!interrupted.ok) {
          assert.equal(interrupted.error.code, "OperationLockLost");
        }
        const accepted = registry.readTargetState(targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          acceptedAfterCommit = accepted.value;
          assert.equal(accepted.value?.generation, 2);
        }
        assert.match(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          /Postcommit v1\./u,
          "live Target must remain old after post-commit interruption"
        );
        const pending = registry.readPendingOperations();
        assert.equal(pending.ok, true);
        if (pending.ok) {
          assert.equal(pending.value.length, 1);
        }
      } finally {
        registry.close();
      }
    });

    assert.notEqual(oldState, undefined);
    assert.notEqual(acceptedAfterCommit, undefined);
    if (
      oldState === undefined ||
      acceptedAfterCommit === undefined
    ) {
      return;
    }

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const desiredPlan = targetPlanForState(
          acceptedAfterCommit!
        );
        const currentOwned =
          currentOwnedForOldState(oldState!);
        const oldPackage = oldState!.resolvedPackages[0]!;
        const oldProjection = oldState!.projections[0]!;
        const preflight = preflightTargetOwnership({
          desiredPlan,
          currentProjections: currentOwned,
          observedPaths: [
            {
              activationName: oldProjection.activationName,
              kind: "managed",
              packageCoordinate: oldPackage.packageCoordinate,
              contentDigest: oldPackage.contentDigest,
              materialization: oldProjection.materialization,
              expectedViewMatches: true
            }
          ]
        });
        assert.equal(preflight.ok, true);
        if (!preflight.ok) {
          return;
        }

        const synced = await syncAcceptedTargetState({
          home: paths,
          targetRoot,
          operationId: "sync-after-postcommit-interruption",
          lock,
          registry,
          desiredPlan,
          preflight: preflight.value,
          currentProjections: currentOwned,
          acceptedState: stateInput(acceptedAfterCommit!)
        });
        assert.equal(synced.ok, true);
        if (synced.ok) {
          assert.equal(synced.value.generation, 2);
        }
        assert.match(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          /Postcommit v2\./u
        );
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
        const accepted = registry.readTargetState(targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(accepted.value?.generation, 2);
        }
      } finally {
        registry.close();
      }
    });
  });
});
