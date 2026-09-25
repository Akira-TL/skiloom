import {
  lstat,
  rename
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parsePackageCoordinate
} from "../../../../domain/coordinate/index.js";
import {
  productError,
  type Result
} from "../../../../domain/errors/index.js";
import type {
  ResolverCandidateGraph
} from "../../../../domain/resolver/index.js";
import type {
  TargetPlan,
  TargetPlanError,
  TargetProjectionRename
} from "../../../../domain/target/index.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../../../native/skiloom-lock.js";
import type {
  RegistryPendingOperation,
  RegistryProjection,
  RegistryTargetState
} from "../../../registry/index.js";
import {
  removeManagedProjection,
  verifyManagedProjection,
  verifyManagedProjectionAtPath,
  type ManagedProjectionRuntimeError,
  type ManagedProjectionVerificationError
} from "../../../target-projection/index.js";
import {
  isSafePendingStagingPath
} from "../../target-reconcile-state.js";
import {
  readTargetReconciliationRecoveryManifest,
  recoveryManifestPreviousOwned,
  type InvalidTargetReconciliationRecoveryManifest,
  type TargetReconciliationRecoveryManifest
} from "../../target-reconcile/recovery.js";
import {
  planLifecycleTarget
} from "../apply.js";
import {
  registryRequirementsToDomain
} from "../requirements.js";
import type {
  InterruptedLifecycleRecoveryConflict,
  InterruptedLifecycleRecoveryConflictReason,
  RecoverInterruptedLifecycleInput
} from "./index.js";

type RecoveryAction = Readonly<{
  pending: RegistryPendingOperation["actions"][number];
  manifest: TargetReconciliationRecoveryManifest;
}>;

export function acceptedTargetPlan(
  state: RegistryTargetState
): Result<TargetPlan, TargetPlanError | InterruptedLifecycleRecoveryConflict> {
  const requirements = registryRequirementsToDomain(
    state.targetId,
    state.directRequirements
  );
  if (!requirements.ok) {
    return conflict(
      state.targetId,
      null,
      "post-commit",
      "accepted-projection-mismatch",
      state.generation,
      null,
      null,
      "direct-requirements"
    );
  }

  const plan = planLifecycleTarget(
    requirements.value,
    registryGraph(state),
    projectionRenames(state.projections)
  );
  if (!plan.ok) {
    return plan;
  }

  const byPackage = new Map(
    plan.value.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  const acceptedPackages = new Set<string>();
  for (const projection of state.projections) {
    const planned = byPackage.get(
      projection.packageCoordinate
    );
    if (
      planned === undefined ||
      planned.activationName !==
        projection.activationName ||
      (
        projection.ownership === "managed" &&
        projectionTransformJson(planned) !==
          projection.transformJson
      )
    ) {
      return conflict(
        state.targetId,
        null,
        "post-commit",
        "accepted-projection-mismatch",
        state.generation,
        null,
        null,
        projection.packageCoordinate
      );
    }
    acceptedPackages.add(projection.packageCoordinate);
  }

  return {
    ok: true,
    value: {
      ...plan.value,
      projections: plan.value.projections.filter(
        (projection) =>
          acceptedPackages.has(projection.packageCoordinate)
      )
    }
  };
}

function registryGraph(
  state: RegistryTargetState
): ResolverCandidateGraph {
  return {
    sourceBindings: [],
    packages: state.resolvedPackages.map((entry) => ({
      packageCoordinate: entry.packageCoordinate,
      packageRoot: entry.packageRoot,
      contentDigest: entry.contentDigest
    })),
    dependencyEdges: state.dependencyEdges.map((edge) => ({
      sourcePackageCoordinate: edge.fromPackage,
      targetPackageCoordinate: edge.toPackage
    }))
  };
}

function projectionRenames(
  projections: ReadonlyArray<RegistryProjection>
): ReadonlyArray<TargetProjectionRename> {
  return projections.flatMap((projection) => {
    const coordinate = parsePackageCoordinate(
      projection.packageCoordinate
    );
    if (
      !coordinate.ok ||
      coordinate.value.packageName ===
        projection.activationName
    ) {
      return [];
    }
    return [
      {
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName
      }
    ];
  });
}

export async function readRecoveryActions(
  targetRoot: string,
  state: RegistryTargetState,
  pending: RegistryPendingOperation
): Promise<
  Result<
    ReadonlyArray<RecoveryAction>,
    | InterruptedLifecycleRecoveryConflict
    | InvalidTargetReconciliationRecoveryManifest
  >
> {
  const result: RecoveryAction[] = [];
  const seen = new Set<string>();

  for (const action of pending.actions) {
    if (
      !isSafePendingStagingPath(targetRoot, action)
    ) {
      return conflict(
        state.targetId,
        pending.operationId,
        "post-commit",
        "unsafe-pending-staging-path",
        state.generation,
        pending.baseGeneration,
        pending.nextGeneration,
        action.stagingPath
      );
    }
    if (seen.has(action.activationName)) {
      return conflict(
        state.targetId,
        pending.operationId,
        "post-commit",
        "pending-action-mismatch",
        state.generation,
        pending.baseGeneration,
        pending.nextGeneration,
        action.activationName
      );
    }
    seen.add(action.activationName);

    const manifest =
      await readTargetReconciliationRecoveryManifest(
        action.stagingPath,
        {
          operationId: pending.operationId,
          targetId: state.targetId,
          activationName: action.activationName
        }
      );
    if (!manifest.ok) {
      return manifest;
    }
    result.push({
      pending: action,
      manifest: manifest.value
    });
  }

  return {
    ok: true,
    value: result.sort((left, right) =>
      compareUtf8(
        left.pending.activationName,
        right.pending.activationName
      )
    )
  };
}

export async function convergeAcceptedTarget(
  input: RecoverInterruptedLifecycleInput,
  state: RegistryTargetState,
  plan: TargetPlan,
  pending: RegistryPendingOperation,
  actions: ReadonlyArray<RecoveryAction>
): Promise<
  Result<
    void,
    | OperationLockLost
    | InterruptedLifecycleRecoveryConflict
    | ManagedProjectionRuntimeError
    | ManagedProjectionVerificationError
  >
> {
  const desiredByActivation = new Map(
    plan.projections.map((projection) => [
      projection.activationName,
      projection
    ])
  );
  const registryByActivation = new Map(
    state.projections.map((projection) => [
      projection.activationName,
      projection
    ])
  );
  const actionByActivation = new Map(
    actions.map((entry) => [
      entry.pending.activationName,
      entry
    ])
  );

  for (const projection of state.projections) {
    if (projection.ownership === "detached") {
      continue;
    }
    if (actionByActivation.has(projection.activationName)) {
      continue;
    }

    const desired = desiredByActivation.get(
      projection.activationName
    );
    if (desired === undefined) {
      return recoveryConflictForPending(
        state,
        pending,
        "accepted-projection-mismatch",
        projection.activationName
      );
    }

    const verified = await verifyManagedProjection({
      home: input.home,
      targetRoot: resolve(input.targetRoot),
      expected: {
        projection: desired,
        materialization: projection.materialization
      }
    });
    if (!verified.ok) {
      return recoveryConflictForPending(
        state,
        pending,
        "unproven-live-drift",
        projection.activationName
      );
    }
  }

  for (const entry of actions) {
    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }

    if (entry.manifest.action === "remove") {
      if (
        registryByActivation.has(
          entry.pending.activationName
        )
      ) {
        return recoveryConflictForPending(
          state,
          pending,
          "pending-action-mismatch",
          entry.pending.activationName
        );
      }
      const previous =
        recoveryManifestPreviousOwned(
          entry.manifest
        );
      if (previous === undefined) {
        return recoveryConflictForPending(
          state,
          pending,
          "pending-action-mismatch",
          entry.pending.activationName
        );
      }
      const removed = await removeManagedProjection({
        home: input.home,
        targetRoot: resolve(input.targetRoot),
        expected: {
          projection: previous.projection,
          materialization: previous.materialization
        }
      });
      if (!removed.ok) {
        return removed;
      }
      continue;
    }

    const desired = desiredByActivation.get(
      entry.pending.activationName
    );
    const registryProjection =
      registryByActivation.get(
        entry.pending.activationName
      );
    if (
      desired === undefined ||
      registryProjection === undefined ||
      registryProjection.ownership !== "managed"
    ) {
      return recoveryConflictForPending(
        state,
        pending,
        "pending-action-mismatch",
        entry.pending.activationName
      );
    }

    const acceptedLive = await verifyManagedProjection({
      home: input.home,
      targetRoot: resolve(input.targetRoot),
      expected: {
        projection: desired,
        materialization:
          registryProjection.materialization
      }
    });
    if (acceptedLive.ok) {
      continue;
    }
    if (
      isStoreVerificationError(acceptedLive.error.code)
    ) {
      return acceptedLive;
    }

    const previous =
      recoveryManifestPreviousOwned(entry.manifest);
    if (previous !== undefined) {
      const previousLive = await verifyManagedProjection({
        home: input.home,
        targetRoot: resolve(input.targetRoot),
        expected: {
          projection: previous.projection,
          materialization: previous.materialization
        }
      });
      if (
        !previousLive.ok &&
        previousLive.error.code !==
          "ManagedProjectionMissing"
      ) {
        return previousLive;
      }
    } else if (
      await pathExists(
        join(
          resolve(input.targetRoot),
          entry.pending.activationName
        )
      )
    ) {
      return recoveryConflictForPending(
        state,
        pending,
        "unproven-live-drift",
        entry.pending.activationName
      );
    }

    const stagedPath = join(
      entry.pending.stagingPath,
      "projection"
    );
    const staged = await verifyManagedProjectionAtPath({
      home: input.home,
      activationPath: stagedPath,
      activationName: entry.pending.activationName,
      projection: desired,
      materialization:
        registryProjection.materialization
    });
    if (!staged.ok) {
      return staged;
    }

    const activated = await activatePendingProjection({
      targetRoot: resolve(input.targetRoot),
      lock: input.lock,
      stagingPath: entry.pending.stagingPath,
      activationName: entry.pending.activationName,
      hasPrevious:
        previous !== undefined &&
        (
          await pathExists(
            join(
              resolve(input.targetRoot),
              entry.pending.activationName
            )
          )
        )
    });
    if (!activated.ok) {
      return activated;
    }
  }

  return { ok: true, value: undefined };
}

async function activatePendingProjection(
  input: Readonly<{
    targetRoot: string;
    lock: OperationLockSession;
    stagingPath: string;
    activationName: string;
    hasPrevious: boolean;
  }>
): Promise<Result<void, OperationLockLost>> {
  const activationPath = join(
    input.targetRoot,
    input.activationName
  );
  const projectionPath = join(
    input.stagingPath,
    "projection"
  );

  if (!input.hasPrevious) {
    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    await rename(projectionPath, activationPath);
    const after = input.lock.checkHeld();
    return after.ok
      ? { ok: true, value: undefined }
      : after;
  }

  const retiredPath = join(
    input.stagingPath,
    "retired"
  );
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }
  await rename(activationPath, retiredPath);

  const afterRetire = input.lock.checkHeld();
  if (!afterRetire.ok) {
    return afterRetire;
  }

  try {
    await rename(projectionPath, activationPath);
  } catch (error) {
    const rollbackHeld = input.lock.checkHeld();
    if (
      rollbackHeld.ok &&
      !(await pathExists(activationPath))
    ) {
      await rename(retiredPath, activationPath);
    }
    throw error;
  }

  const afterActivate = input.lock.checkHeld();
  return afterActivate.ok
    ? { ok: true, value: undefined }
    : afterActivate;
}

function projectionTransformJson(
  projection: TargetPlan["projections"][number]
): string | null {
  return projection.transform === null
    ? null
    : JSON.stringify({
        rename: projection.transform.rename,
        dependencyRoutes:
          projection.transform.dependencyRoutes
      });
}

function recoveryConflictForPending(
  state: RegistryTargetState,
  pending: RegistryPendingOperation,
  reason: InterruptedLifecycleRecoveryConflictReason,
  subject: string
): Result<never, InterruptedLifecycleRecoveryConflict> {
  return conflict(
    state.targetId,
    pending.operationId,
    "post-commit",
    reason,
    state.generation,
    pending.baseGeneration,
    pending.nextGeneration,
    subject
  );
}

function conflict(
  targetId: string,
  operationId: string | null,
  phase: InterruptedLifecycleRecoveryConflict["facts"]["phase"],
  reason: InterruptedLifecycleRecoveryConflictReason,
  registryGeneration: number | null,
  baseGeneration: number | null,
  nextGeneration: number | null,
  subject: string | null
): Result<never, InterruptedLifecycleRecoveryConflict> {
  return {
    ok: false,
    error: productError(
      "InterruptedLifecycleRecoveryConflict",
      {
        targetId,
        operationId,
        phase,
        reason,
        registryGeneration,
        baseGeneration,
        nextGeneration,
        subject
      }
    )
  };
}

function isStoreVerificationError(
  code: string
): boolean {
  return (
    code === "StoreEntryNotFound" ||
    code === "CorruptStoreEntry" ||
    code === "InvalidPackageContentDigest" ||
    code === "PackageContentDigestMismatch" ||
    code.startsWith("InvalidPackage")
  );
}

async function pathExists(
  path: string
): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function compareUtf8(
  left: string,
  right: string
): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
