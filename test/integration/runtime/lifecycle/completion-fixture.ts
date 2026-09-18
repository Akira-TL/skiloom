import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { planTargetProjections, type TargetPlan } from "../../../../src/domain/target/index.js";
import type { TargetOwnedProjection } from "../../../../src/domain/target/preflight.js";
import { acquireOperationLock, type OperationLockSession } from "../../../../src/native/skiloom-lock.js";
import { resolveSkiloomHomePaths, type SkiloomHomePaths } from "../../../../src/runtime/home.js";
import { executeFirstAcceptedInstall } from "../../../../src/runtime/orchestration/lifecycle/first-install.js";
import { openMachineRegistry, type MachineRegistry, type RegistryTargetState, type RegistryTargetStateInput } from "../../../../src/runtime/registry/index.js";
import { release, releaseRepository, skillPackage, sourceFixture } from "./github-source-fixture.js";

export const targetId = "66666666-6666-4666-8666-666666666666";
const helperExecutable = requiredHelperExecutable();

export function lifecycleFixture(version: "v1.0.0" | "v2.0.0") {
  const major = version.startsWith("v2") ? "2" : "1";
  return sourceFixture([
    releaseRepository("acme/app", [
      release(version, major, [
        skillPackage(
          ".",
          "app",
          `Application ${version}.`,
          { "acme/shared/shared": "^1.0.0" }
        )
      ])
    ]),
    releaseRepository("acme/tool", [
      release(version, major === "2" ? "4" : "3", [
        skillPackage(
          ".",
          "tool",
          `Tool ${version}.`,
          { "acme/shared/shared": "^1.0.0" }
        )
      ])
    ]),
    releaseRepository("acme/shared", [
      release("v1.0.0", "6", [
        skillPackage(".", "shared", "Shared.")
      ])
    ]),
    releaseRepository("acme/suite", [
      release(
        version,
        major === "2" ? "8" : "7",
        [
          skillPackage(
            "skills/alpha",
            "alpha",
            `Alpha ${version}.`
          ),
          skillPackage(
            "skills/beta",
            "beta",
            `Beta ${version}.`
          )
        ],
        `schema = 1

[discovery]
include = ["skills/*"]
`
      )
    ])
  ]);
}

export function singleAppFixture(
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

export async function install(input: Readonly<{
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
    createOperationId: () => "completion-initial-install",
    syncMarker: () => {}
  });
  assert.equal(installed.ok, true);
  if (!installed.ok || installed.value.status !== "installed") {
    throw new Error("completion initial install failed");
  }
  return installed.value.state;
}

export function countRegistryWrites(
  registry: MachineRegistry,
  counters: {
    beginPending: number;
    beginReconciliation: number;
    replace: number;
    completePending: number;
  }
): MachineRegistry {
  return {
    close: () => registry.close(),
    pragmas: () => registry.pragmas(),
    readTargetState: (id) => registry.readTargetState(id),
    readPendingOperations: () => registry.readPendingOperations(),
    beginPendingOperation: (id, pending) => {
      counters.beginPending += 1;
      return registry.beginPendingOperation(id, pending);
    },
    beginPendingReconciliation: (id, pending) => {
      counters.beginReconciliation += 1;
      return registry.beginPendingReconciliation(id, pending);
    },
    completePendingOperation: (operationId) => {
      counters.completePending += 1;
      return registry.completePendingOperation(operationId);
    },
    replaceTargetState: (state, pendingOperationId) => {
      counters.replace += 1;
      return registry.replaceTargetState(state, pendingOperationId);
    }
  };
}

export function failBeforeCommitRegistry(
  registry: MachineRegistry,
  lockPath: string
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
    replaceTargetState: () => ({
      ok: false,
      error: {
        code: "OperationLockLost",
        facts: {
          lockPath,
          reason: "session-not-held"
        }
      }
    })
  };
}

export function afterSuccessfulReplaceRegistry(
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
    replaceTargetState: (state, pendingOperationId) => {
      const result = registry.replaceTargetState(
        state,
        pendingOperationId
      );
      if (result.ok) {
        afterReplace();
      }
      return result;
    }
  };
}

export function interruptAfterCommitLock(
  real: OperationLockSession,
  lockPath: string
): Readonly<{
  lock: OperationLockSession;
  interrupt(): void;
}> {
  let interrupted = false;
  const error = {
    code: "OperationLockLost" as const,
    facts: {
      lockPath,
      reason: "session-not-held" as const
    }
  };

  return {
    interrupt() {
      interrupted = true;
    },
    lock: {
      get held() {
        return !interrupted && real.held;
      },
      get helperPid() {
        return real.helperPid;
      },
      checkHeld() {
        return interrupted
          ? { ok: false as const, error }
          : real.checkHeld();
      },
      waitForLoss() {
        return real.waitForLoss();
      },
      release() {
        return real.release();
      }
    }
  };
}

export function targetPlanForState(
  state: RegistryTargetState
): TargetPlan {
  const directRoots = state.directRequirements.flatMap(
    (requirement) => {
      if (requirement.kind === "package") {
        return [requirement.coordinate];
      }
      return state.resolvedPackages
        .filter(
          (entry) =>
            entry.repositoryCoordinate === requirement.coordinate
        )
        .map((entry) => entry.packageCoordinate);
    }
  );
  const plan = planTargetProjections({
    packages: state.resolvedPackages.map((entry) => ({
      packageCoordinate: entry.packageCoordinate,
      packageRoot: entry.packageRoot,
      contentDigest: entry.contentDigest
    })),
    dependencyEdges: state.dependencyEdges.map((edge) => ({
      sourcePackageCoordinate: edge.fromPackage,
      targetPackageCoordinate: edge.toPackage
    })),
    directRoots,
    renames: []
  });
  if (!plan.ok) {
    throw new Error(plan.error.code);
  }
  return plan.value;
}

export function currentOwnedForOldState(
  state: RegistryTargetState
): ReadonlyArray<TargetOwnedProjection> {
  return state.resolvedPackages.map((packageFact) => {
    const projection = state.projections.find(
      (entry) =>
        entry.packageCoordinate === packageFact.packageCoordinate
    );
    if (projection === undefined) {
      throw new Error("missing old projection");
    }
    return {
      projection: {
        packageCoordinate: packageFact.packageCoordinate,
        packageRoot: packageFact.packageRoot,
        contentDigest: packageFact.contentDigest,
        activationName: projection.activationName,
        projectionKind: "direct" as const,
        transform: null
      },
      ownership: projection.ownership,
      materialization: projection.materialization
    };
  });
}

export function stateInput(
  state: RegistryTargetState
): RegistryTargetStateInput {
  return {
    targetId: state.targetId,
    locations: state.locations,
    directRequirements: state.directRequirements,
    resolvedSources: state.resolvedSources,
    resolvedPackages: state.resolvedPackages,
    dependencyEdges: state.dependencyEdges,
    projections: state.projections,
    detachedBaselines: state.detachedBaselines,
    dependencyObservations: state.dependencyObservations
  };
}

export async function requireRegistry(
  paths: SkiloomHomePaths,
  lock: OperationLockSession
): Promise<MachineRegistry> {
  const opened = await openMachineRegistry(paths, lock);
  if (!opened.ok) {
    throw new Error(opened.error.code);
  }
  return opened.value;
}

export async function withRuntime(
  run: (input: Readonly<{
    paths: SkiloomHomePaths;
    targetRoot: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skiloom-completion-"));
  const paths = resolveSkiloomHomePaths(join(root, "home"));
  const targetRoot = join(root, "target");
  await mkdir(targetRoot, { recursive: true });
  try {
    await run({ paths, targetRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function withRealLock(
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
