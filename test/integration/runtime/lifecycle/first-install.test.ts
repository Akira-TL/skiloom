import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  acquireOperationLock,
  type OperationLockSession
} from "../../../../src/native/skiloom-lock.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../../../../src/runtime/home.js";
import {
  addAcceptedTargetRoots
} from "../../../../src/runtime/orchestration/lifecycle/add-root.js";
import {
  executeFirstAcceptedInstall
} from "../../../../src/runtime/orchestration/lifecycle/first-install.js";
import {
  openMachineRegistry,
  type MachineRegistry
} from "../../../../src/runtime/registry/index.js";
import {
  readTargetStateMarkerFile
} from "../../../../src/runtime/target-state-marker.js";
import {
  release,
  releasePackageRequirement,
  releaseRepository,
  skillPackage,
  sourceFixture
} from "./github-source-fixture.js";

const helperExecutable = requiredHelperExecutable();
const targetId = "22222222-2222-4222-8222-222222222222";

test("accepted first install publishes Store before DB authority and materializes Target before marker handoff", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      const events: string[] = [];
      const registry = observeRegistry(opened.value, () => {
        assert.equal(existsSync(paths.storePath), true);
        assert.equal(readdirSync(paths.storePath).length, 2);
        assert.equal(
          existsSync(join(targetRoot, "app")),
          false,
          "live activation must not exist after Registry commit but before reconciliation"
        );
        assert.equal(
          existsSync(join(targetRoot, "lib")),
          false,
          "transitive activation must not exist after Registry commit but before reconciliation"
        );
        events.push("registry-commit");
      });
      const fixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "1", [
            skillPackage(
              ".",
              "app",
              "Installed application.",
              { "acme/lib/lib": "^1.0.0" }
            )
          ])
        ]),
        releaseRepository("acme/lib", [
          release("v1.0.0", "5", [
            skillPackage(".", "lib", "Installed library.")
          ])
        ])
      ]);

      try {
        const result = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry,
          directRequirements: [
            releasePackageRequirement("acme/app/app", "^1.0.0")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createTargetId: () => targetId,
          createOperationId: () => "install-op-success",
          syncMarker: async (facts) => {
            const accepted = registry.readTargetState(targetId);
            assert.equal(accepted.ok, true);
            assert.equal(accepted.ok ? accepted.value?.generation : null, 1);
            assert.equal(existsSync(join(targetRoot, "app")), true);
            assert.equal(existsSync(join(targetRoot, "lib")), true);
            events.push("marker-sync");
            assert.deepEqual(facts, {
              targetId,
              generation: 1,
              requirements: [
                {
                  kind: "package",
                  coordinate: "acme/app/app",
                  sourceKind: "github-release",
                  versionRequirement: "^1.0.0"
                }
              ],
              projectionOverrides: [],
              detached: []
            });
          }
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "installed") {
          return;
        }
        assert.equal(result.value.state.generation, 1);
        assert.deepEqual(events, ["registry-commit", "marker-sync"]);

        const skill = await readFile(
          join(targetRoot, "app", "SKILL.md"),
          "utf8"
        );
        assert.match(skill, /name: app/u);

        const activation = await lstat(join(targetRoot, "app"));
        if (process.platform === "win32") {
          assert.equal(activation.isSymbolicLink(), true);
        } else {
          assert.equal(activation.isSymbolicLink(), true);
        }

        const accepted = registry.readTargetState(targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.equal(accepted.value?.resolvedPackages.length, 2);
          assert.deepEqual(
            accepted.value?.resolvedPackages.map(
              (entry) => entry.packageCoordinate
            ),
            ["acme/app/app", "acme/lib/lib"]
          );
          assert.equal(
            accepted.value?.projections[0]?.materialization,
            process.platform === "win32" ? "junction" : "symlink"
          );
        }
      } finally {
        opened.value.close();
      }
    });
  });
});

test("first install persists the canonical public marker by default", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      const fixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "9", [
            skillPackage(".", "app", "Default marker application.")
          ])
        ])
      ]);

      try {
        const result = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry: opened.value,
          directRequirements: [
            releasePackageRequirement("acme/app/app", "^1.0.0")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createTargetId: () => targetId,
          createOperationId: () => "install-default-marker"
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "installed") {
          return;
        }
        assert.deepEqual(
          await readTargetStateMarkerFile(targetRoot),
          {
            ok: true,
            value: {
              targetId,
              generation: 1,
              requirements: [
                {
                  kind: "package",
                  coordinate: "acme/app/app",
                  sourceKind: "github-release",
                  versionRequirement: "^1.0.0"
                }
              ],
              projectionOverrides: [],
              detached: []
            }
          }
        );
      } finally {
        opened.value.close();
      }
    });
  });
});

test("first install applies an explicit requested activation rename without changing Package identity", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      const fixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "a", [
            skillPackage(".", "app", "Renamed application.")
          ])
        ])
      ]);
      const renameInput = {
        requestedProjectionRename: {
          packageCoordinate: "acme/app/app",
          activationName: "app-local"
        }
      };

      try {
        const result = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry: opened.value,
          directRequirements: [
            releasePackageRequirement("acme/app/app")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createTargetId: () => targetId,
          createOperationId: () => "install-requested-rename",
          syncMarker: () => {},
          ...renameInput
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "installed") {
          return;
        }
        assert.equal(existsSync(join(targetRoot, "app")), false);
        assert.equal(existsSync(join(targetRoot, "app-local")), true);
        assert.match(
          await readFile(join(targetRoot, "app-local", "SKILL.md"), "utf8"),
          /name: app-local/u
        );
        assert.deepEqual(result.value.state.projections, [
          {
            packageCoordinate: "acme/app/app",
            activationName: "app-local",
            ownership: "managed",
            materialization: "copy",
            transformJson: JSON.stringify({
              rename: {
                fromActivationName: "app",
                toActivationName: "app-local"
              },
              dependencyRoutes: []
            })
          }
        ]);
        assert.deepEqual(result.value.marker.projectionOverrides, [
          {
            packageCoordinate: "acme/app/app",
            activationName: "app-local"
          }
        ]);
        assert.equal(
          result.value.state.resolvedPackages[0]?.packageCoordinate,
          "acme/app/app"
        );
      } finally {
        opened.value.close();
      }
    });
  });
});

test("reinstall applies a requested activation rename even when resolver state is otherwise unchanged", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      const fixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "b", [
            skillPackage(".", "app", "Reinstall rename application.")
          ])
        ])
      ]);

      try {
        const installed = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry: opened.value,
          directRequirements: [releasePackageRequirement("acme/app/app")],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createTargetId: () => targetId,
          createOperationId: () => "install-before-reinstall-rename",
          syncMarker: () => {}
        });
        assert.equal(installed.ok, true);
        if (!installed.ok || installed.value.status !== "installed") {
          return;
        }

        let acceptanceCalls = 0;
        const renameInput = {
          requestedProjectionRename: {
            packageCoordinate: "acme/app/app",
            activationName: "app-local"
          }
        };
        const result = await addAcceptedTargetRoots({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry: opened.value,
          additions: [releasePackageRequirement("acme/app/app")],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => {
            acceptanceCalls += 1;
            return true;
          },
          createOperationId: () => "reinstall-requested-rename",
          syncMarker: () => {},
          ...renameInput
        });

        assert.equal(result.ok, true);
        if (!result.ok) {
          return;
        }
        assert.equal(result.value.status, "applied");
        if (result.value.status !== "applied") {
          return;
        }
        assert.equal(acceptanceCalls, 1);
        assert.equal(result.value.state.generation, 2);
        assert.equal(existsSync(join(targetRoot, "app")), false);
        assert.equal(existsSync(join(targetRoot, "app-local")), true);
        assert.equal(
          result.value.state.projections[0]?.packageCoordinate,
          "acme/app/app"
        );
        assert.equal(
          result.value.state.projections[0]?.activationName,
          "app-local"
        );
        assert.deepEqual(result.value.marker.projectionOverrides, [
          {
            packageCoordinate: "acme/app/app",
            activationName: "app-local"
          }
        ]);
      } finally {
        opened.value.close();
      }
    });
  });
});

test("plan validates requested rename against the complete Target projection before acceptance", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      const fixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "c", [
            skillPackage(
              ".",
              "app",
              "Conflicting rename application.",
              { "acme/lib/lib": "^1.0.0" }
            )
          ])
        ]),
        releaseRepository("acme/lib", [
          release("v1.0.0", "d", [
            skillPackage(".", "lib", "Conflicting rename library.")
          ])
        ])
      ]);
      let acceptanceCalls = 0;

      try {
        const result = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry: opened.value,
          directRequirements: [
            releasePackageRequirement("acme/app/app")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          requestedProjectionRename: {
            packageCoordinate: "acme/app/app",
            activationName: "lib"
          },
          acceptCandidate: () => {
            acceptanceCalls += 1;
            return { kind: "plan" } as const;
          },
          createTargetId: () => targetId,
          syncMarker: () => {}
        });

        assert.equal(result.ok, false);
        if (result.ok) {
          return;
        }
        assert.equal(result.error.code, "ActivationNameConflict");
        assert.equal(acceptanceCalls, 0);
        assert.equal(existsSync(join(targetRoot, "app")), false);
        assert.equal(existsSync(join(targetRoot, "lib")), false);
      } finally {
        opened.value.close();
      }
    });
  });
});

test("declined first install performs no Store publication Registry replacement Target mutation or marker handoff", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      const fixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "2", [
            skillPackage(".", "app", "Declined application.")
          ])
        ])
      ]);
      let markerCalls = 0;

      try {
        const result = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry: opened.value,
          directRequirements: [
            releasePackageRequirement("acme/app/app")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => false,
          createTargetId: () => targetId,
          createOperationId: () => "install-op-declined",
          syncMarker: () => {
            markerCalls += 1;
          }
        });

        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.status, "declined");
        }
        assert.equal(markerCalls, 0);
        assert.equal(existsSync(paths.storePath), false);
        assert.equal(existsSync(join(targetRoot, "app")), false);
        const state = opened.value.readTargetState(targetId);
        assert.deepEqual(state, { ok: true, value: undefined });
      } finally {
        opened.value.close();
      }
    });
  });
});

test("foreign Target path fails preflight without adoption overwrite Store publication or Registry state", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const foreign = join(targetRoot, "app");
    await mkdir(foreign);
    await writeFile(join(foreign, "KEEP"), "foreign bytes\n");

    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      const fixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "3", [
            skillPackage(".", "app", "Collision application.")
          ])
        ])
      ]);
      let markerCalls = 0;

      try {
        const result = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry: opened.value,
          directRequirements: [
            releasePackageRequirement("acme/app/app")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createTargetId: () => targetId,
          createOperationId: () => "install-op-foreign",
          syncMarker: () => {
            markerCalls += 1;
          }
        });

        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.deepEqual(result.error, {
            code: "ForeignTargetPathConflict",
            facts: {
              activationName: "app",
              desiredPackageCoordinate: "acme/app/app"
            }
          });
        }
        assert.equal(markerCalls, 0);
        assert.equal(existsSync(paths.storePath), false);
        assert.equal(
          await readFile(join(foreign, "KEEP"), "utf8"),
          "foreign bytes\n"
        );
        assert.deepEqual(
          opened.value.readTargetState(targetId),
          { ok: true, value: undefined }
        );
      } finally {
        opened.value.close();
      }
    });
  });
});

test("lock loss after acceptance stops protected install side effects without reacquiring", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      const fixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "4", [
            skillPackage(".", "app", "Lock loss application.")
          ])
        ])
      ]);
      let markerCalls = 0;

      try {
        const result = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry: opened.value,
          directRequirements: [
            releasePackageRequirement("acme/app/app")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: async () => {
            const pid = lock.helperPid;
            assert.notEqual(pid, undefined);
            process.kill(pid!, "SIGKILL");
            await withTimeout(
              lock.waitForLoss(),
              5_000,
              "first install lock loss"
            );
            return true;
          },
          createTargetId: () => targetId,
          createOperationId: () => "install-op-lock-loss",
          syncMarker: () => {
            markerCalls += 1;
          }
        });

        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error.code, "OperationLockLost");
        }
        assert.equal(markerCalls, 0);
        assert.equal(existsSync(paths.storePath), false);
        assert.equal(existsSync(join(targetRoot, "app")), false);

        const rawState = opened.value.readTargetState(targetId);
        assert.equal(rawState.ok, false);
        if (!rawState.ok) {
          assert.equal(rawState.error.code, "OperationLockLost");
        }
      } finally {
        opened.value.close();
      }
    });
  });
});

function observeRegistry(
  registry: MachineRegistry,
  afterReplace: () => void
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
        afterReplace();
      }
      return replaced;
    }
  };
}

async function withRuntime(
  run: (input: Readonly<{
    paths: SkiloomHomePaths;
    targetRoot: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skiloom-first-install-"));
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out`)),
        timeoutMs
      );
    })
  ]);
}
