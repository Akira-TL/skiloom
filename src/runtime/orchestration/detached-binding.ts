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

export type PlanForgottenDetachedProjectionStateInput = Readonly<{
  acceptedState: RegistryTargetStateInput;
  packageCoordinate: string;
}>;

export type PruneUnreachableDetachedBindingsInput = Readonly<{
  lock: OperationLockSession;
  registry: MachineRegistry;
  acceptedState: RegistryTargetStateInput;
  unreachablePackageCoordinates: ReadonlyArray<string>;
}>;

export async function forgetDetachedProjection(
  input: ForgetDetachedProjectionInput
): Promise<Result<RegistryTargetState, DetachedBindingError>> {
  const accepted = validateAcceptedState(input);
  if (!accepted.ok) {
    return accepted;
  }
  const planned = planForgottenDetachedProjectionState({
    acceptedState: input.acceptedState,
    packageCoordinate: input.packageCoordinate
  });
  if (!planned.ok) {
    return planned;
  }

  return input.registry.replaceTargetState(planned.value);
}

export function planForgottenDetachedProjectionState(
  input: PlanForgottenDetachedProjectionStateInput
): Result<RegistryTargetStateInput, InvalidDetachedBindingInput> {
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

  return {
    ok: true,
    value: {
      ...input.acceptedState,
      projections: input.acceptedState.projections.filter(
        (candidate) =>
          candidate.packageCoordinate !== input.packageCoordinate
      ),
      detachedBaselines: input.acceptedState.detachedBaselines.filter(
        (baseline) =>
          baseline.packageCoordinate !== input.packageCoordinate
      )
    }
  };
}

export async function pruneUnreachableDetachedBindings(
  input: PruneUnreachableDetachedBindingsInput
): Promise<Result<RegistryTargetState, DetachedBindingError>> {
  const accepted = validateAcceptedState(input);
  if (!accepted.ok) {
    return accepted;
  }

  const directRoots = directRootPackages(input.acceptedState);
  const unreachable = new Set(input.unreachablePackageCoordinates);
  const removable = new Set(
    input.acceptedState.projections
      .filter(
        (projection) =>
          projection.ownership === "detached" &&
          unreachable.has(projection.packageCoordinate) &&
          !directRoots.has(projection.packageCoordinate)
      )
      .map((projection) => projection.packageCoordinate)
  );

  if (removable.size === 0) {
    return { ok: true, value: accepted.value };
  }

  const nextState: RegistryTargetStateInput = {
    ...input.acceptedState,
    projections: input.acceptedState.projections.filter(
      (projection) => !removable.has(projection.packageCoordinate)
    ),
    detachedBaselines: input.acceptedState.detachedBaselines.filter(
      (baseline) => !removable.has(baseline.packageCoordinate)
    )
  };

  return input.registry.replaceTargetState(nextState);
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

function directRootPackages(
  state: RegistryTargetStateInput
): ReadonlySet<string> {
  const direct = new Set<string>();

  for (const requirement of state.directRequirements) {
    if (requirement.kind === "package") {
      direct.add(requirement.coordinate);
      continue;
    }

    for (const packageFact of state.resolvedPackages) {
      if (
        packageFact.repositoryCoordinate === requirement.coordinate
      ) {
        direct.add(packageFact.packageCoordinate);
      }
    }
  }

  return direct;
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
