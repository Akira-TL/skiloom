import assert from "node:assert/strict";
import { lstat, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  detachAcceptedProjection,
  renameAcceptedProjection,
  restoreAcceptedProjection
} from "../../../../src/runtime/orchestration/local-projection/operations.js";
import {
  afterSuccessfulReplaceRegistry,
  failBeforeCommitRegistry,
  install,
  interruptAfterCommitLock,
  lifecycleFixture,
  requireRegistry,
  singleAppFixture,
  targetId,
  withRealLock,
  withRuntime
} from "../lifecycle/completion-fixture.js";
import { releasePackageRequirement } from "../lifecycle/github-source-fixture.js";

test("restore preserves exact sources, dependencies and other managed projections without resolution", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const initial = await install({
          paths, targetRoot, lock, registry, fixture: lifecycleFixture("v1.0.0"),
          requirements: [releasePackageRequirement("acme/app/app"), releasePackageRequirement("acme/tool/tool")]
        });
        const otherPath = await realpath(join(targetRoot, "tool"));
        const base = { home: paths, targetId, targetRoot, lock, registry, packageCoordinate: "acme/app/app" };
        assert.equal((await detachAcceptedProjection(base)).ok, true);
        assert.equal((await lstat(join(targetRoot, "app"))).isSymbolicLink(), false);
        const result = await restoreAcceptedProjection(base);
        assert.equal(result.ok, true, JSON.stringify(result));
        if (!result.ok) return;
        assert.equal(result.value.status, "restored");
        const restored = result.value.state;
        assert.deepEqual(restored.resolvedSources, initial.resolvedSources);
        assert.deepEqual(restored.resolvedPackages, initial.resolvedPackages);
        assert.deepEqual(restored.dependencyEdges, initial.dependencyEdges);
        assert.deepEqual(restored.directRequirements, initial.directRequirements);
        assert.deepEqual(restored.dependencyObservations, initial.dependencyObservations);
        assert.deepEqual(restored.projections, initial.projections);
        assert.deepEqual(restored.detachedBaselines, []);
        assert.equal(await realpath(join(targetRoot, "tool")), otherPath);
        assert.deepEqual(registry.readPendingOperations(), { ok: true, value: [] });
      } finally { registry.close(); }
    });
  });
});

test("restore preserves renamed managed-copy bytes and transform", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        await install({ paths, targetRoot, lock, registry,
          fixture: singleAppFixture("v1.0.0", "1", "Original."),
          requirements: [releasePackageRequirement("acme/app/app")] });
        const base = { home: paths, targetId, targetRoot, lock, registry, packageCoordinate: "acme/app/app" };
        assert.equal((await renameAcceptedProjection({ ...base, activationName: "custom-app" })).ok, true);
        const original = await readFile(join(targetRoot, "custom-app", "SKILL.md"));
        assert.equal((await detachAcceptedProjection(base)).ok, true);
        const result = await restoreAcceptedProjection(base);
        assert.equal(result.ok, true, JSON.stringify(result));
        if (!result.ok) return;
        assert.equal(result.value.state.projections[0]?.ownership, "managed");
        assert.equal(result.value.state.projections[0]?.materialization, "copy");
        assert.equal(result.value.state.projections[0]?.activationName, "custom-app");
        assert.deepEqual(await readFile(join(targetRoot, "custom-app", "SKILL.md")), original);
      } finally { registry.close(); }
    });
  });
});

test("restore retains a Git source exact commit and requested ref", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const initial = await install({ paths, targetRoot, lock, registry,
          fixture: singleAppFixture("v1.0.0", "1", "Original."),
          requirements: [releasePackageRequirement("acme/app/app")] });
        const source = {
          repositoryCoordinate: "acme/app", sourceKind: "git" as const,
          requestedRef: "main", exactCommit: "1111111111111111111111111111111111111111"
        };
        assert.equal(registry.replaceTargetState({ ...initial,
          directRequirements: [{ kind: "package", coordinate: "acme/app/app",
            sourceKind: "git", requestedRef: "main" }],
          resolvedSources: [source]
        }).ok, true);
        const base = { home: paths, targetId, targetRoot, lock, registry, packageCoordinate: "acme/app/app" };
        assert.equal((await detachAcceptedProjection(base)).ok, true);
        const restored = await restoreAcceptedProjection(base);
        assert.equal(restored.ok, true, JSON.stringify(restored));
        if (restored.ok) assert.deepEqual(restored.value.state.resolvedSources, [source]);
      } finally { registry.close(); }
    });
  });
});

for (const failure of ["modified", "missing", "foreign-link", "changed-source", "corrupt-store"] as const) {
  test(`restore rejects ${failure} before accepting state and preserves local content`, async () => {
    await withRuntime(async ({ paths, targetRoot }) => {
      await withRealLock(paths, async (lock) => {
        const registry = await requireRegistry(paths, lock);
        try {
          const initial = await install({ paths, targetRoot, lock, registry,
            fixture: singleAppFixture("v1.0.0", "1", "Original."),
            requirements: [releasePackageRequirement("acme/app/app")] });
          const base = { home: paths, targetId, targetRoot, lock, registry, packageCoordinate: "acme/app/app" };
          const detached = await detachAcceptedProjection(base);
          assert.equal(detached.ok, true);
          if (!detached.ok) return;
          const skill = join(targetRoot, "app", "SKILL.md");
          const original = await readFile(skill);
          if (failure === "modified") await writeFile(skill, "User modification.\n");
          if (failure === "missing" || failure === "foreign-link") {
            await rm(join(targetRoot, "app"), { recursive: true });
          }
          if (failure === "foreign-link") await symlink(targetRoot, join(targetRoot, "app"), "dir");
          if (failure === "changed-source") {
            const changed = registry.replaceTargetState({
              ...detached.value.state,
              resolvedSources: detached.value.state.resolvedSources.map((entry) => ({
                ...entry, exactCommit: "2222222222222222222222222222222222222222"
              }))
            });
            assert.equal(changed.ok, true);
          }
          if (failure === "corrupt-store") {
            const storePath = await realpath(join(paths.storePath,
              initial.resolvedPackages[0]!.contentDigest.replace(":", "-"), "payload"));
            await writeFile(join(storePath, "SKILL.md"), "Corrupt.\n");
          }
          const before = registry.readTargetState(targetId);
          const result = await restoreAcceptedProjection(base);
          assert.equal(result.ok, false, JSON.stringify(result));
          assert.deepEqual(registry.readTargetState(targetId), before);
          assert.deepEqual(registry.readPendingOperations(), { ok: true, value: [] });
          if (failure === "modified") assert.equal(await readFile(skill, "utf8"), "User modification.\n");
          if (failure === "changed-source" || failure === "corrupt-store") {
            assert.deepEqual(await readFile(skill), original);
          }
          if (failure === "foreign-link") assert.equal((await lstat(join(targetRoot, "app"))).isSymbolicLink(), true);
        } finally { registry.close(); }
      });
    });
  });
}

for (const phase of ["before-commit", "after-commit", "after-commit-drift"] as const) {
  test(`restore safely retries interruption ${phase}`, async () => {
    await withRuntime(async ({ paths, targetRoot }) => {
      await withRealLock(paths, async (lock) => {
        const registry = await requireRegistry(paths, lock);
        try {
          await install({ paths, targetRoot, lock, registry,
            fixture: singleAppFixture("v1.0.0", "1", "Original."),
            requirements: [releasePackageRequirement("acme/app/app")] });
          const base = { home: paths, targetId, targetRoot, lock, registry, packageCoordinate: "acme/app/app" };
          assert.equal((await detachAcceptedProjection(base)).ok, true);
          const interruptedLock = interruptAfterCommitLock(lock, paths.operationLockPath);
          const interrupted = await restoreAcceptedProjection({
            ...base,
            lock: phase === "before-commit" ? lock : interruptedLock.lock,
            registry: phase === "before-commit" ? failBeforeCommitRegistry(registry, paths.operationLockPath)
              : afterSuccessfulReplaceRegistry(registry, interruptedLock.interrupt)
          });
          assert.equal(interrupted.ok, false);
          const skill = join(targetRoot, "app", "SKILL.md");
          if (phase === "after-commit-drift") await writeFile(skill, "Keep new user content.\n");
          const retried = await restoreAcceptedProjection(base);
          assert.equal(retried.ok, phase !== "after-commit-drift", JSON.stringify(retried));
          if (retried.ok) {
            assert.equal(retried.value.state.projections[0]?.ownership, "managed");
            assert.deepEqual(registry.readPendingOperations(), { ok: true, value: [] });
          } else {
            assert.equal(await readFile(skill, "utf8"), "Keep new user content.\n");
          }
        } finally { registry.close(); }
      });
    });
  });
}
