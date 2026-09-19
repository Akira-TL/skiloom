import assert from "node:assert/strict";
import {
  readFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  mergeExactPackage
} from "../../../../../src/runtime/import/merge.js";
import {
  recoverInterruptedExactImport
} from "../../../../../src/runtime/import/recovery/index.js";
import {
  readTargetStateMarkerFile
} from "../../../../../src/runtime/target-state-marker.js";
import {
  afterSuccessfulReplaceRegistry,
  failBeforeCommitRegistry,
  install,
  interruptAfterCommitLock,
  lifecycleFixture,
  requireRegistry,
  targetId,
  withRealLock,
  withRuntime
} from "../../lifecycle/completion-fixture.js";
import {
  releasePackageRequirement
} from "../../lifecycle/github-source-fixture.js";
import {
  dependenciesFixtureBytes,
  fullFixtureBytes,
  writeMarker
} from "./fixture.js";

test("merge pre-commit interruption preserves the old accepted generation and cleans only pending staging", async () => {
  const bytes = await dependenciesFixtureBytes();

  await withExistingTarget(async (ctx) => {
    const interrupted = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: failBeforeCommitRegistry(
        ctx.registry,
        ctx.paths.operationLockPath
      ),
      bytes,
      authorizeMerge: () => true,
      acceptSources: () => true,
      createOperationId: () =>
        "merge-precommit-interruption"
    });
    assert.equal(interrupted.ok, false);
    if (!interrupted.ok) {
      assert.equal(
        interrupted.error.code,
        "OperationLockLost"
      );
    }
    const state = ctx.registry.readTargetState(targetId);
    assert.equal(state.ok, true);
    if (state.ok) {
      assert.equal(state.value?.generation, 1);
    }
    const pending = ctx.registry.readPendingOperations();
    assert.equal(pending.ok, true);
    if (pending.ok) {
      assert.equal(pending.value.length, 1);
      assert.equal(pending.value[0]?.baseGeneration, 1);
      assert.equal(pending.value[0]?.nextGeneration, 2);
    }
  }, async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const recovered = await recoverInterruptedExactImport({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry
        });
        assert.deepEqual(recovered, {
          ok: true,
          value: {
            status: "pre-commit-cleaned",
            targetId,
            operationId:
              "merge-precommit-interruption",
            generation: 1
          }
        });
        const state = registry.readTargetState(targetId);
        assert.equal(state.ok, true);
        if (state.ok) {
          assert.equal(state.value?.generation, 1);
          assert.equal(
            state.value?.resolvedPackages.some(
              (entry) =>
                entry.packageCoordinate === "acme/demo/demo"
            ),
            false
          );
        }
        await assert.rejects(
          readFile(join(targetRoot, "demo", "SKILL.md"))
        );
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

test("merge post-commit interruption recovers the committed exact graph and user payloads without a second generation", async () => {
  const bytes = await fullFixtureBytes();

  await createPostCommitMergeInterruption({
    bytes,
    operationId: "merge-postcommit-interruption",
    after: async ({ paths, targetRoot }) => {
      await withRealLock(paths, async (lock) => {
        const registry = await requireRegistry(paths, lock);
        try {
          const before = registry.readTargetState(targetId);
          assert.equal(before.ok, true);
          if (before.ok) {
            assert.equal(before.value?.generation, 2);
          }

          const recovered = await recoverInterruptedExactImport({
            home: paths,
            targetId,
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
            assert.equal(recovered.value.state.generation, 2);
          }
          const state = registry.readTargetState(targetId);
          assert.equal(state.ok, true);
          if (state.ok) {
            assert.equal(state.value?.generation, 2);
            assert.equal(
              state.value?.projections.find(
                (entry) =>
                  entry.packageCoordinate === "acme/demo/demo"
              )?.ownership,
              "detached"
            );
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
            assert.equal(marker.value?.generation, 2);
          }
          assert.deepEqual(
            registry.readPendingOperations(),
            { ok: true, value: [] }
          );
        } finally {
          registry.close();
        }
      });
    }
  });
});

test("merge marker failure leaves pending proof for later exact-import recovery", async () => {
  const bytes = await fullFixtureBytes();

  await withExistingTarget(async (ctx) => {
    const failed = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: ctx.registry,
      bytes,
      authorizeMerge: () => true,
      acceptSources: () => true,
      createOperationId: () => "merge-marker-retry",
      syncMarker: () => {
        throw new Error("simulated merge marker failure");
      }
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(
        failed.error.code,
        "LifecycleMarkerSyncFailed"
      );
    }
    const state = ctx.registry.readTargetState(targetId);
    assert.equal(state.ok, true);
    if (state.ok) {
      assert.equal(state.value?.generation, 2);
    }
    const pending = ctx.registry.readPendingOperations();
    assert.equal(pending.ok, true);
    if (pending.ok) {
      assert.equal(pending.value.length, 1);
    }
  }, async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const recovered = await recoverInterruptedExactImport({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry
        });
        assert.equal(recovered.ok, true);
        assert.deepEqual(
          registry.readPendingOperations(),
          { ok: true, value: [] }
        );
        const state = registry.readTargetState(targetId);
        assert.equal(state.ok, true);
        if (state.ok) {
          assert.equal(state.value?.generation, 2);
        }
      } finally {
        registry.close();
      }
    });
  });
});

test("real lock loss during merge recovery leaves the same pending authority for another session", async () => {
  if (process.platform === "win32") {
    return;
  }
  const bytes = await fullFixtureBytes();

  await createPostCommitMergeInterruption({
    bytes,
    operationId: "merge-recovery-lock-loss",
    after: async ({ paths, targetRoot }) => {
      await withRealLock(paths, async (lock) => {
        const registry = await requireRegistry(paths, lock);
        try {
          const interrupted = await recoverInterruptedExactImport({
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
                "merge recovery lock loss"
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
            targetId,
            targetRoot,
            lock,
            registry
          });
          assert.equal(recovered.ok, true);
          const state = registry.readTargetState(targetId);
          assert.equal(state.ok, true);
          if (state.ok) {
            assert.equal(state.value?.generation, 2);
          }
          assert.deepEqual(
            registry.readPendingOperations(),
            { ok: true, value: [] }
          );
        } finally {
          registry.close();
        }
      });
    }
  });
});

type ExistingContext = Readonly<{
  paths: Parameters<typeof install>[0]["paths"];
  targetRoot: string;
  lock: Parameters<typeof install>[0]["lock"];
  registry: Parameters<typeof install>[0]["registry"];
}>;

async function withExistingTarget(
  run: (context: ExistingContext) => Promise<void>,
  after?: (input: Readonly<{
    paths: ExistingContext["paths"];
    targetRoot: string;
  }>) => Promise<void>
): Promise<void> {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: lifecycleFixture("v1.0.0"),
          requirements: [
            releasePackageRequirement(
              "acme/app/app",
              "^1.0.0"
            )
          ]
        });
        await writeMarker(targetRoot, initial);
        await run({
          paths,
          targetRoot,
          lock,
          registry
        });
      } finally {
        registry.close();
      }
    });
    if (after !== undefined) {
      await after({ paths, targetRoot });
    }
  });
}

async function createPostCommitMergeInterruption(
  input: Readonly<{
    bytes: Uint8Array;
    operationId: string;
    after: (input: Readonly<{
      paths: ExistingContext["paths"];
      targetRoot: string;
    }>) => Promise<void>;
  }>
): Promise<void> {
  await withExistingTarget(
    async (ctx) => {
      const phase = interruptAfterCommitLock(
        ctx.lock,
        ctx.paths.operationLockPath
      );
      const interrupted = await mergeExactPackage({
        home: ctx.paths,
        targetId,
        targetRoot: ctx.targetRoot,
        lock: phase.lock,
        registry: afterSuccessfulReplaceRegistry(
          ctx.registry,
          () => phase.interrupt()
        ),
        bytes: input.bytes,
        authorizeMerge: () => true,
        acceptSources: () => true,
        createOperationId: () => input.operationId
      });
      assert.equal(interrupted.ok, false);
      if (!interrupted.ok) {
        assert.equal(
          interrupted.error.code,
          "OperationLockLost"
        );
      }
      const state = ctx.registry.readTargetState(targetId);
      assert.equal(state.ok, true);
      if (state.ok) {
        assert.equal(state.value?.generation, 2);
      }
      const pending = ctx.registry.readPendingOperations();
      assert.equal(pending.ok, true);
      if (pending.ok) {
        assert.equal(pending.value.length, 1);
      }
    },
    input.after
  );
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
