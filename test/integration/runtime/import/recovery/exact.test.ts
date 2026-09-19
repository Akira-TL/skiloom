import assert from "node:assert/strict";
import {
  readFile,
  readdir
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  importExactPackage
} from "../../../../../src/runtime/import/exact.js";
import {
  recoverInterruptedExactImport
} from "../../../../../src/runtime/import/recovery/index.js";
import {
  readTargetStateMarkerFile
} from "../../../../../src/runtime/target-state-marker.js";
import {
  afterSuccessfulReplaceRegistry,
  failBeforeCommitRegistry,
  interruptAfterCommitLock,
  requireRegistry,
  withRealLock,
  withRuntime
} from "../../lifecycle/completion-fixture.js";
import {
  dependenciesFixtureBytes,
  fullFixtureBytes
} from "./fixture.js";

const preCommitTargetId =
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const postCommitTargetId =
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const markerRetryTargetId =
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const lockRetryTargetId =
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("fresh exact import pre-commit interruption cleans only pending staging and removes the generation-zero shell", async () => {
  const bytes = await dependenciesFixtureBytes();

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const interrupted = await importExactPackage({
          home: paths,
          targetRoot,
          lock,
          registry: failBeforeCommitRegistry(
            registry,
            paths.operationLockPath
          ),
          bytes,
          acceptSources: () => true,
          createTargetId: () => preCommitTargetId,
          createOperationId: () =>
            "exact-precommit-interruption"
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
            0
          );
          assert.equal(
            pending.value[0]?.nextGeneration,
            1
          );
        }
        const shell = registry.readTargetState(preCommitTargetId);
        assert.equal(shell.ok, true);
        if (shell.ok) {
          assert.equal(shell.value?.generation, 0);
        }
      } finally {
        registry.close();
      }
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const recovered = await recoverInterruptedExactImport({
          home: paths,
          targetId: preCommitTargetId,
          targetRoot,
          lock,
          registry
        });
        assert.deepEqual(recovered, {
          ok: true,
          value: {
            status: "pre-commit-cleaned",
            targetId: preCommitTargetId,
            operationId:
              "exact-precommit-interruption",
            generation: 0
          }
        });
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
        assert.deepEqual(
          registry.readTargetState(preCommitTargetId),
          { ok: true, value: undefined }
        );
        assert.deepEqual(
          (await readdir(targetRoot)).filter((entry) =>
            entry.startsWith(".skiloom-stage-")
          ),
          []
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("fresh exact import post-commit interruption recovers managed and user payloads from accepted DB authority without another generation", async () => {
  const bytes = await fullFixtureBytes();

  await withRuntime(async ({ paths, targetRoot }) => {
    await createPostCommitInterruption({
      paths,
      targetRoot,
      bytes,
      targetId: postCommitTargetId,
      operationId: "exact-postcommit-interruption"
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const before = registry.readTargetState(postCommitTargetId);
        assert.equal(before.ok, true);
        if (before.ok) {
          assert.equal(before.value?.generation, 1);
        }

        const recovered = await recoverInterruptedExactImport({
          home: paths,
          targetId: postCommitTargetId,
          targetRoot,
          lock,
          registry
        });
        assert.equal(recovered.ok, true);
        if (
          recovered.ok &&
          recovered.value.status ===
            "post-commit-recovered"
        ) {
          assert.equal(recovered.value.state.generation, 1);
        }
        assert.match(
          await readFile(
            join(targetRoot, "demo", "USER-NOTE"),
            "utf8"
          ),
          /recovery-detached-note/u
        );
        assert.match(
          await readFile(
            join(targetRoot, "local", "SKILL.md"),
            "utf8"
          ),
          /recovery manual bytes/u
        );
        const marker = await readTargetStateMarkerFile(targetRoot);
        assert.equal(marker.ok, true);
        if (marker.ok) {
          assert.equal(marker.value?.generation, 1);
          assert.equal(marker.value?.targetId, postCommitTargetId);
        }
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );

        const repeated = await recoverInterruptedExactImport({
          home: paths,
          targetId: postCommitTargetId,
          targetRoot,
          lock,
          registry
        });
        assert.deepEqual(repeated, {
          ok: true,
          value: {
            status: "no-pending",
            targetId: postCommitTargetId
          }
        });
      } finally {
        registry.close();
      }
    });
  });
});

test("marker failure after exact import leaves pending proof and later recovery completes idempotently", async () => {
  const bytes = await fullFixtureBytes();

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const failed = await importExactPackage({
          home: paths,
          targetRoot,
          lock,
          registry,
          bytes,
          acceptSources: () => true,
          createTargetId: () => markerRetryTargetId,
          createOperationId: () => "exact-marker-retry",
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
        const pending = registry.readPendingOperations();
        assert.equal(pending.ok, true);
        if (pending.ok) {
          assert.equal(pending.value.length, 1);
        }
        const accepted = registry.readTargetState(markerRetryTargetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(accepted.value?.generation, 1);
        }
      } finally {
        registry.close();
      }
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const recovered = await recoverInterruptedExactImport({
          home: paths,
          targetId: markerRetryTargetId,
          targetRoot,
          lock,
          registry
        });
        assert.equal(recovered.ok, true);
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
        assert.match(
          await readFile(
            join(targetRoot, "demo", "USER-NOTE"),
            "utf8"
          ),
          /recovery-detached-note/u
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("real lock loss during exact import recovery leaves pending authority for another fresh-session retry", async () => {
  if (process.platform === "win32") {
    return;
  }
  const bytes = await fullFixtureBytes();

  await withRuntime(async ({ paths, targetRoot }) => {
    await createPostCommitInterruption({
      paths,
      targetRoot,
      bytes,
      targetId: lockRetryTargetId,
      operationId: "exact-recovery-lock-loss"
    });

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const interrupted = await recoverInterruptedExactImport({
          home: paths,
          targetId: lockRetryTargetId,
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
              "exact import recovery lock loss"
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
        }
        const recovered = await recoverInterruptedExactImport({
          home: paths,
          targetId: lockRetryTargetId,
          targetRoot,
          lock,
          registry
        });
        assert.equal(recovered.ok, true);
        const accepted = registry.readTargetState(lockRetryTargetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(accepted.value?.generation, 1);
        }
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
      } finally {
        registry.close();
      }
    });
  });
});

async function createPostCommitInterruption(
  input: Readonly<{
    paths: Parameters<typeof requireRegistry>[0];
    targetRoot: string;
    bytes: Uint8Array;
    targetId: string;
    operationId: string;
  }>
): Promise<void> {
  await withRealLock(input.paths, async (realLock) => {
    const registry = await requireRegistry(
      input.paths,
      realLock
    );
    try {
      const phase = interruptAfterCommitLock(
        realLock,
        input.paths.operationLockPath
      );
      const interrupted = await importExactPackage({
        home: input.paths,
        targetRoot: input.targetRoot,
        lock: phase.lock,
        registry: afterSuccessfulReplaceRegistry(
          registry,
          () => phase.interrupt()
        ),
        bytes: input.bytes,
        acceptSources: () => true,
        createTargetId: () => input.targetId,
        createOperationId: () => input.operationId
      });
      assert.equal(interrupted.ok, false);
      if (!interrupted.ok) {
        assert.equal(
          interrupted.error.code,
          "OperationLockLost"
        );
      }
      const state = registry.readTargetState(input.targetId);
      assert.equal(state.ok, true);
      if (state.ok) {
        assert.equal(state.value?.generation, 1);
      }
      const pending = registry.readPendingOperations();
      assert.equal(pending.ok, true);
      if (pending.ok) {
        assert.equal(pending.value.length, 1);
        assert.equal(
          pending.value[0]?.operationId,
          input.operationId
        );
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
