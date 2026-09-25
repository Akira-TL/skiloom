import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  ResolverCandidateGraph
} from "../../../domain/resolver/index.js";
import type {
  TargetPlan
} from "../../../domain/target/index.js";
import type {
  TargetOwnedProjection
} from "../../../domain/target/preflight.js";
import type {
  OperationLockSession
} from "../../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../../home.js";
import type {
  MachineRegistry,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../../registry/index.js";
import {
  planForgottenDetachedProjectionState
} from "../detached-binding.js";
import {
  detachTargetProjection,
  planReboundDetachedProjectionState
} from "../detached-lifecycle.js";
import {
  planLifecycleTarget
} from "../lifecycle/apply.js";
import {
  requestedRenames
} from "../lifecycle/projection/plan.js";
import {
  acceptedTargetPlan
} from "../lifecycle/recovery/target.js";
import {
  registryRequirementsToDomain
} from "../lifecycle/requirements.js";
import {
  syncLifecycleMarker
} from "../lifecycle/marker/index.js";
import {
  projectionStateForPlan,
  reconcileLocalProjectionStateChange,
  type InvalidLocalProjectionOperation
} from "./reconcile.js";

export type { InvalidLocalProjectionOperation } from "./reconcile.js";
import {
  targetStateMarkerFactsFromRegistryState
} from "../../target-state-recovery.js";

export type LocalProjectionOperationResult = Readonly<{
  status:
    | "no-op"
    | "renamed"
    | "detached"
    | "rebound"
    | "forgotten";
  state: RegistryTargetState;
}>;

type LocalProjectionBaseInput = Readonly<{
  home: SkiloomHomePaths;
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  packageCoordinate: string;
}>;

export type RenameAcceptedProjectionInput =
  LocalProjectionBaseInput &
  Readonly<{
    activationName: string;
    createOperationId?: () => string;
  }>;

export type DetachAcceptedProjectionInput =
  LocalProjectionBaseInput &
  Readonly<{
    createOperationId?: () => string;
  }>;

export type RebindAcceptedProjectionInput =
  LocalProjectionBaseInput &
  Readonly<{
    activationName: string;
  }>;

export type ForgetAcceptedProjectionInput =
  LocalProjectionBaseInput &
  Readonly<{
    createOperationId?: () => string;
  }>;

export async function renameAcceptedProjection(
  input: RenameAcceptedProjectionInput
): Promise<Result<LocalProjectionOperationResult, ProductError>> {
  const accepted = readAcceptedState(input);
  if (!accepted.ok) {
    return accepted;
  }
  const currentProjection = accepted.value.projections.find(
    (projection) =>
      projection.packageCoordinate === input.packageCoordinate
  );
  if (currentProjection === undefined) {
    return invalidLocal(
      input.packageCoordinate,
      "projection-not-found"
    );
  }
  if (currentProjection.ownership !== "managed") {
    return invalidLocal(
      input.packageCoordinate,
      "projection-not-managed"
    );
  }
  if (currentProjection.activationName === input.activationName) {
    const marker = await syncMarkerFromState(
      input.targetRoot,
      accepted.value
    );
    return marker.ok
      ? {
          ok: true,
          value: {
            status: "no-op",
            state: accepted.value
          }
        }
      : marker;
  }

  const requirements = registryRequirementsToDomain(
    accepted.value.targetId,
    accepted.value.directRequirements
  );
  if (!requirements.ok) {
    return requirements;
  }
  const candidate = registryGraph(accepted.value);
  const desired = planLifecycleTarget(
    requirements.value,
    candidate,
    requestedRenames(
      accepted.value,
      candidate,
      {
        packageCoordinate: input.packageCoordinate,
        activationName: input.activationName
      }
    )
  );
  if (!desired.ok) {
    return desired;
  }

  const provisional = projectionStateForPlan(
    accepted.value,
    resolve(input.targetRoot),
    desired.value
  );
  if (!provisional.ok) {
    return provisional;
  }
  const reconciled = await reconcileLocalProjectionStateChange({
    home: input.home,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry,
    currentState: accepted.value,
    provisionalState: {
      ...accepted.value,
      ...provisional.value
    },
    ...(input.createOperationId === undefined
      ? {}
      : { createOperationId: input.createOperationId })
  });
  if (!reconciled.ok) {
    return reconciled;
  }

  return {
    ok: true,
    value: {
      status: "renamed",
      state: reconciled.value
    }
  };
}

export async function detachAcceptedProjection(
  input: DetachAcceptedProjectionInput
): Promise<Result<LocalProjectionOperationResult, ProductError>> {
  const accepted = readAcceptedState(input);
  if (!accepted.ok) {
    return accepted;
  }
  const plan = acceptedTargetPlan(accepted.value);
  if (!plan.ok) {
    return plan;
  }
  const current = ownedProjection(
    accepted.value,
    plan.value,
    input.packageCoordinate
  );
  if (!current.ok) {
    return current;
  }

  const detached = await detachTargetProjection({
    home: input.home,
    targetRoot: resolve(input.targetRoot),
    operationId:
      (input.createOperationId ?? randomUUID)(),
    lock: input.lock,
    registry: input.registry,
    acceptedState: registryStateInput(accepted.value),
    packageCoordinate: input.packageCoordinate,
    current: current.value
  });
  if (!detached.ok) {
    return detached;
  }
  const marker = await syncMarkerFromState(
    input.targetRoot,
    detached.value
  );
  if (!marker.ok) {
    return marker;
  }
  return {
    ok: true,
    value: {
      status: "detached",
      state: detached.value
    }
  };
}

export async function rebindAcceptedProjection(
  input: RebindAcceptedProjectionInput
): Promise<Result<LocalProjectionOperationResult, ProductError>> {
  const accepted = readAcceptedState(input);
  if (!accepted.ok) {
    return accepted;
  }
  const provisional = await planReboundDetachedProjectionState({
    targetRoot: resolve(input.targetRoot),
    acceptedState: registryStateInput(accepted.value),
    packageCoordinate: input.packageCoordinate,
    activationName: input.activationName
  });
  if (!provisional.ok) {
    return provisional;
  }

  const reconciled = await reconcileLocalProjectionStateChange({
    home: input.home,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry,
    currentState: accepted.value,
    provisionalState: {
      ...accepted.value,
      ...provisional.value
    }
  });
  if (!reconciled.ok) {
    return reconciled;
  }
  return {
    ok: true,
    value: {
      status: "rebound",
      state: reconciled.value
    }
  };
}

export async function forgetAcceptedProjection(
  input: ForgetAcceptedProjectionInput
): Promise<Result<LocalProjectionOperationResult, ProductError>> {
  const accepted = readAcceptedState(input);
  if (!accepted.ok) {
    return accepted;
  }

  const provisional = planForgottenDetachedProjectionState({
    acceptedState: registryStateInput(accepted.value),
    packageCoordinate: input.packageCoordinate
  });
  if (!provisional.ok) {
    return provisional;
  }

  const reconciled = await reconcileLocalProjectionStateChange({
    home: input.home,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry,
    currentState: accepted.value,
    provisionalState: {
      ...accepted.value,
      ...provisional.value
    },
    ...(input.createOperationId === undefined
      ? {}
      : { createOperationId: input.createOperationId })
  });
  if (!reconciled.ok) {
    return reconciled;
  }

  return {
    ok: true,
    value: {
      status: "forgotten",
      state: reconciled.value
    }
  };
}

function readAcceptedState(
  input: LocalProjectionBaseInput
): Result<RegistryTargetState, ProductError> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }
  const read = input.registry.readTargetState(input.targetId);
  if (!read.ok) {
    return read;
  }
  if (read.value === undefined) {
    return invalidLocal(
      input.packageCoordinate,
      "target-not-found"
    );
  }
  if (
    !read.value.locations.some(
      (location) =>
        resolve(location.path) === resolve(input.targetRoot)
    )
  ) {
    return invalidLocal(
      input.packageCoordinate,
      "target-location-mismatch"
    );
  }
  return { ok: true, value: read.value };
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

function ownedProjections(
  state: RegistryTargetState,
  plan: TargetPlan
): Result<
  ReadonlyArray<TargetOwnedProjection>,
  InvalidLocalProjectionOperation
> {
  const byPackage = new Map(
    plan.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  const result: TargetOwnedProjection[] = [];
  for (const registryProjection of state.projections) {
    const projection = byPackage.get(
      registryProjection.packageCoordinate
    );
    if (projection === undefined) {
      return invalidLocal(
        registryProjection.packageCoordinate,
        "planned-projection-not-found"
      );
    }
    result.push({
      projection,
      ownership: registryProjection.ownership,
      materialization: registryProjection.materialization
    });
  }
  return { ok: true, value: result };
}

function ownedProjection(
  state: RegistryTargetState,
  plan: TargetPlan,
  packageCoordinate: string
): Result<
  TargetOwnedProjection,
  InvalidLocalProjectionOperation
> {
  const owned = ownedProjections(state, plan);
  if (!owned.ok) {
    return owned;
  }
  const projection = owned.value.find(
    (entry) =>
      entry.projection.packageCoordinate === packageCoordinate
  );
  return projection === undefined
    ? invalidLocal(
        packageCoordinate,
        "projection-not-found"
      )
    : { ok: true, value: projection };
}

async function syncMarkerFromState(
  targetRoot: string,
  state: RegistryTargetState
): Promise<Result<void, ProductError>> {
  const facts =
    targetStateMarkerFactsFromRegistryState(state);
  if (!facts.ok) {
    return facts;
  }
  return syncLifecycleMarker({
    targetRoot: resolve(targetRoot),
    marker: facts.value
  });
}

function registryStateInput(
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

function invalidLocal(
  packageCoordinate: string,
  reason: InvalidLocalProjectionOperation["facts"]["reason"]
): Result<never, InvalidLocalProjectionOperation> {
  return {
    ok: false,
    error: productError("InvalidLocalProjectionOperation", {
      packageCoordinate,
      reason
    })
  };
}
