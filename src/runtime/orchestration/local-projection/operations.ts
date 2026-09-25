import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

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
import {
  preflightTargetOwnership,
  type TargetOwnedProjection,
  type TargetPathObservation
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
  verifyManagedProjection
} from "../../target-projection/index.js";
import {
  planForgottenDetachedProjectionState
} from "../detached-binding.js";
import {
  detachTargetProjection,
  rebindDetachedProjection
} from "../detached-lifecycle.js";
import {
  planLifecycleTarget,
  projectionMaterialization,
  projectionTransformJson
} from "../lifecycle/apply.js";
import {
  preserveAcceptedProjectionAbsence,
  projectionRenames,
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
  cleanupPendingTargetStaging,
  prepareTargetReconciliation
} from "../target-reconcile.js";
import {
  targetStateMarkerFactsFromRegistryState
} from "../../target-state-recovery.js";

export type InvalidLocalProjectionOperation = ProductError<
  "InvalidLocalProjectionOperation",
  Readonly<{
    packageCoordinate: string;
    reason:
      | "target-not-found"
      | "target-location-mismatch"
      | "projection-not-found"
      | "projection-not-managed"
      | "planned-projection-not-found"
      | "detached-projection-would-change";
  }>
>;

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

  const currentPlan = acceptedTargetPlan(accepted.value);
  if (!currentPlan.ok) {
    return currentPlan;
  }
  const currentOwned = ownedProjections(
    accepted.value,
    currentPlan.value
  );
  if (!currentOwned.ok) {
    return currentOwned;
  }
  const observed = await observeTarget(
    input.home,
    resolve(input.targetRoot),
    currentOwned.value,
    desired.value
  );
  if (!observed.ok) {
    return observed;
  }
  const preflight = preflightTargetOwnership({
    desiredPlan: desired.value,
    currentProjections: currentOwned.value,
    observedPaths: observed.value
  });
  if (!preflight.ok) {
    return preflight;
  }

  const nextState = projectionStateForPlan(
    accepted.value,
    resolve(input.targetRoot),
    desired.value
  );
  if (!nextState.ok) {
    return nextState;
  }

  const operationId = (input.createOperationId ?? randomUUID)();
  const prepared = await prepareTargetReconciliation({
    home: input.home,
    targetRoot: resolve(input.targetRoot),
    operationId,
    lock: input.lock,
    registry: input.registry,
    desiredPlan: desired.value,
    preflight: preflight.value,
    currentProjections: currentOwned.value,
    nextState: nextState.value,
    deferPendingCompletion: true
  });
  if (!prepared.ok) {
    return prepared;
  }

  const committed =
    await prepared.value.commitAcceptedState();
  if (!committed.ok) {
    return committed;
  }
  const reconciled =
    await committed.value.reconcileLiveTarget();
  if (!reconciled.ok) {
    return reconciled;
  }

  const marker = await syncMarkerFromState(
    input.targetRoot,
    reconciled.value
  );
  if (!marker.ok) {
    return marker;
  }

  const cleaned = await cleanupPendingTargetStaging({
    targetId: reconciled.value.targetId,
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
  const rebound = await rebindDetachedProjection({
    targetRoot: resolve(input.targetRoot),
    lock: input.lock,
    registry: input.registry,
    acceptedState: registryStateInput(accepted.value),
    packageCoordinate: input.packageCoordinate,
    activationName: input.activationName
  });
  if (!rebound.ok) {
    return rebound;
  }
  const marker = await syncMarkerFromState(
    input.targetRoot,
    rebound.value
  );
  if (!marker.ok) {
    return marker;
  }
  return {
    ok: true,
    value: {
      status: "rebound",
      state: rebound.value
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
  const provisionalState: RegistryTargetState = {
    ...accepted.value,
    projections: provisional.value.projections,
    detachedBaselines: provisional.value.detachedBaselines
  };

  const requirements = registryRequirementsToDomain(
    provisionalState.targetId,
    provisionalState.directRequirements
  );
  if (!requirements.ok) {
    return requirements;
  }
  const candidate = registryGraph(provisionalState);
  const planned = planLifecycleTarget(
    requirements.value,
    candidate,
    projectionRenames(provisionalState.projections)
  );
  if (!planned.ok) {
    return planned;
  }
  const desired = preserveAcceptedProjectionAbsence(
    provisionalState,
    planned.value
  );

  const currentPlan = acceptedTargetPlan(accepted.value);
  if (!currentPlan.ok) {
    return currentPlan;
  }
  const currentOwned = ownedProjections(
    accepted.value,
    currentPlan.value
  );
  if (!currentOwned.ok) {
    return currentOwned;
  }
  const observed = await observeTarget(
    input.home,
    resolve(input.targetRoot),
    currentOwned.value,
    desired
  );
  if (!observed.ok) {
    return observed;
  }
  const preflight = preflightTargetOwnership({
    desiredPlan: desired,
    currentProjections: currentOwned.value,
    observedPaths: observed.value
  });
  if (!preflight.ok) {
    return preflight;
  }

  const plannedState = projectionStateForPlan(
    accepted.value,
    resolve(input.targetRoot),
    desired
  );
  if (!plannedState.ok) {
    return plannedState;
  }
  const nextState: RegistryTargetStateInput = {
    ...plannedState.value,
    detachedBaselines: provisional.value.detachedBaselines
  };

  const prepared = await prepareTargetReconciliation({
    home: input.home,
    targetRoot: resolve(input.targetRoot),
    operationId: (input.createOperationId ?? randomUUID)(),
    lock: input.lock,
    registry: input.registry,
    desiredPlan: desired,
    preflight: preflight.value,
    currentProjections: currentOwned.value,
    nextState,
    deferPendingCompletion: true
  });
  if (!prepared.ok) {
    return prepared;
  }

  const committed =
    await prepared.value.commitAcceptedState();
  if (!committed.ok) {
    return committed;
  }
  const reconciled =
    await committed.value.reconcileLiveTarget();
  if (!reconciled.ok) {
    return reconciled;
  }

  const marker = await syncMarkerFromState(
    input.targetRoot,
    reconciled.value
  );
  if (!marker.ok) {
    return marker;
  }

  const cleaned = await cleanupPendingTargetStaging({
    targetId: reconciled.value.targetId,
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

async function observeTarget(
  home: SkiloomHomePaths,
  targetRoot: string,
  current: ReadonlyArray<TargetOwnedProjection>,
  desired: TargetPlan
): Promise<
  Result<ReadonlyArray<TargetPathObservation>, ProductError>
> {
  const observations: TargetPathObservation[] = [];
  const observed = new Set<string>();

  for (const owned of current) {
    const activationPath = join(
      targetRoot,
      owned.projection.activationName
    );
    if (owned.ownership === "detached") {
      if (await pathExists(activationPath)) {
        observations.push({
          activationName: owned.projection.activationName,
          kind: "existing"
        });
        observed.add(owned.projection.activationName);
      }
      continue;
    }

    const verified = await verifyManagedProjection({
      home,
      targetRoot,
      expected: {
        projection: owned.projection,
        materialization: owned.materialization
      }
    });
    if (verified.ok) {
      observations.push({
        activationName: owned.projection.activationName,
        kind: "managed",
        packageCoordinate:
          owned.projection.packageCoordinate,
        contentDigest: owned.projection.contentDigest,
        materialization: owned.materialization,
        expectedViewMatches: true
      });
      observed.add(owned.projection.activationName);
      continue;
    }
    if (verified.error.code === "ManagedProjectionMissing") {
      continue;
    }
    return verified;
  }

  for (const projection of desired.projections) {
    if (observed.has(projection.activationName)) {
      continue;
    }
    if (
      await pathExists(
        join(targetRoot, projection.activationName)
      )
    ) {
      observations.push({
        activationName: projection.activationName,
        kind: "existing"
      });
      observed.add(projection.activationName);
    }
  }

  return {
    ok: true,
    value: observations
  };
}

function projectionStateForPlan(
  current: RegistryTargetState,
  targetRoot: string,
  desired: TargetPlan
): Result<
  RegistryTargetStateInput,
  InvalidLocalProjectionOperation
> {
  const currentByPackage = new Map(
    current.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  const next = [];
  for (const projection of desired.projections) {
    const existing = currentByPackage.get(
      projection.packageCoordinate
    );
    if (existing === undefined) {
      return invalidLocal(
        projection.packageCoordinate,
        "projection-not-found"
      );
    }

    if (existing.ownership === "detached") {
      if (
        existing.activationName !== projection.activationName ||
        existing.transformJson !==
          projectionTransformJson(projection)
      ) {
        return invalidLocal(
          projection.packageCoordinate,
          "detached-projection-would-change"
        );
      }
      next.push(existing);
      continue;
    }

    next.push({
      packageCoordinate: projection.packageCoordinate,
      activationName: projection.activationName,
      ownership: "managed" as const,
      materialization:
        projection.transform === null
          ? existing.materialization
          : projectionMaterialization(projection),
      transformJson: projectionTransformJson(projection)
    });
  }

  return {
    ok: true,
    value: {
      targetId: current.targetId,
      locations: current.locations.map((location) => ({
        ...location,
        path:
          resolve(location.path) === resolve(targetRoot)
            ? resolve(targetRoot)
            : location.path
      })),
      directRequirements: current.directRequirements,
      resolvedSources: current.resolvedSources,
      resolvedPackages: current.resolvedPackages,
      dependencyEdges: current.dependencyEdges,
      projections: next,
      detachedBaselines: current.detachedBaselines,
      dependencyObservations: current.dependencyObservations
    }
  };
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

async function pathExists(path: string): Promise<boolean> {
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
