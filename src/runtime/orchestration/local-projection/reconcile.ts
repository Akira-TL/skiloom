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
import type { OperationLockSession } from "../../../native/skiloom-lock.js";
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
  planLifecycleTarget,
  projectionMaterialization,
  projectionTransformJson
} from "../lifecycle/apply.js";
import {
  preserveAcceptedProjectionAbsence,
  projectionRenames
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

export type ReconcileLocalProjectionStateChangeInput = Readonly<{
  home: SkiloomHomePaths;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  currentState: RegistryTargetState;
  provisionalState: RegistryTargetState;
  createOperationId?: () => string;
}>;

export async function reconcileLocalProjectionStateChange(
  input: ReconcileLocalProjectionStateChangeInput
): Promise<Result<RegistryTargetState, ProductError>> {
  const requirements = registryRequirementsToDomain(
    input.provisionalState.targetId,
    input.provisionalState.directRequirements
  );
  if (!requirements.ok) {
    return requirements;
  }

  const candidate = registryGraph(input.provisionalState);
  const planned = planLifecycleTarget(
    requirements.value,
    candidate,
    projectionRenames(input.provisionalState.projections)
  );
  if (!planned.ok) {
    return planned;
  }
  const desired = preserveAcceptedProjectionAbsence(
    input.provisionalState,
    planned.value
  );

  const currentPlan = acceptedTargetPlan(input.currentState);
  if (!currentPlan.ok) {
    return currentPlan;
  }
  const currentOwned = ownedProjections(
    input.currentState,
    currentPlan.value
  );
  if (!currentOwned.ok) {
    return currentOwned;
  }

  const targetRoot = resolve(input.targetRoot);
  const observed = await observeTarget(
    input.home,
    targetRoot,
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

  const nextState = projectionStateForPlan(
    input.provisionalState,
    targetRoot,
    desired
  );
  if (!nextState.ok) {
    return nextState;
  }

  const prepared = await prepareTargetReconciliation({
    home: input.home,
    targetRoot,
    operationId: (input.createOperationId ?? randomUUID)(),
    lock: input.lock,
    registry: input.registry,
    desiredPlan: desired,
    preflight: preflight.value,
    currentProjections: currentOwned.value,
    nextState: nextState.value,
    deferPendingCompletion: true
  });
  if (!prepared.ok) {
    return prepared;
  }

  const committed = await prepared.value.commitAcceptedState();
  if (!committed.ok) {
    return committed;
  }
  const reconciled = await committed.value.reconcileLiveTarget();
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
    targetRoot,
    lock: input.lock,
    registry: input.registry
  });
  if (!cleaned.ok) {
    return cleaned;
  }
  return { ok: true, value: reconciled.value };
}

export function projectionStateForPlan(
  current: RegistryTargetState,
  targetRoot: string,
  desired: TargetPlan
): Result<RegistryTargetStateInput, InvalidLocalProjectionOperation> {
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
      if (existing.activationName !== projection.activationName) {
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
        packageCoordinate: owned.projection.packageCoordinate,
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
