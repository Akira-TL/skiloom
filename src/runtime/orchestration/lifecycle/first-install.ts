import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  PackageSnapshotError
} from "../../../domain/snapshot/index.js";
import type {
  TargetPlan,
  TargetPlanError,
  TargetProjectionRename
} from "../../../domain/target/index.js";
import {
  preflightTargetOwnership,
  type TargetOwnershipPreflightError,
  type TargetPathObservation
} from "../../../domain/target/preflight.js";
import type {
  TargetRecoveryMarkerFacts
} from "../../../domain/target/recovery.js";
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
  RegistryTargetState,
  RegistryTargetStateInput
} from "../../registry/index.js";
import type { PackageStoreError } from "../../store.js";
import type {
  AcquireExactGitHubRepositorySnapshotError,
  BuildGitHubResolverRepositorySnapshotError
} from "../../source/github/index.js";
import {
  computeLifecycleCandidate,
  type ComputeLifecycleCandidateInput,
  type LifecycleCandidateError,
  type LifecycleCandidatePlan
} from "../lifecycle-candidate.js";
import {
  cleanupPendingTargetStaging,
  prepareTargetReconciliation,
  type TargetReconciliationError
} from "../target-reconcile.js";
import {
  resolveLifecycleCandidateAcceptance,
  type LifecycleCandidateAcceptanceCallback
} from "./acceptance.js";
import {
  freshLifecycleCandidateProjections,
  type LifecycleCandidateProjection
} from "./projection/plan.js";
import type {
  DetachedContentChangeRisk
} from "./projection/risk.js";
import {
  syncLifecycleMarker,
  type LifecycleMarkerSyncCallback,
  type LifecycleMarkerSyncFailed
} from "./marker/index.js";
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
  type LifecycleCandidateSnapshotMismatch
} from "./apply.js";

const TARGET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type LifecycleInstallAcceptanceFailed = ProductError<
  "LifecycleInstallAcceptanceFailed",
  Readonly<Record<string, never>>
>;

export type LifecycleFreshTargetConflict = ProductError<
  "LifecycleFreshTargetConflict",
  Readonly<{ targetId: string }>
>;

export type InvalidLifecycleTargetIdentity = ProductError<
  "InvalidLifecycleTargetIdentity",
  Readonly<{ targetId: string }>
>;

export type { LifecycleCandidateSnapshotMismatch } from "./apply.js";

export type LifecycleTargetObservationFailed = ProductError<
  "LifecycleTargetObservationFailed",
  Readonly<{ activationName: string }>
>;

export type { LifecycleMarkerSyncFailed } from "./marker/index.js";
export type FirstAcceptedInstallError =
  | LifecycleCandidateError
  | OperationLockLost
  | LifecycleInstallAcceptanceFailed
  | InteractionRequired
  | LifecycleFreshTargetConflict
  | InvalidLifecycleTargetIdentity
  | LifecycleCandidateSnapshotMismatch
  | LifecycleTargetObservationFailed
  | TargetPlanError
  | TargetOwnershipPreflightError
  | AcquireExactGitHubRepositorySnapshotError
  | BuildGitHubResolverRepositorySnapshotError
  | PackageSnapshotError
  | PackageStoreError
  | TargetReconciliationError
  | LifecycleMarkerSyncFailed;

export type FirstAcceptedInstallResult =
  | Readonly<{
      status: "planned";
      plan: LifecycleCandidatePlan;
      projections: ReadonlyArray<LifecycleCandidateProjection>;
      detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
    }>
  | Readonly<{
      status: "declined";
      plan: LifecycleCandidatePlan;
      projections: ReadonlyArray<LifecycleCandidateProjection>;
      detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
    }>
  | Readonly<{
      status: "installed";
      plan: LifecycleCandidatePlan;
      projections: ReadonlyArray<LifecycleCandidateProjection>;
      detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
      state: RegistryTargetState;
      marker: TargetRecoveryMarkerFacts;
    }>;

export type FirstAcceptedInstallInput =
  Omit<ComputeLifecycleCandidateInput, "currentState"> &
    Readonly<{
      home: SkiloomHomePaths;
      targetRoot: string;
      lock: OperationLockSession;
      registry: MachineRegistry;
      acceptCandidate: LifecycleCandidateAcceptanceCallback;
      requestedProjectionRename?: TargetProjectionRename;
      syncMarker?: LifecycleMarkerSyncCallback;
      createTargetId?: () => string;
      createOperationId?: () => string;
    }>;

export async function executeFirstAcceptedInstall(
  input: FirstAcceptedInstallInput
): Promise<Result<FirstAcceptedInstallResult, FirstAcceptedInstallError>> {
  const initiallyHeld = input.lock.checkHeld();
  if (!initiallyHeld.ok) {
    return initiallyHeld;
  }

  const planned = await computeLifecycleCandidate({
    directRequirements: input.directRequirements,
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
  const desiredPlan = planLifecycleTarget(
    planned.value.directRequirements,
    planned.value.candidate,
    input.requestedProjectionRename === undefined
      ? []
      : [input.requestedProjectionRename]
  );
  if (!desiredPlan.ok) {
    return desiredPlan;
  }
  const candidateProjections =
    freshLifecycleCandidateProjections(desiredPlan.value);

  let acceptance;
  try {
    acceptance = resolveLifecycleCandidateAcceptance(
      await input.acceptCandidate(
        planned.value,
        candidateProjections,
        []
      )
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
  if (
    acceptance.value === "plan" ||
    acceptance.value === "no-op"
  ) {
    return {
      ok: true,
      value: {
        status: "planned",
        plan: planned.value,
        projections: candidateProjections,
        detachedContentRisks: []
      }
    };
  }
  if (acceptance.value === "decline") {
    return {
      ok: true,
      value: {
        status: "declined",
        plan: planned.value,
        projections: candidateProjections,
        detachedContentRisks: []
      }
    };
  }

  const heldAfterAcceptance = input.lock.checkHeld();
  if (!heldAfterAcceptance.ok) {
    return heldAfterAcceptance;
  }

  const targetId = (input.createTargetId ?? randomUUID)();
  if (!TARGET_ID_PATTERN.test(targetId)) {
    return {
      ok: false,
      error: productError("InvalidLifecycleTargetIdentity", {
        targetId
      })
    };
  }

  const existing = input.registry.readTargetState(targetId);
  if (!existing.ok) {
    return existing;
  }
  if (existing.value !== undefined) {
    return {
      ok: false,
      error: productError("LifecycleFreshTargetConflict", {
        targetId
      })
    };
  }

  const observed = await observeFreshTarget(
    input.targetRoot,
    desiredPlan.value
  );
  if (!observed.ok) {
    return observed;
  }

  const preflight = preflightTargetOwnership({
    desiredPlan: desiredPlan.value,
    currentProjections: [],
    observedPaths: observed.value
  });
  if (!preflight.ok) {
    return preflight;
  }

  const packageSnapshots =
    await acquireLifecycleCandidatePackageSnapshots(
      input,
      planned.value.candidate
    );
  if (!packageSnapshots.ok) {
    return packageSnapshots;
  }

  const published = await publishLifecycleCandidateSnapshots(
    input.home,
    input.lock,
    packageSnapshots.value
  );
  if (!published.ok) {
    return published;
  }

  const stillHeld = input.lock.checkHeld();
  if (!stillHeld.ok) {
    return stillHeld;
  }

  const nextState = buildFreshRegistryState(
    targetId,
    resolve(input.targetRoot),
    planned.value,
    desiredPlan.value
  );
  const operationId = (input.createOperationId ?? randomUUID)();

  const prepared = await prepareTargetReconciliation({
    home: input.home,
    targetRoot: resolve(input.targetRoot),
    operationId,
    lock: input.lock,
    registry: input.registry,
    desiredPlan: desiredPlan.value,
    preflight: preflight.value,
    currentProjections: [],
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
    targetRoot: resolve(input.targetRoot),
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
    targetRoot: resolve(input.targetRoot),
    lock: input.lock,
    registry: input.registry
  });
  if (!completed.ok) {
    return completed;
  }

  return {
    ok: true,
    value: {
      status: "installed",
      plan: planned.value,
      projections: candidateProjections,
      detachedContentRisks: [],
      state: reconciled.value,
      marker
    }
  };
}

async function observeFreshTarget(
  targetRoot: string,
  plan: TargetPlan
): Promise<
  Result<
    ReadonlyArray<TargetPathObservation>,
    LifecycleTargetObservationFailed
  >
> {
  const observations: TargetPathObservation[] = [];

  for (const projection of plan.projections) {
    const activationPath = join(
      resolve(targetRoot),
      projection.activationName
    );
    try {
      await lstat(activationPath);
      observations.push({
        activationName: projection.activationName,
        kind: "existing"
      });
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      return {
        ok: false,
        error: productError("LifecycleTargetObservationFailed", {
          activationName: projection.activationName
        })
      };
    }
  }

  return { ok: true, value: observations };
}

function buildFreshRegistryState(
  targetId: string,
  targetRoot: string,
  plan: LifecycleCandidatePlan,
  targetPlan: TargetPlan
): RegistryTargetStateInput {
  return {
    targetId,
    locations: [
      {
        path: targetRoot,
        observedGeneration: null
      }
    ],
    directRequirements: plan.directRequirements.map(
      registryDirectRequirement
    ),
    resolvedSources: plan.candidate.sourceBindings.map(
      registryResolvedSource
    ),
    resolvedPackages: plan.candidate.packages.map(
      (packageFact) => ({
        packageCoordinate: packageFact.packageCoordinate,
        repositoryCoordinate: repositoryFromPackageCoordinate(
          packageFact.packageCoordinate
        ),
        packageRoot: packageFact.packageRoot,
        contentDigest: packageFact.contentDigest
      })
    ),
    dependencyEdges: plan.candidate.dependencyEdges.map(
      (edge) => ({
        fromPackage: edge.sourcePackageCoordinate,
        toPackage: edge.targetPackageCoordinate
      })
    ),
    projections: targetPlan.projections.map((projection) => ({
      packageCoordinate: projection.packageCoordinate,
      activationName: projection.activationName,
      ownership: "managed" as const,
      materialization: projectionMaterialization(projection),
      transformJson: projectionTransformJson(projection)
    })),
    detachedBaselines: [],
    dependencyObservations: []
  };
}

function isNotFound(
  error: unknown
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
