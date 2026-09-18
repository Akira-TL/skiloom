
import { resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../../../domain/errors/index.js";
import type {
  TargetPlanError
} from "../../../../domain/target/index.js";
import type {
  TargetRecoveryMarkerFacts
} from "../../../../domain/target/recovery.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../../../native/skiloom-lock.js";
import type {
  SkiloomHomePaths
} from "../../../home.js";
import type {
  MachineRegistry,
  RegistryTargetState
} from "../../../registry/index.js";
import type {
  ManagedProjectionRuntimeError,
  ManagedProjectionVerificationError
} from "../../../target-projection/index.js";
import {
  cleanupPendingTargetStaging,
  type TargetReconciliationError
} from "../../target-reconcile.js";
import type {
  LifecycleMarkerSyncFailed
} from "../first-install.js";
import type {
  InvalidTargetReconciliationRecoveryManifest
} from "../../target-reconcile/recovery.js";

import {
  buildMarkerFacts
} from "../apply.js";
import {
  acceptedTargetPlan,
  convergeAcceptedTarget,
  readRecoveryActions
} from "./target.js";

export type InterruptedLifecycleRecoveryConflictReason =
  | "multiple-pending-operations"
  | "target-not-found"
  | "generation-mismatch"
  | "target-location-mismatch"
  | "unsafe-pending-staging-path"
  | "pending-action-mismatch"
  | "accepted-projection-mismatch"
  | "unproven-live-drift";

export type InterruptedLifecycleRecoveryConflict = ProductError<
  "InterruptedLifecycleRecoveryConflict",
  Readonly<{
    targetId: string;
    operationId: string | null;
    phase: "classify" | "pre-commit" | "post-commit";
    reason: InterruptedLifecycleRecoveryConflictReason;
    registryGeneration: number | null;
    baseGeneration: number | null;
    nextGeneration: number | null;
    subject: string | null;
  }>
>;

export type InterruptedLifecycleRecoveryError =
  | OperationLockLost
  | InterruptedLifecycleRecoveryConflict
  | InvalidTargetReconciliationRecoveryManifest
  | TargetPlanError
  | ManagedProjectionRuntimeError
  | ManagedProjectionVerificationError
  | LifecycleMarkerSyncFailed
  | TargetReconciliationError;

export type InterruptedLifecycleRecoveryResult =
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

export type RecoverInterruptedLifecycleInput = Readonly<{
  home: SkiloomHomePaths;
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  syncMarker: (
    marker: TargetRecoveryMarkerFacts
  ) => void | Promise<void>;
}>;


export async function recoverInterruptedLifecycle(
  input: RecoverInterruptedLifecycleInput
): Promise<
  Result<
    InterruptedLifecycleRecoveryResult,
    InterruptedLifecycleRecoveryError
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

  const actions = await readRecoveryActions(
    targetRoot,
    state,
    pending
  );
  if (!actions.ok) {
    return actions;
  }

  const recovered = await convergeAcceptedTarget(
    input,
    state,
    desiredPlan.value,
    pending,
    actions.value
  );
  if (!recovered.ok) {
    return recovered;
  }

  const heldBeforeMarker = input.lock.checkHeld();
  if (!heldBeforeMarker.ok) {
    return heldBeforeMarker;
  }

  const marker = buildMarkerFacts(
    state,
    desiredPlan.value
  );
  try {
    await input.syncMarker(marker);
  } catch {
    return {
      ok: false,
      error: productError(
        "LifecycleMarkerSyncFailed",
        {
          targetId: state.targetId,
          generation: state.generation
        }
      )
    };
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
