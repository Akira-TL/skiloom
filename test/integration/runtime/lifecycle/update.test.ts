import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync
} from "node:fs";
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
  updateAcceptedTarget
} from "../../../../src/runtime/orchestration/lifecycle/update.js";
import {
  openMachineRegistry,
  type MachineRegistry,
  type RegistryTargetState
} from "../../../../src/runtime/registry/index.js";
import {
  release,
  releasePackageRequirement,
  releaseRepository,
  skillPackage,
  sourceFixture
} from "./github-source-fixture.js";

const helperExecutable = requiredHelperExecutable();
const targetId = "44444444-4444-4444-8444-444444444444";

test("whole-target update replaces transitive repositories and commits DB authority before live Target", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const initialFixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "1", [
            skillPackage(
              ".",
              "app",
              "Application v1.",
              { "acme/shared/shared": "^1.0.0" }
            )
          ])
        ]),
        releaseRepository("acme/shared", [
          release("v1.0.0", "2", [
            skillPackage(".", "shared", "Shared v1.")
          ])
        ])
      ]);
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
        assert.equal(initial.generation, 1);

        const updateFixture = sourceFixture([
          releaseRepository("acme/app", [
            release("v2.0.0", "3", [
              skillPackage(
                ".",
                "app",
                "Application v2.",
                { "acme/new/new": "^1.0.0" }
              )
            ])
          ]),
          releaseRepository("acme/new", [
            release("v1.0.0", "4", [
              skillPackage(".", "new", "New dependency.")
            ])
          ])
        ]);

        const observedRegistry = observeRegistry(
          registry,
          (state) => {
            assert.equal(state.generation, 2);
            assert.match(
              readUtf8Sync(join(targetRoot, "app", "SKILL.md")),
              /Application v1\./u,
              "live app must still be old immediately after DB commit"
            );
            assert.equal(
              existsSync(join(targetRoot, "shared")),
              true
            );
            assert.equal(
              existsSync(join(targetRoot, "new")),
              false
            );
          }
        );
        let markerCalls = 0;

        const result = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry: observedRegistry,
          repositoryTransport:
            updateFixture.repositoryTransport,
          transport: updateFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "whole-target-update",
          syncMarker: (marker) => {
            markerCalls += 1;
            assert.equal(marker.generation, 2);
            assert.match(
              readUtf8Sync(join(targetRoot, "app", "SKILL.md")),
              /Application v2\./u
            );
            assert.equal(
              existsSync(join(targetRoot, "shared")),
              false
            );
            assert.equal(
              existsSync(join(targetRoot, "new")),
              true
            );
          }
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "updated") {
          return;
        }
        assert.equal(markerCalls, 1);
        assert.equal(result.value.state.generation, 2);
        assert.equal(
          result.value.plan.candidate.sourceBindings.find(
            (entry) =>
              entry.repositoryCoordinate === "acme/app"
          )?.sourceKind,
          "github-release"
        );
        const appSource =
          result.value.plan.candidate.sourceBindings.find(
            (entry) =>
              entry.repositoryCoordinate === "acme/app"
          );
        assert.equal(
          appSource?.sourceKind === "github-release"
            ? appSource.version
            : undefined,
          "2.0.0"
        );
        assert.equal(
          result.value.plan.comparison.sourceDeltas.some(
            (delta) =>
              delta.kind === "repository-removed" &&
              delta.repositoryCoordinate === "acme/shared"
          ),
          true
        );
        assert.equal(
          result.value.plan.comparison.sourceDeltas.some(
            (delta) =>
              delta.kind === "repository-added" &&
              delta.repositoryCoordinate === "acme/new"
          ),
          true
        );
        assert.equal(
          result.value.plan.comparison.packageDeltas.some(
            (delta) =>
              delta.kind === "package-removed" &&
              delta.packageCoordinate === "acme/shared/shared"
          ),
          true
        );
        assert.equal(
          result.value.plan.comparison.packageDeltas.some(
            (delta) =>
              delta.kind === "package-added" &&
              delta.packageCoordinate === "acme/new/new"
          ),
          true
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("update has no package-scoped path and re-resolves every accepted direct root", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const initialFixture = sourceFixture([
        releaseRepository("acme/app", [
          release("v1.0.0", "5", [
            skillPackage(".", "app", "App v1.")
          ])
        ]),
        releaseRepository("acme/tool", [
          release("v1.0.0", "6", [
            skillPackage(".", "tool", "Tool v1.")
          ])
        ])
      ]);
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: initialFixture,
          requirements: [
            releasePackageRequirement("acme/app/app"),
            releasePackageRequirement("acme/tool/tool")
          ]
        });
        assert.equal(initial.generation, 1);

        const updateFixture = sourceFixture([
          releaseRepository("acme/app", [
            release("v2.0.0", "7", [
              skillPackage(".", "app", "App v2.")
            ])
          ]),
          releaseRepository("acme/tool", [
            release("v2.0.0", "8", [
              skillPackage(".", "tool", "Tool v2.")
            ])
          ])
        ]);
        const result = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          repositoryTransport:
            updateFixture.repositoryTransport,
          transport: updateFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "all-roots-update",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "updated") {
          return;
        }
        const versions = result.value.plan.candidate.sourceBindings
          .filter(
            (
              entry
            ): entry is Extract<
              typeof entry,
              { sourceKind: "github-release" }
            > => entry.sourceKind === "github-release"
          )
          .map((entry) => [
            entry.repositoryCoordinate,
            entry.version
          ]);
        assert.deepEqual(versions, [
          ["acme/app", "2.0.0"],
          ["acme/tool", "2.0.0"]
        ]);
        assert.match(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          /App v2\./u
        );
        assert.match(
          await readFile(join(targetRoot, "tool", "SKILL.md"), "utf8"),
          /Tool v2\./u
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("declined whole-target update leaves accepted state Store and live Target unchanged", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const initialFixture = singleAppFixture(
        "v1.0.0",
        "9",
        "Decline v1."
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
        const storeBefore = [...readdirSync(paths.storePath)].sort();
        const appBefore = await readFile(
          join(targetRoot, "app", "SKILL.md"),
          "utf8"
        );
        let markerCalls = 0;

        const result = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          repositoryTransport:
            singleAppFixture(
              "v2.0.0",
              "a",
              "Decline v2."
            ).repositoryTransport,
          transport:
            singleAppFixture(
              "v2.0.0",
              "a",
              "Decline v2."
            ).transport,
          acceptCandidate: () => false,
          createOperationId: () => "declined-update",
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
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );
        assert.equal(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          appBefore
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

test("detached bytes and baseline remain user-owned while update changes logical exact state", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const initialFixture = singleAppFixture(
        "v1.0.0",
        "b",
        "Detached v1."
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
        const appPackage = initial.resolvedPackages[0]!;
        const appProjection = initial.projections[0]!;
        const current: TargetOwnedProjection = {
          projection: {
            packageCoordinate: appPackage.packageCoordinate,
            packageRoot: appPackage.packageRoot,
            contentDigest: appPackage.contentDigest,
            activationName: appProjection.activationName,
            projectionKind: "direct",
            transform: null
          },
          ownership: "managed",
          materialization: appProjection.materialization
        };
        const detached = await detachTargetProjection({
          home: paths,
          targetRoot,
          operationId: "detach-before-update",
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
        assert.equal(detached.value.generation, 2);
        const baselineBefore =
          detached.value.detachedBaselines[0]!;
        await writeFile(
          join(targetRoot, "app", "USER-NOTE"),
          "my detached update note\n"
        );

        const updateFixture = singleAppFixture(
          "v2.0.0",
          "c",
          "Detached v2."
        );
        const result = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          repositoryTransport:
            updateFixture.repositoryTransport,
          transport: updateFixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "detached-update",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "updated") {
          return;
        }
        assert.equal(result.value.state.generation, 3);
        assert.equal(
          await readFile(join(targetRoot, "app", "USER-NOTE"), "utf8"),
          "my detached update note\n"
        );
        assert.equal(
          result.value.state.projections[0]?.ownership,
          "detached"
        );
        assert.deepEqual(
          result.value.state.detachedBaselines[0],
          baselineBefore
        );
        const updatedSource =
          result.value.state.resolvedSources[0];
        assert.equal(
          updatedSource?.sourceKind === "github-release"
            ? updatedSource.version
            : undefined,
          "2.0.0"
        );
        assert.equal(
          result.value.plan.comparison.packageDeltas.some(
            (delta) =>
              delta.kind === "package-content-changed" &&
              delta.packageCoordinate === "acme/app/app"
          ),
          true
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("Release tag retarget requires special authorization before ordinary candidate acceptance", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const initialFixture = singleAppFixture(
        "v1.0.0",
        "d",
        "Retarget original."
      );
      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: initialFixture,
          requirements: [
            releasePackageRequirement(
              "acme/app/app",
              "^1.0.0"
            )
          ]
        });
        const storeBefore = [...readdirSync(paths.storePath)].sort();
        const retargetFixture = singleAppFixture(
          "v1.0.0",
          "e",
          "Retarget changed."
        );
        let ordinaryCalls = 0;

        const blocked = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          repositoryTransport:
            retargetFixture.repositoryTransport,
          transport: retargetFixture.transport,
          acceptCandidate: () => {
            ordinaryCalls += 1;
            return true;
          },
          createOperationId: () => "retarget-blocked",
          syncMarker: () => {}
        });

        assert.equal(ordinaryCalls, 0);
        assert.equal(blocked.ok, false);
        if (!blocked.ok) {
          assert.deepEqual(blocked.error, {
            code: "ReleaseRetargetAuthorizationRequired",
            facts: {
              retargets: [
                {
                  repositoryCoordinate: "acme/app",
                  actualTag: "v1.0.0",
                  previousCommit: "d".repeat(40),
                  candidateCommit: "e".repeat(40)
                }
              ]
            }
          });
        }
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: initial }
        );
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );

        const order: string[] = [];
        const accepted = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          repositoryTransport:
            retargetFixture.repositoryTransport,
          transport: retargetFixture.transport,
          authorizeReleaseRetarget: (retargets) => {
            order.push("retarget");
            assert.equal(retargets.length, 1);
            return true;
          },
          acceptCandidate: () => {
            order.push("ordinary");
            return true;
          },
          createOperationId: () => "retarget-accepted",
          syncMarker: () => {}
        });

        assert.equal(accepted.ok, true);
        if (!accepted.ok || accepted.value.status !== "updated") {
          return;
        }
        assert.deepEqual(order, ["retarget", "ordinary"]);
        assert.equal(accepted.value.state.generation, 2);
        assert.equal(
          accepted.value.plan.comparison.sourceDeltas.some(
            (delta) => delta.kind === "release-retarget"
          ),
          true
        );
        assert.match(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          /Retarget changed\./u
        );
      } finally {
        registry.close();
      }
    });
  });
});

function singleAppFixture(
  tag: string,
  commitSeed: string,
  description: string
) {
  return sourceFixture([
    releaseRepository("acme/app", [
      release(tag, commitSeed, [
        skillPackage(".", "app", description)
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
    createOperationId: () => "initial-update-fixture",
    syncMarker: () => {}
  });
  assert.equal(installed.ok, true);
  if (!installed.ok || installed.value.status !== "installed") {
    throw new Error("initial lifecycle install failed");
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

function readUtf8Sync(path: string): string {
  return readFileSync(path, "utf8");
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
  const root = await mkdtemp(join(tmpdir(), "skiloom-update-"));
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
