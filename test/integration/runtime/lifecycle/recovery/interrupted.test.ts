import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  recoverInterruptedLifecycle
} from "../../../../../src/runtime/orchestration/lifecycle/recovery/index.js";
import {
  removeAcceptedTargetRequirement
} from "../../../../../src/runtime/orchestration/lifecycle/remove.js";
import {
  updateAcceptedTarget
} from "../../../../../src/runtime/orchestration/lifecycle/update.js";
import {
  releasePackageRequirement
} from "../github-source-fixture.js";
import {
  afterSuccessfulReplaceRegistry,
  failBeforeCommitRegistry,
  install,
  interruptAfterCommitLock,
  requireRegistry,
  singleAppFixture,
  targetId,
  withRealLock,
  withRuntime
} from "../completion-fixture.js";

test("fresh-session recovery classifies pre-commit pending work and cleans only recorded staging", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    let originalGeneration = 0;

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: singleAppFixture(
            "v1.0.0",
            "1",
            "Recovery precommit v1."
          ),
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        originalGeneration = initial.generation;

        const updateFixture = singleAppFixture(
          "v2.0.0",
          "2",
          "Recovery precommit v2."
        );
        const interrupted = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry: failBeforeCommitRegistry(
            registry,
            paths.operationLockPath
          ),
          repositoryTransport:
            updateFixture.repositoryTransport,
          transport: updateFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () =>
            "recovery-precommit-operation",
          syncMarker: () => {}
        });
        assert.equal(interrupted.ok, false);
        if (!interrupted.ok) {
          assert.equal(
            interrupted.error.code,
            "OperationLockLost"
          );
        }

        const pending = registry.readPendingOperations();
        assert.equal(pending.ok, true);
        if (pending.ok) {
          assert.equal(pending.value.length, 1);
          assert.equal(
            pending.value[0]?.baseGeneration,
            originalGeneration
          );
          assert.equal(
            pending.value[0]?.nextGeneration,
            originalGeneration + 1
          );
          assert.equal(
            pending.value[0]?.actions.length,
            1
          );
        }
      } finally {
        registry.close();
      }
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      let markerCalls = 0;
      try {
        const recovered = await recoverInterruptedLifecycle({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          syncMarker: () => {
            markerCalls += 1;
          }
        });

        assert.deepEqual(recovered, {
          ok: true,
          value: {
            status: "pre-commit-cleaned",
            targetId,
            operationId:
              "recovery-precommit-operation",
            generation: originalGeneration
          }
        });
        assert.equal(markerCalls, 0);
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
        const accepted = registry.readTargetState(targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(
            accepted.value?.generation,
            originalGeneration
          );
        }
        assert.match(
          await readFile(
            join(targetRoot, "app", "SKILL.md"),
            "utf8"
          ),
          /Recovery precommit v1\./u
        );

        const repeated = await recoverInterruptedLifecycle({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          syncMarker: () => {
            markerCalls += 1;
          }
        });
        assert.deepEqual(repeated, {
          ok: true,
          value: {
            status: "no-pending",
            targetId
          }
        });
        assert.equal(markerCalls, 0);
      } finally {
        registry.close();
      }
    });
  });
});

test("fresh-session post-commit recovery converges accepted DB authority then syncs marker without incrementing generation", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await createPostCommitInterruption({
      paths,
      targetRoot,
      operationId: "recovery-postcommit-operation",
      oldDescription: "Recovery postcommit v1.",
      newDescription: "Recovery postcommit v2."
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      let markerCalls = 0;
      try {
        const before = registry.readTargetState(targetId);
        assert.equal(before.ok, true);
        if (!before.ok || before.value === undefined) {
          return;
        }
        const acceptedGeneration = before.value.generation;
        assert.equal(acceptedGeneration, 2);

        const recovered = await recoverInterruptedLifecycle({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          syncMarker: async (marker) => {
            markerCalls += 1;
            assert.equal(marker.generation, acceptedGeneration);
            assert.match(
              await readFile(
                join(targetRoot, "app", "SKILL.md"),
                "utf8"
              ),
              /Recovery postcommit v2\./u,
              "marker must run only after live Target converges"
            );
          }
        });

        assert.equal(recovered.ok, true);
        if (
          recovered.ok &&
          recovered.value.status === "post-commit-recovered"
        ) {
          assert.equal(
            recovered.value.operationId,
            "recovery-postcommit-operation"
          );
          assert.equal(
            recovered.value.state.generation,
            acceptedGeneration
          );
        }
        assert.equal(markerCalls, 1);
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
        const after = registry.readTargetState(targetId);
        assert.equal(after.ok, true);
        if (after.ok) {
          assert.equal(
            after.value?.generation,
            acceptedGeneration
          );
        }

        const repeated = await recoverInterruptedLifecycle({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          syncMarker: () => {
            markerCalls += 1;
          }
        });
        assert.deepEqual(repeated, {
          ok: true,
          value: {
            status: "no-pending",
            targetId
          }
        });
        assert.equal(markerCalls, 1);
      } finally {
        registry.close();
      }
    });
  });
});

test("post-commit removal recovery uses pending proof to delete only the previously managed projection", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const fixture = singleAppFixture(
      "v1.0.0",
      "5",
      "Removal recovery v1."
    );

    await withRealLock(paths, async (realLock) => {
      const registry = await requireRegistry(paths, realLock);
      try {
        await install({
          paths,
          targetRoot,
          lock: realLock,
          registry,
          fixture,
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });

        const phase = interruptAfterCommitLock(
          realLock,
          paths.operationLockPath
        );
        const interrupted =
          await removeAcceptedTargetRequirement({
            home: paths,
            targetId,
            targetRoot,
            lock: phase.lock,
            registry: afterSuccessfulReplaceRegistry(
              registry,
              () => phase.interrupt()
            ),
            remove: {
              kind: "package",
              coordinate: "acme/app/app"
            },
            repositoryTransport:
              fixture.repositoryTransport,
            transport: fixture.transport,
            acceptCandidate: () => true,
            createOperationId: () =>
              "recovery-remove-operation",
            syncMarker: () => {}
          });

        assert.equal(interrupted.ok, false);
        if (!interrupted.ok) {
          assert.equal(
            interrupted.error.code,
            "OperationLockLost"
          );
        }
        assert.equal(
          await readFile(
            join(targetRoot, "app", "SKILL.md"),
            "utf8"
          ).then(() => true),
          true
        );
        const pending = registry.readPendingOperations();
        assert.equal(pending.ok, true);
        if (pending.ok) {
          assert.equal(pending.value.length, 1);
          assert.equal(
            pending.value[0]?.actions.length,
            1,
            "removal-only lifecycle changes must keep a pending recovery proof"
          );
        }
      } finally {
        registry.close();
      }
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const recovered = await recoverInterruptedLifecycle({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          syncMarker: () => {}
        });
        assert.equal(recovered.ok, true);
        assert.equal(
          await readFile(
            join(targetRoot, "app", "SKILL.md"),
            "utf8"
          ).then(
            () => true,
            () => false
          ),
          false
        );
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
        const accepted = registry.readTargetState(targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(accepted.value?.generation, 2);
          assert.deepEqual(
            accepted.value?.resolvedPackages,
            []
          );
        }
      } finally {
        registry.close();
      }
    });
  });
});

test("marker failure leaves post-commit pending authority for an idempotent later recovery", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await createPostCommitInterruption({
      paths,
      targetRoot,
      operationId: "recovery-marker-retry",
      oldDescription: "Marker retry v1.",
      newDescription: "Marker retry v2."
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const failed = await recoverInterruptedLifecycle({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          syncMarker: () => {
            throw new Error("simulated marker failure");
          }
        });
        assert.equal(failed.ok, false);
        if (!failed.ok) {
          assert.equal(
            failed.error.code,
            "LifecycleMarkerSyncFailed"
          );
        }
        assert.match(
          await readFile(
            join(targetRoot, "app", "SKILL.md"),
            "utf8"
          ),
          /Marker retry v2\./u
        );
        const pending = registry.readPendingOperations();
        assert.equal(pending.ok, true);
        if (pending.ok) {
          assert.equal(pending.value.length, 1);
        }
        const accepted = registry.readTargetState(targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(accepted.value?.generation, 2);
        }
      } finally {
        registry.close();
      }
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      let markerCalls = 0;
      try {
        const recovered = await recoverInterruptedLifecycle({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          syncMarker: () => {
            markerCalls += 1;
          }
        });
        assert.equal(recovered.ok, true);
        assert.equal(markerCalls, 1);
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

test("real operation-lock loss during recovered marker handoff leaves pending facts for another safe retry", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withRuntime(async ({ paths, targetRoot }) => {
    await createPostCommitInterruption({
      paths,
      targetRoot,
      operationId: "recovery-lock-loss",
      oldDescription: "Lock retry v1.",
      newDescription: "Lock retry v2."
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const interrupted = await recoverInterruptedLifecycle({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          syncMarker: async () => {
            const pid = lock.helperPid;
            assert.notEqual(pid, undefined);
            process.kill(pid!, "SIGKILL");
            await withTimeout(
              lock.waitForLoss(),
              5_000,
              "recovery operation lock loss"
            );
          }
        });

        assert.equal(interrupted.ok, false);
        if (!interrupted.ok) {
          assert.equal(
            interrupted.error.code,
            "OperationLockLost"
          );
        }
      } finally {
        registry.close();
      }
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const pending = registry.readPendingOperations();
        assert.equal(pending.ok, true);
        if (pending.ok) {
          assert.equal(pending.value.length, 1);
          assert.equal(
            pending.value[0]?.operationId,
            "recovery-lock-loss"
          );
        }

        const recovered = await recoverInterruptedLifecycle({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          syncMarker: () => {}
        });
        assert.equal(recovered.ok, true);
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

async function createPostCommitInterruption(
  input: Readonly<{
    paths: Parameters<typeof install>[0]["paths"];
    targetRoot: string;
    operationId: string;
    oldDescription: string;
    newDescription: string;
  }>
): Promise<void> {
  await withRealLock(input.paths, async (realLock) => {
    const registry = await requireRegistry(input.paths, realLock);
    try {
      await install({
        paths: input.paths,
        targetRoot: input.targetRoot,
        lock: realLock,
        registry,
        fixture: singleAppFixture(
          "v1.0.0",
          "3",
          input.oldDescription
        ),
        requirements: [
          releasePackageRequirement("acme/app/app")
        ]
      });

      const phase = interruptAfterCommitLock(
        realLock,
        input.paths.operationLockPath
      );
      const updateFixture = singleAppFixture(
        "v2.0.0",
        "4",
        input.newDescription
      );
      const interrupted = await updateAcceptedTarget({
        home: input.paths,
        targetId,
        targetRoot: input.targetRoot,
        lock: phase.lock,
        registry: afterSuccessfulReplaceRegistry(
          registry,
          () => phase.interrupt()
        ),
        repositoryTransport:
          updateFixture.repositoryTransport,
        transport: updateFixture.transport,
        acceptCandidate: () => true,
        createOperationId: () => input.operationId,
        syncMarker: () => {}
      });

      assert.equal(interrupted.ok, false);
      if (!interrupted.ok) {
        assert.equal(
          interrupted.error.code,
          "OperationLockLost"
        );
      }
      const accepted = registry.readTargetState(targetId);
      assert.equal(accepted.ok, true);
      if (accepted.ok) {
        assert.equal(accepted.value?.generation, 2);
      }
      assert.match(
        await readFile(
          join(input.targetRoot, "app", "SKILL.md"),
          "utf8"
        ),
        new RegExp(escapeRegExp(input.oldDescription), "u")
      );
      const pending = registry.readPendingOperations();
      assert.equal(pending.ok, true);
      if (pending.ok) {
        assert.equal(pending.value.length, 1);
        assert.equal(
          pending.value[0]?.operationId,
          input.operationId
        );
        assert.equal(pending.value[0]?.baseGeneration, 1);
        assert.equal(pending.value[0]?.nextGeneration, 2);
      }
    } finally {
      registry.close();
    }
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(label + " timed out")),
        timeoutMs
      );
    })
  ]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
