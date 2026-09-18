import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import type { OperationLockLost, OperationLockSession } from "../../native/skiloom-lock.js";
import type {
  MachineRegistry,
  RegistryReplaceLockedError,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../registry/index.js";
import { sameAcceptedState } from "./target-reconcile-state.js";

export type InvalidDetachedBindingInputReason =
  | "accepted-state-mismatch"
  | "projection-not-found"
  | "projection-not-detached"
  | "detached-baseline-missing";

export type InvalidDetachedBindingInput = ProductError<
  "InvalidDetachedBindingInput",
  Readonly<{
    packageCoordinate: string;
    reason: InvalidDetachedBindingInputReason;
  }>
>;

export type DetachedBindingError =
  | InvalidDetachedBindingInput
  | RegistryReplaceLockedError
  | OperationLockLost;

export type ForgetDetachedProjectionInput = Readonly<{
  lock: OperationLockSession;
  registry: MachineRegistry;
  acceptedState: RegistryTargetStateInput;
  packageCoordinate: string;
}>;

export async function forgetDetachedProjection(
  input: ForgetDetachedProjectionInput
): Promise<Result<RegistryTargetState, DetachedBindingError>> {
  const validated = validateDetachedBinding(input);
  if (!validated.ok) {
    return validated;
  }

  const nextState: RegistryTargetStateInput = {
    ...input.acceptedState,
    projections: input.acceptedState.projections.filter(
      (projection) =>
        projection.packageCoordinate !== input.packageCoordinate
    ),
    detachedBaselines: input.acceptedState.detachedBaselines.filter(
      (baseline) =>
        baseline.packageCoordinate !== input.packageCoordinate
    )
  };

  return input.registry.replaceTargetState(nextState);
}

function validateDetachedBinding(
  input: ForgetDetachedProjectionInput
): Result<true, InvalidDetachedBindingInput | OperationLockLost> {
  const accepted = validateAcceptedState(input);
  if (!accepted.ok) {
    return accepted;
  }

  const projection = input.acceptedState.projections.find(
    (candidate) =>
      candidate.packageCoordinate === input.packageCoordinate
  );
  if (projection === undefined) {
    return invalidDetached(
      input.packageCoordinate,
      "projection-not-found"
    );
  }
  if (projection.ownership !== "detached") {
    return invalidDetached(
      input.packageCoordinate,
      "projection-not-detached"
    );
  }
  if (
    !input.acceptedState.detachedBaselines.some(
      (baseline) =>
        baseline.packageCoordinate === input.packageCoordinate
    )
  ) {
    return invalidDetached(
      input.packageCoordinate,
      "detached-baseline-missing"
    );
  }

  return { ok: true, value: true };
}

function validateAcceptedState(input: Readonly<{
  lock: OperationLockSession;
  registry: MachineRegistry;
  acceptedState: RegistryTargetStateInput;
}>): Result<RegistryTargetState, InvalidDetachedBindingInput | OperationLockLost> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const accepted = input.registry.readTargetState(
    input.acceptedState.targetId
  );
  if (!accepted.ok) {
    return accepted;
  }
  if (
    accepted.value === undefined ||
    !sameAcceptedState(accepted.value, input.acceptedState)
  ) {
    return invalidDetached("", "accepted-state-mismatch");
  }
  return { ok: true, value: accepted.value };
}

function invalidDetached(
  packageCoordinate: string,
  reason: InvalidDetachedBindingInputReason
): Result<never, InvalidDetachedBindingInput> {
  return {
    ok: false,
    error: productError("InvalidDetachedBindingInput", {
      packageCoordinate,
      reason
    })
  };
}
