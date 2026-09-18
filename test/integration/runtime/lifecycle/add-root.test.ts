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
  addAcceptedTargetRoots
} from "../../../../src/runtime/orchestration/lifecycle/add-root.js";
import {
  executeFirstAcceptedInstall
} from "../../../../src/runtime/orchestration/lifecycle/first-install.js";
import {
  detachTargetProjection
} from "../../../../src/runtime/orchestration/detached-lifecycle.js";
import {
  openMachineRegistry,
  type MachineRegistry,
  type RegistryTargetState
} from "../../../../src/runtime/registry/index.js";
import {
  materializeManagedProjection
} from "../../../../src/runtime/target-projection/index.js";
import {
  release,
  releasePackageRequirement,
  releaseRepository,
  releaseRepositoryRequirement,
  skillPackage,
  sourceFixture
} from "./github-source-fixture.js";

const helperExecutable = requiredHelperExecutable();
const targetId = "33333333-3333-4333-8333-333333333333";

test("adding a Package root recomputes the complete graph and keeps one shared dependency binding", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = sharedFixture();
      try {
        const initial = await installApp({
          paths,
          targetRoot,
          lock,
          registry,
          fixture
        });
        assert.equal(initial.generation, 1);
        assert.deepEqual(
          initial.resolvedPackages.map((entry) => entry.packageCoordinate),
          ["acme/app/app", "acme/shared/shared"]
        );
        const storeCountBefore = readdirSync(paths.storePath).length;

        const result = await addAcceptedTargetRoots({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          additions: [
            releasePackageRequirement("acme/tool/tool", "^1.0.0")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "add-tool-root",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "applied") {
          return;
        }
        assert.equal(result.value.state.generation, 2);
        assert.deepEqual(
          result.value.state.directRequirements.map((entry) => [
            entry.kind,
            entry.coordinate
          ]),
          [
            ["package", "acme/app/app"],
            ["package", "acme/tool/tool"]
          ]
        );
        assert.deepEqual(
          result.value.state.resolvedPackages.map(
            (entry) => entry.packageCoordinate
          ),
          [
            "acme/app/app",
            "acme/shared/shared",
            "acme/tool/tool"
          ]
        );
        assert.equal(
          result.value.state.resolvedPackages.filter(
            (entry) =>
              entry.packageCoordinate === "acme/shared/shared"
          ).length,
          1
        );
        assert.equal(
          result.value.state.projections.filter(
            (entry) =>
              entry.packageCoordinate === "acme/shared/shared"
          ).length,
          1
        );
        assert.equal(
          readdirSync(paths.storePath).length,
          storeCountBefore + 1,
          "only the newly introduced tool payload should publish"
        );
        assert.equal(existsSync(join(targetRoot, "app")), true);
        assert.equal(existsSync(join(targetRoot, "shared")), true);
        assert.equal(existsSync(join(targetRoot, "tool")), true);
      } finally {
        registry.close();
      }
    });
  });
});

test("adding a repository-wide root rediscovers all selected snapshot Packages as roots", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = sourceFixture([
        ...baseRepositories(),
        releaseRepository("acme/suite", [
          release(
            "v1.0.0",
            "7",
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
        ])
      ]);

      try {
        await installApp({
          paths,
          targetRoot,
          lock,
          registry,
          fixture
        });

        const result = await addAcceptedTargetRoots({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          additions: [
            releaseRepositoryRequirement(
              "acme/suite",
              "^1.0.0"
            )
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "add-suite-root",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "applied") {
          return;
        }
        assert.equal(result.value.state.generation, 2);
        assert.deepEqual(
          result.value.state.directRequirements.map((entry) => [
            entry.kind,
            entry.coordinate
          ]),
          [
            ["package", "acme/app/app"],
            ["repository", "acme/suite"]
          ]
        );
        assert.deepEqual(
          result.value.plan.candidate.packages
            .filter((entry) =>
              entry.packageCoordinate.startsWith("acme/suite/")
            )
            .map((entry) => entry.packageCoordinate),
          ["acme/suite/alpha", "acme/suite/beta"]
        );
        assert.equal(existsSync(join(targetRoot, "alpha")), true);
        assert.equal(existsSync(join(targetRoot, "beta")), true);
      } finally {
        registry.close();
      }
    });
  });
});

test("declined add-root leaves accepted generation Store and live Target unchanged", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = sharedFixture();
      try {
        const initial = await installApp({
          paths,
          targetRoot,
          lock,
          registry,
          fixture
        });
        const storeBefore = [...readdirSync(paths.storePath)].sort();
        const appBefore = await readFile(
          join(targetRoot, "app", "SKILL.md"),
          "utf8"
        );
        let markerCalls = 0;

        const result = await addAcceptedTargetRoots({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          additions: [
            releasePackageRequirement("acme/tool/tool")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => false,
          createOperationId: () => "declined-add-root",
          syncMarker: () => {
            markerCalls += 1;
          }
        });

        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.status, "declined");
        }
        assert.equal(markerCalls, 0);
        const accepted = registry.readTargetState(targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.deepEqual(accepted.value, initial);
        }
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );
        assert.equal(existsSync(join(targetRoot, "tool")), false);
        assert.equal(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          appBefore
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("foreign path for a newly added root fails ownership preflight before Store or Registry changes", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = sharedFixture();
      try {
        const initial = await installApp({
          paths,
          targetRoot,
          lock,
          registry,
          fixture
        });
        const storeBefore = [...readdirSync(paths.storePath)].sort();
        const foreign = join(targetRoot, "tool");
        await mkdir(foreign);
        await writeFile(
          join(foreign, "KEEP"),
          "foreign tool bytes\n"
        );

        const result = await addAcceptedTargetRoots({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          additions: [
            releasePackageRequirement("acme/tool/tool")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "foreign-add-root",
          syncMarker: () => {}
        });

        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.deepEqual(result.error, {
            code: "ForeignTargetPathConflict",
            facts: {
              activationName: "tool",
              desiredPackageCoordinate: "acme/tool/tool"
            }
          });
        }
        const accepted = registry.readTargetState(targetId);
        assert.equal(accepted.ok, true);
        if (accepted.ok) {
          assert.deepEqual(accepted.value, initial);
        }
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );
        assert.equal(
          await readFile(join(foreign, "KEEP"), "utf8"),
          "foreign tool bytes\n"
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("adding a root preserves an existing managed activation-name override", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = sharedFixture();
      try {
        const initial = await installApp({
          paths,
          targetRoot,
          lock,
          registry,
          fixture
        });
        const appPackage = initial.resolvedPackages.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        )!;
        const renamedProjection = {
          packageCoordinate: appPackage.packageCoordinate,
          packageRoot: appPackage.packageRoot,
          contentDigest: appPackage.contentDigest,
          activationName: "app-local",
          projectionKind: "transformed-copy" as const,
          transform: {
            rename: {
              fromActivationName: "app",
              toActivationName: "app-local"
            },
            dependencyRoutes: []
          }
        };
        const materialized = await materializeManagedProjection({
          home: paths,
          targetRoot,
          projection: renamedProjection,
          materialization: "copy"
        });
        assert.equal(materialized.ok, true);
        if (!materialized.ok) {
          return;
        }
        await rm(join(targetRoot, "app"), {
          recursive: true,
          force: true
        });

        const renamedState = registry.replaceTargetState({
          ...initial,
          projections: initial.projections.map((projection) =>
            projection.packageCoordinate === "acme/app/app"
              ? {
                  ...projection,
                  activationName: "app-local",
                  materialization: "copy",
                  transformJson: JSON.stringify(
                    renamedProjection.transform
                  )
                }
              : projection
          )
        });
        assert.equal(renamedState.ok, true);
        if (!renamedState.ok) {
          return;
        }
        assert.equal(renamedState.value.generation, 2);

        const result = await addAcceptedTargetRoots({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          additions: [
            releasePackageRequirement("acme/tool/tool")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "add-root-preserve-rename",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "applied") {
          return;
        }
        assert.equal(result.value.state.generation, 3);
        const appProjection = result.value.state.projections.find(
          (projection) =>
            projection.packageCoordinate === "acme/app/app"
        );
        assert.equal(appProjection?.activationName, "app-local");
        assert.equal(appProjection?.ownership, "managed");
        assert.equal(appProjection?.materialization, "copy");
        assert.equal(existsSync(join(targetRoot, "app")), false);
        assert.equal(existsSync(join(targetRoot, "app-local")), true);
        assert.equal(existsSync(join(targetRoot, "tool")), true);
        assert.match(
          await readFile(
            join(targetRoot, "app-local", "SKILL.md"),
            "utf8"
          ),
          /name: app-local/u
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("adding a root preserves detached user bytes ownership and baseline for a still-bound Package", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = sharedFixture();
      try {
        const initial = await installApp({
          paths,
          targetRoot,
          lock,
          registry,
          fixture
        });
        const appPackage = initial.resolvedPackages.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        )!;
        const appProjection = initial.projections.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        )!;
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
          operationId: "detach-before-add",
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
        await writeFile(
          join(targetRoot, "app", "USER-NOTE"),
          "keep my detached edit\n"
        );
        const baselineBefore =
          detached.value.detachedBaselines.find(
            (entry) =>
              entry.packageCoordinate === "acme/app/app"
          );
        assert.notEqual(baselineBefore, undefined);

        const result = await addAcceptedTargetRoots({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          additions: [
            releasePackageRequirement("acme/tool/tool")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: () => true,
          createOperationId: () => "add-root-with-detached",
          syncMarker: () => {}
        });

        assert.equal(result.ok, true);
        if (!result.ok || result.value.status !== "applied") {
          return;
        }
        assert.equal(result.value.state.generation, 3);
        assert.equal(
          await readFile(join(targetRoot, "app", "USER-NOTE"), "utf8"),
          "keep my detached edit\n"
        );
        const appAfter = result.value.state.projections.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        );
        assert.equal(appAfter?.ownership, "detached");
        assert.deepEqual(
          result.value.state.detachedBaselines.find(
            (entry) =>
              entry.packageCoordinate === "acme/app/app"
          ),
          baselineBefore
        );
        assert.equal(existsSync(join(targetRoot, "tool")), true);
      } finally {
        registry.close();
      }
    });
  });
});

function sharedFixture() {
  return sourceFixture([
    ...baseRepositories(),
    releaseRepository("acme/tool", [
      release("v1.0.0", "6", [
        skillPackage(
          ".",
          "tool",
          "Tool package.",
          { "acme/shared/shared": "^1.0.0" }
        )
      ])
    ])
  ]);
}

function baseRepositories() {
  return [
    releaseRepository("acme/app", [
      release("v1.0.0", "5", [
        skillPackage(
          ".",
          "app",
          "Application package.",
          { "acme/shared/shared": "^1.0.0" }
        )
      ])
    ]),
    releaseRepository("acme/shared", [
      release("v1.0.0", "4", [
        skillPackage(".", "shared", "Shared package.")
      ])
    ])
  ];
}

async function installApp(input: Readonly<{
  paths: SkiloomHomePaths;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  fixture: ReturnType<typeof sourceFixture>;
}>): Promise<RegistryTargetState> {
  const installed = await executeFirstAcceptedInstall({
    home: input.paths,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry,
    directRequirements: [
      releasePackageRequirement("acme/app/app", "^1.0.0")
    ],
    repositoryTransport: input.fixture.repositoryTransport,
    transport: input.fixture.transport,
    acceptCandidate: () => true,
    createTargetId: () => targetId,
    createOperationId: () => "initial-app-install",
    syncMarker: () => {}
  });
  assert.equal(installed.ok, true);
  if (!installed.ok || installed.value.status !== "installed") {
    throw new Error("initial app install failed");
  }
  return installed.value.state;
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
  const root = await mkdtemp(join(tmpdir(), "skiloom-add-root-"));
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
