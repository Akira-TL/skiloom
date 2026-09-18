import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parsePackageCoordinate
} from "../../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  DirectInstallRequirement,
  ResolverCandidateGraph
} from "../../../domain/resolver/index.js";
import type {
  TargetPlan,
  TargetPlanError,
  TargetProjectionRename
} from "../../../domain/target/index.js";
import {
  preflightTargetOwnership,
  type TargetOwnedProjection,
  type TargetOwnershipPreflightError,
  type TargetPathObservation
} from "../../../domain/target/preflight.js";
import type { TargetRecoveryMarkerFacts } from "../../../domain/target/recovery.js";
import type {
  InteractionRequired
} from "../../../domain/lifecycle/index.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../../home.js";
import type {
  MachineRegistry,
  RegistryProjection,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../../registry/index.js";
import type { PackageStoreError } from "../../store.js";
import {
  verifyManagedProjection,
  type ManagedProjectionVerificationError
} from "../../target-projection/index.js";
import type {
  GitHubJsonTransport,
  GitHubRepositoryTransport
} from "../../source/github/index.js";
import {
  computeLifecycleCandidate,
  type LifecycleCandidateError,
  type LifecycleCandidatePlan
} from "../lifecycle-candidate.js";
import {
  cleanupPendingTargetStaging,
  prepareTargetReconciliation,
  type TargetReconciliationError
} from "../target-reconcile.js";
import {
  acquireLifecycleCandidatePackageSnapshots,
  buildMarkerFacts,
  planLifecycleTarget,
  projectionMaterialization,
  projectionTransformJson,
  publishLifecycleCandidateSnapshots,
  registryDirectRequirement,
  registryResolvedSource,
  repositoryFromPackageCoordinate,
  type LifecycleCandidateSnapshotError
} from "./apply.js";
import {
  resolveLifecycleCandidateAcceptance,
  type LifecycleCandidateAcceptanceCallback
} from "./acceptance.js";
import {
  registryRequirementsToDomain
} from "./requirements.js";
import type {
  LifecycleInstallAcceptanceFailed
} from "./first-install.js";
import {
  syncLifecycleMarker,
  type LifecycleMarkerSyncCallback,
  type LifecycleMarkerSyncFailed
} from "./marker/index.js";

export type InvalidAcceptedRequirementChangeState = ProductError<
  "InvalidAcceptedRequirementChangeState",
  Readonly<{
    targetId: string;
    reason:
      | "target-not-found"
      | "target-location-mismatch"
      | "invalid-direct-requirement"
      | "missing-registry-projection"
      | "missing-current-projection"
      | "projection-mismatch";
  }>
>;

export type AcceptedRequirementChangeError =
  | LifecycleCandidateError
  | LifecycleCandidateSnapshotError
  | OperationLockLost
  | LifecycleInstallAcceptanceFailed
  | LifecycleMarkerSyncFailed
  | InteractionRequired
  | InvalidAcceptedRequirementChangeState
  | TargetPlanError
  | TargetOwnershipPreflightError
  | ManagedProjectionVerificationError
  | PackageStoreError
  | TargetReconciliationError;

export type AcceptedRequirementChangeResult =
  | Readonly<{
      status: "no-op";
      plan: LifecycleCandidatePlan;
      state: RegistryTargetState;
    }>
  | Readonly<{
      status: "planned";
      plan: LifecycleCandidatePlan;
      state: RegistryTargetState;
    }>
  | Readonly<{
      status: "declined";
      plan: LifecycleCandidatePlan;
      state: RegistryTargetState;
    }>
  | Readonly<{
      status: "applied";
      plan: LifecycleCandidatePlan;
      state: RegistryTargetState;
      marker: TargetRecoveryMarkerFacts;
    }>;

export type AcceptedRequirementChangeInput = Readonly<{
  home: SkiloomHomePaths;
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  mutateRequirements: (
    current: ReadonlyArray<DirectInstallRequirement>
  ) => ReadonlyArray<DirectInstallRequirement>;
  credential?: string;
  signal?: AbortSignal;
  sourceCachePath?: string;
  repositoryTransport: GitHubRepositoryTransport;
  transport: GitHubJsonTransport;
  acceptCandidate: LifecycleCandidateAcceptanceCallback;
  syncMarker?: LifecycleMarkerSyncCallback;
  createOperationId?: () => string;
}>;

export async function applyAcceptedRequirementChange(
  input: AcceptedRequirementChangeInput
): Promise<
  Result<AcceptedRequirementChangeResult, AcceptedRequirementChangeError>
> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const currentRead = input.registry.readTargetState(input.targetId);
  if (!currentRead.ok) {
    return currentRead;
  }
  if (currentRead.value === undefined) {
    return invalidState(input.targetId, "target-not-found");
  }
  const current = currentRead.value;
  const targetRoot = resolve(input.targetRoot);
  if (
    !current.locations.some(
      (location) => resolve(location.path) === targetRoot
    )
  ) {
    return invalidState(input.targetId, "target-location-mismatch");
  }

  const currentRequirements = registryRequirementsToDomain(
    current.targetId,
    current.directRequirements
  );
  if (!currentRequirements.ok) {
    return currentRequirements;
  }

  const planned = await computeLifecycleCandidate({
    directRequirements: input.mutateRequirements(
      currentRequirements.value
    ),
    currentState: current,
    repositoryTransport: input.repositoryTransport,
    transport: input.transport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential }),
    ...(input.signal === undefined
      ? {}
      : { signal: input.signal }),
    ...(input.sourceCachePath === undefined
      ? {}
      : { sourceCachePath: input.sourceCachePath })
  });
  if (!planned.ok) {
    return planned;
  }

  const heldAfterPlanning = input.lock.checkHeld();
  if (!heldAfterPlanning.ok) {
    return heldAfterPlanning;
  }
  if (planned.value.noChange) {
    return {
      ok: true,
      value: {
        status: "no-op",
        plan: planned.value,
        state: current
      }
    };
  }

  let acceptance;
  try {
    acceptance = resolveLifecycleCandidateAcceptance(
      await input.acceptCandidate(planned.value)
    );
  } catch {
    return {
      ok: false,
      error: productError("LifecycleInstallAcceptanceFailed", {})
    };
  }
  if (!acceptance.ok) {
    return acceptance;
  }
  if (acceptance.value === "no-op") {
    return {
      ok: true,
      value: {
        status: "no-op",
        plan: planned.value,
        state: current
      }
    };
  }
  if (acceptance.value === "plan") {
    return {
      ok: true,
      value: {
        status: "planned",
        plan: planned.value,
        state: current
      }
    };
  }
  if (acceptance.value === "decline") {
    return {
      ok: true,
      value: {
        status: "declined",
        plan: planned.value,
        state: current
      }
    };
  }

  const heldAfterAcceptance = input.lock.checkHeld();
  if (!heldAfterAcceptance.ok) {
    return heldAfterAcceptance;
  }

  const currentPlan = reconstructCurrentTargetPlan(
    current,
    currentRequirements.value
  );
  if (!currentPlan.ok) {
    return currentPlan;
  }
  const currentOwned = currentOwnedProjections(
    current,
    currentPlan.value
  );
  if (!currentOwned.ok) {
    return currentOwned;
  }

  const renames = preservedRenames(
    current,
    planned.value.candidate
  );
  const desiredPlan = planLifecycleTarget(
    planned.value.directRequirements,
    planned.value.candidate,
    renames
  );
  if (!desiredPlan.ok) {
    return desiredPlan;
  }

  const observed = await observeAcceptedTarget(
    input.home,
    targetRoot,
    currentOwned.value,
    desiredPlan.value
  );
  if (!observed.ok) {
    return observed;
  }

  const preflight = preflightTargetOwnership({
    desiredPlan: desiredPlan.value,
    currentProjections: currentOwned.value,
    observedPaths: observed.value
  });
  if (!preflight.ok) {
    return preflight;
  }

  const snapshots = await acquireLifecycleCandidatePackageSnapshots(
    input,
    planned.value.candidate
  );
  if (!snapshots.ok) {
    return snapshots;
  }
  const published = await publishLifecycleCandidateSnapshots(
    input.home,
    input.lock,
    snapshots.value
  );
  if (!published.ok) {
    return published;
  }

  const nextState = buildNextRegistryState(
    current,
    targetRoot,
    planned.value,
    desiredPlan.value
  );
  const operationId = (input.createOperationId ?? randomUUID)();
  const prepared = await prepareTargetReconciliation({
    home: input.home,
    targetRoot,
    operationId,
    lock: input.lock,
    registry: input.registry,
    desiredPlan: desiredPlan.value,
    preflight: preflight.value,
    currentProjections: currentOwned.value,
    nextState,
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

  const heldBeforeMarker = input.lock.checkHeld();
  if (!heldBeforeMarker.ok) {
    return heldBeforeMarker;
  }
  const marker = buildMarkerFacts(
    reconciled.value,
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

  const completed = await cleanupPendingTargetStaging({
    targetId: reconciled.value.targetId,
    targetRoot,
    lock: input.lock,
    registry: input.registry
  });
  if (!completed.ok) {
    return completed;
  }

  return {
    ok: true,
    value: {
      status: "applied",
      plan: planned.value,
      state: reconciled.value,
      marker
    }
  };
}

function reconstructCurrentTargetPlan(
  state: RegistryTargetState,
  requirements: ReadonlyArray<DirectInstallRequirement>
): Result<TargetPlan, TargetPlanError> {
  return planLifecycleTarget(
    requirements,
    registryGraph(state),
    projectionRenames(state.projections)
  );
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

function currentOwnedProjections(
  state: RegistryTargetState,
  plan: TargetPlan
): Result<
  ReadonlyArray<TargetOwnedProjection>,
  InvalidAcceptedRequirementChangeState
> {
  const projectionByPackage = new Map(
    plan.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  const registryByPackage = new Map(
    state.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  const result: TargetOwnedProjection[] = [];

  for (const projection of plan.projections) {
    if (!registryByPackage.has(projection.packageCoordinate)) {
      return invalidState(
        state.targetId,
        "missing-registry-projection"
      );
    }
  }

  for (const registryProjection of state.projections) {
    const projection = projectionByPackage.get(
      registryProjection.packageCoordinate
    );
    if (projection === undefined) {
      return invalidState(
        state.targetId,
        "missing-current-projection"
      );
    }
    if (
      registryProjection.activationName !==
        projection.activationName ||
      registryProjection.transformJson !==
        projectionTransformJson(projection)
    ) {
      return invalidState(state.targetId, "projection-mismatch");
    }
    result.push({
      projection,
      ownership: registryProjection.ownership,
      materialization: registryProjection.materialization
    });
  }

  return {
    ok: true,
    value: result.sort((left, right) =>
      compareUtf8(
        left.projection.activationName,
        right.projection.activationName
      )
    )
  };
}

function preservedRenames(
  state: RegistryTargetState,
  candidate: ResolverCandidateGraph
): ReadonlyArray<TargetProjectionRename> {
  const candidatePackages = new Set(
    candidate.packages.map((entry) => entry.packageCoordinate)
  );
  return projectionRenames(
    state.projections.filter((projection) =>
      candidatePackages.has(projection.packageCoordinate)
    )
  );
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
      coordinate.value.packageName === projection.activationName
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

async function observeAcceptedTarget(
  home: SkiloomHomePaths,
  targetRoot: string,
  current: ReadonlyArray<TargetOwnedProjection>,
  desiredPlan: TargetPlan
): Promise<
  Result<
    ReadonlyArray<TargetPathObservation>,
    ManagedProjectionVerificationError
  >
> {
  const observations: TargetPathObservation[] = [];
  const observedActivations = new Set<string>();

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
        observedActivations.add(owned.projection.activationName);
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
      observedActivations.add(owned.projection.activationName);
      continue;
    }
    if (verified.error.code === "ManagedProjectionMissing") {
      continue;
    }
    if (isPackageStoreVerificationError(verified.error.code)) {
      return verified;
    }

    observations.push({
      activationName: owned.projection.activationName,
      kind: "managed",
      packageCoordinate: owned.projection.packageCoordinate,
      contentDigest: owned.projection.contentDigest,
      materialization: owned.materialization,
      expectedViewMatches: false
    });
    observedActivations.add(owned.projection.activationName);
  }

  for (const projection of desiredPlan.projections) {
    if (observedActivations.has(projection.activationName)) {
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
      observedActivations.add(projection.activationName);
    }
  }

  return {
    ok: true,
    value: observations.sort((left, right) =>
      compareUtf8(left.activationName, right.activationName)
    )
  };
}

function buildNextRegistryState(
  current: RegistryTargetState,
  targetRoot: string,
  plan: LifecycleCandidatePlan,
  targetPlan: TargetPlan
): RegistryTargetStateInput {
  const currentProjectionByPackage = new Map(
    current.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  const candidatePackages = new Map(
    plan.candidate.packages.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );

  return {
    targetId: current.targetId,
    locations: current.locations.map((location) => ({
      ...location,
      path:
        resolve(location.path) === resolve(targetRoot)
          ? targetRoot
          : location.path
    })),
    directRequirements: plan.directRequirements.map(
      registryDirectRequirement
    ),
    resolvedSources: plan.candidate.sourceBindings.map(
      registryResolvedSource
    ),
    resolvedPackages: plan.candidate.packages.map((entry) => ({
      packageCoordinate: entry.packageCoordinate,
      repositoryCoordinate: repositoryFromPackageCoordinate(
        entry.packageCoordinate
      ),
      packageRoot: entry.packageRoot,
      contentDigest: entry.contentDigest
    })),
    dependencyEdges: plan.candidate.dependencyEdges.map((edge) => ({
      fromPackage: edge.sourcePackageCoordinate,
      toPackage: edge.targetPackageCoordinate
    })),
    projections: targetPlan.projections.map((projection) => {
      const existing = currentProjectionByPackage.get(
        projection.packageCoordinate
      );
      if (existing?.ownership === "detached") {
        return existing;
      }
      return {
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName,
        ownership: "managed" as const,
        materialization:
          existing !== undefined && projection.transform === null
            ? existing.materialization
            : projectionMaterialization(projection),
        transformJson: projectionTransformJson(projection)
      };
    }),
    detachedBaselines: current.detachedBaselines.filter(
      (baseline) => candidatePackages.has(baseline.packageCoordinate)
    ),
    dependencyObservations: current.dependencyObservations.filter(
      (observation) =>
        candidatePackages.get(observation.packageCoordinate)
          ?.contentDigest === observation.packageContentDigest
    )
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

function isPackageStoreVerificationError(code: string): boolean {
  return (
    code === "StoreEntryNotFound" ||
    code === "CorruptStoreEntry" ||
    code === "InvalidPackageContentDigest" ||
    code === "PackageContentDigestMismatch" ||
    code.startsWith("InvalidPackage")
  );
}

function invalidState(
  targetId: string,
  reason: InvalidAcceptedRequirementChangeState["facts"]["reason"]
): Result<never, InvalidAcceptedRequirementChangeState> {
  return {
    ok: false,
    error: productError("InvalidAcceptedRequirementChangeState", {
      targetId,
      reason
    })
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
