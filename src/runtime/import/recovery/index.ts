import { resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  TargetPlanError
} from "../../../domain/target/index.js";
import type {
  TargetRecoveryMarkerFacts
} from "../../../domain/target/recovery.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../../native/skiloom-lock.js";
import type {
  SkiloomHomePaths
} from "../../home.js";
import type {
  MachineRegistry,
  RegistryPendingOperation,
  RegistryTargetState
} from "../../registry/index.js";
import type {
  ManagedProjectionRuntimeError,
  ManagedProjectionVerificationError
} from "../../target-projection/index.js";
import {
  buildMarkerFacts
} from "../../orchestration/lifecycle/apply.js";
import {
  syncLifecycleMarker,
  type LifecycleMarkerSyncCallback,
  type LifecycleMarkerSyncFailed
} from "../../orchestration/lifecycle/marker/index.js";
import {
  acceptedTargetPlan,
  convergeAcceptedTarget,
  readRecoveryActions
} from "../../orchestration/lifecycle/recovery/target.js";
import type {
  InterruptedLifecycleRecoveryConflict,
  RecoverInterruptedLifecycleInput
} from "../../orchestration/lifecycle/recovery/index.js";
import {
  cleanupPendingTargetStaging,
  type TargetReconciliationError
} from "../../orchestration/target-reconcile.js";
import type {
  InvalidTargetReconciliationRecoveryManifest
} from "../../orchestration/target-reconcile/recovery.js";
import {
  activateStagedImportUserPayload,
  readImportUserRecoveryManifest,
  type ImportUserActivationError,
  type ImportUserRecoveryManifest,
  type ImportUserStagingFailed
} from "./user-staging.js";

export type InterruptedExactImportRecoveryConflictReason =
  | "multiple-pending-operations"
  | "target-not-found"
  | "generation-mismatch"
  | "target-location-mismatch";

export type InterruptedExactImportRecoveryConflict = ProductError<
  "InterruptedExactImportRecoveryConflict",
  Readonly<{
    targetId: string;
    operationId: string | null;
    phase: "classify" | "pre-commit" | "post-commit";
    reason: InterruptedExactImportRecoveryConflictReason;
    registryGeneration: number | null;
    baseGeneration: number | null;
    nextGeneration: number | null;
    subject: string | null;
  }>
>;

export type RecoverInterruptedExactImportError =
  | OperationLockLost
  | InterruptedExactImportRecoveryConflict
  | InterruptedLifecycleRecoveryConflict
  | InvalidTargetReconciliationRecoveryManifest
  | ImportUserStagingFailed
  | ImportUserActivationError
  | TargetPlanError
  | ManagedProjectionRuntimeError
  | ManagedProjectionVerificationError
  | LifecycleMarkerSyncFailed
  | TargetReconciliationError;

export type RecoverInterruptedExactImportResult =
  | Readonly<{
      status: "no-pending";
      targetId: string;
    }>
  | Readonly<{
      status: "pre-commit-cleaned";
      targetId: string;
      operationId: string;
      generation: number;
    }>
  | Readonly<{
      status: "post-commit-recovered";
      targetId: string;
      operationId: string;
      state: RegistryTargetState;
      marker: TargetRecoveryMarkerFacts;
    }>;

export type RecoverInterruptedExactImportInput = Readonly<{
  home: SkiloomHomePaths;
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  syncMarker?: LifecycleMarkerSyncCallback;
}>;

export async function recoverInterruptedExactImport(
  input: RecoverInterruptedExactImportInput
): Promise<
  Result<
    RecoverInterruptedExactImportResult,
    RecoverInterruptedExactImportError
  >
> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const pendingRead = input.registry.readPendingOperations();
  if (!pendingRead.ok) {
    return pendingRead;
  }
  const pendingForTarget = pendingRead.value.filter(
    (entry) => entry.targetId === input.targetId
  );
  if (pendingForTarget.length === 0) {
    return {
      ok: true,
      value: {
        status: "no-pending",
        targetId: input.targetId
      }
    };
  }
  if (pendingForTarget.length !== 1) {
    return conflict(
      input.targetId,
      null,
      "classify",
      "multiple-pending-operations",
      null,
      null,
      null,
      null
    );
  }
  const pending = pendingForTarget[0]!;

  const stateRead = input.registry.readTargetState(
    input.targetId
  );
  if (!stateRead.ok) {
    return stateRead;
  }
  if (stateRead.value === undefined) {
    return conflict(
      input.targetId,
      pending.operationId,
      "classify",
      "target-not-found",
      null,
      pending.baseGeneration,
      pending.nextGeneration,
      null
    );
  }
  const state = stateRead.value;

  if (state.generation === pending.baseGeneration) {
    const cleaned = await cleanupPendingTargetStaging({
      targetId: input.targetId,
      targetRoot: resolve(input.targetRoot),
      lock: input.lock,
      registry: input.registry
    });
    if (!cleaned.ok) {
      return cleaned;
    }
    return {
      ok: true,
      value: {
        status: "pre-commit-cleaned",
        targetId: input.targetId,
        operationId: pending.operationId,
        generation: state.generation
      }
    };
  }

  if (state.generation !== pending.nextGeneration) {
    return conflict(
      input.targetId,
      pending.operationId,
      "classify",
      "generation-mismatch",
      state.generation,
      pending.baseGeneration,
      pending.nextGeneration,
      null
    );
  }

  const targetRoot = resolve(input.targetRoot);
  if (
    !state.locations.some(
      (location) => resolve(location.path) === targetRoot
    )
  ) {
    return conflict(
      input.targetId,
      pending.operationId,
      "post-commit",
      "target-location-mismatch",
      state.generation,
      pending.baseGeneration,
      pending.nextGeneration,
      targetRoot
    );
  }

  const desiredPlan = acceptedTargetPlan(state);
  if (!desiredPlan.ok) {
    return desiredPlan;
  }

  const partitioned = await partitionPendingActions(
    pending,
    state.targetId
  );
  if (!partitioned.ok) {
    return partitioned;
  }

  const lifecycleInput: RecoverInterruptedLifecycleInput = {
    home: input.home,
    targetId: input.targetId,
    targetRoot,
    lock: input.lock,
    registry: input.registry,
    ...(input.syncMarker === undefined
      ? {}
      : { syncMarker: input.syncMarker })
  };
  const managedPending: RegistryPendingOperation = {
    ...pending,
    actions: partitioned.value.managed
  };
  const managedActions = await readRecoveryActions(
    targetRoot,
    state,
    managedPending
  );
  if (!managedActions.ok) {
    return managedActions;
  }
  const managed = await convergeAcceptedTarget(
    lifecycleInput,
    state,
    desiredPlan.value,
    managedPending,
    managedActions.value
  );
  if (!managed.ok) {
    return managed;
  }

  for (const entry of partitioned.value.user) {
    const stillHeld = input.lock.checkHeld();
    if (!stillHeld.ok) {
      return stillHeld;
    }
    const activated = await activateStagedImportUserPayload({
      targetRoot,
      stagingPath: entry.stagingPath,
      manifest: entry.manifest,
      lock: input.lock
    });
    if (!activated.ok) {
      return activated;
    }
  }

  const heldBeforeMarker = input.lock.checkHeld();
  if (!heldBeforeMarker.ok) {
    return heldBeforeMarker;
  }
  const marker = buildMarkerFacts(
    state,
    desiredPlan.value
  );
  const markerSynced = await syncLifecycleMarker({
    targetRoot,
    marker,
    ...(input.syncMarker === undefined
      ? {}
      : { override: input.syncMarker })
  });
  if (!markerSynced.ok) {
    return markerSynced;
  }

  const heldBeforeCleanup = input.lock.checkHeld();
  if (!heldBeforeCleanup.ok) {
    return heldBeforeCleanup;
  }
  const cleaned = await cleanupPendingTargetStaging({
    targetId: state.targetId,
    targetRoot,
    lock: input.lock,
    registry: input.registry
  });
  if (!cleaned.ok) {
    return cleaned;
  }

  return {
    ok: true,
    value: {
      status: "post-commit-recovered",
      targetId: state.targetId,
      operationId: pending.operationId,
      state,
      marker
    }
  };
}

type PartitionedPendingActions = Readonly<{
  managed: RegistryPendingOperation["actions"];
  user: ReadonlyArray<Readonly<{
    stagingPath: string;
    manifest: ImportUserRecoveryManifest;
  }>>;
}>;

async function partitionPendingActions(
  pending: RegistryPendingOperation,
  targetId: string
): Promise<
  Result<PartitionedPendingActions, ImportUserStagingFailed>
> {
  const managed: RegistryPendingOperation["actions"][number][] = [];
  const user: Array<{
    stagingPath: string;
    manifest: ImportUserRecoveryManifest;
  }> = [];

  for (const action of pending.actions) {
    const manifest = await readImportUserRecoveryManifest(
      action.stagingPath,
      {
        operationId: pending.operationId,
        targetId,
        activationName: action.activationName
      }
    );
    if (!manifest.ok) {
      return manifest;
    }
    if (manifest.value === null) {
      managed.push(action);
    } else {
      user.push({
        stagingPath: action.stagingPath,
        manifest: manifest.value
      });
    }
  }

  return {
    ok: true,
    value: {
      managed,
      user
    }
  };
}

function conflict(
  targetId: string,
  operationId: string | null,
  phase: InterruptedExactImportRecoveryConflict["facts"]["phase"],
  reason: InterruptedExactImportRecoveryConflictReason,
  registryGeneration: number | null,
  baseGeneration: number | null,
  nextGeneration: number | null,
  subject: string | null
): Result<never, InterruptedExactImportRecoveryConflict> {
  return {
    ok: false,
    error: productError(
      "InterruptedExactImportRecoveryConflict",
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
