import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  DirectInstallRequirement,
  ResolverCandidateGraph,
  ResolverSourceBindingSummary
} from "../../../domain/resolver/index.js";
import {
  buildPackageSnapshot,
  type PackageSnapshot,
  type PackageSnapshotError
} from "../../../domain/snapshot/index.js";
import {
  planTargetProjections,
  type TargetPlan,
  type TargetPlanError,
  type TargetProjection
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
  OperationLockLost,
  OperationLockSession
} from "../../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../../home.js";
import type {
  MachineRegistry,
  RegistryDirectRequirement,
  RegistryResolvedSource,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../../registry/index.js";
import {
  publishPackageSnapshot,
  type PackageStoreError
} from "../../store.js";
import {
  acquireCachedExactGitHubRepositorySnapshot,
  acquireExactGitHubRepositorySnapshot,
  buildGitHubResolverRepositorySnapshot,
  type AcquireExactGitHubRepositorySnapshotError,
  type BuildGitHubResolverRepositorySnapshotError
} from "../../source/github/index.js";
import {
  computeLifecycleCandidate,
  type ComputeLifecycleCandidateInput,
  type LifecycleCandidateError,
  type LifecycleCandidatePlan
} from "../lifecycle-candidate.js";
import {
  prepareTargetReconciliation,
  type TargetReconciliationError
} from "../target-reconcile.js";

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

export type LifecycleCandidateSnapshotMismatch = ProductError<
  "LifecycleCandidateSnapshotMismatch",
  Readonly<{
    packageCoordinate: string;
    reason:
      | "invalid-repository-coordinate"
      | "missing-source-package"
      | "package-root-mismatch"
      | "content-digest-mismatch";
  }>
>;

export type LifecycleTargetObservationFailed = ProductError<
  "LifecycleTargetObservationFailed",
  Readonly<{ activationName: string }>
>;

export type LifecycleMarkerSyncFailed = ProductError<
  "LifecycleMarkerSyncFailed",
  Readonly<{
    targetId: string;
    generation: number;
  }>
>;

export type FirstAcceptedInstallError =
  | LifecycleCandidateError
  | OperationLockLost
  | LifecycleInstallAcceptanceFailed
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
      status: "declined";
      plan: LifecycleCandidatePlan;
    }>
  | Readonly<{
      status: "installed";
      plan: LifecycleCandidatePlan;
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
      acceptCandidate: (
        plan: LifecycleCandidatePlan
      ) => boolean | Promise<boolean>;
      syncMarker: (
        marker: TargetRecoveryMarkerFacts
      ) => void | Promise<void>;
      createTargetId?: () => string;
      createOperationId?: () => string;
    }>;

type CandidatePackageSnapshot = Readonly<{
  packageCoordinate: string;
  snapshot: PackageSnapshot;
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

  let accepted: boolean;
  try {
    accepted = await input.acceptCandidate(planned.value);
  } catch {
    return {
      ok: false,
      error: productError("LifecycleInstallAcceptanceFailed", {})
    };
  }
  if (!accepted) {
    return {
      ok: true,
      value: {
        status: "declined",
        plan: planned.value
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

  const desiredPlan = planFreshTarget(
    planned.value.directRequirements,
    planned.value.candidate
  );
  if (!desiredPlan.ok) {
    return desiredPlan;
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

  const packageSnapshots = await acquireCandidatePackageSnapshots(
    input,
    planned.value.candidate
  );
  if (!packageSnapshots.ok) {
    return packageSnapshots;
  }

  for (const packageSnapshot of packageSnapshots.value) {
    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    const published = await publishPackageSnapshot(
      input.home,
      packageSnapshot.snapshot
    );
    if (!published.ok) {
      return published;
    }
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
    nextState
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
  try {
    await input.syncMarker(marker);
  } catch {
    return {
      ok: false,
      error: productError("LifecycleMarkerSyncFailed", {
        targetId: reconciled.value.targetId,
        generation: reconciled.value.generation
      })
    };
  }

  return {
    ok: true,
    value: {
      status: "installed",
      plan: planned.value,
      state: reconciled.value,
      marker
    }
  };
}

function planFreshTarget(
  directRequirements: ReadonlyArray<DirectInstallRequirement>,
  candidate: ResolverCandidateGraph
): Result<TargetPlan, TargetPlanError> {
  const directRoots = new Set<string>();

  for (const requirement of directRequirements) {
    if (requirement.kind === "package") {
      directRoots.add(requirement.coordinate.canonical);
      continue;
    }

    for (const packageFact of candidate.packages) {
      if (
        repositoryFromPackageCoordinate(
          packageFact.packageCoordinate
        ) === requirement.coordinate.canonical
      ) {
        directRoots.add(packageFact.packageCoordinate);
      }
    }
  }

  return planTargetProjections({
    packages: candidate.packages,
    dependencyEdges: candidate.dependencyEdges,
    directRoots: [...directRoots].sort(compareUtf8),
    renames: []
  });
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

async function acquireCandidatePackageSnapshots(
  input: FirstAcceptedInstallInput,
  candidate: ResolverCandidateGraph
): Promise<
  Result<
    ReadonlyArray<CandidatePackageSnapshot>,
    | OperationLockLost
    | LifecycleCandidateSnapshotMismatch
    | AcquireExactGitHubRepositorySnapshotError
    | BuildGitHubResolverRepositorySnapshotError
    | PackageSnapshotError
  >
> {
  const snapshots = new Map<string, PackageSnapshot>();

  for (const source of candidate.sourceBindings) {
    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }

    const repository = parseRepositoryCoordinate(
      source.repositoryCoordinate
    );
    if (!repository.ok) {
      return snapshotMismatch(
        source.repositoryCoordinate,
        "invalid-repository-coordinate"
      );
    }

    const acquired =
      input.sourceCachePath === undefined
        ? await acquireExactGitHubRepositorySnapshot({
            repository: repository.value,
            exactCommit: source.exactCommit,
            transport: input.transport,
            ...(input.credential === undefined
              ? {}
              : { credential: input.credential }),
            ...(input.signal === undefined
              ? {}
              : { signal: input.signal })
          })
        : await acquireCachedExactGitHubRepositorySnapshot({
            repository: repository.value,
            exactCommit: source.exactCommit,
            cacheRoot: input.sourceCachePath,
            transport: input.transport,
            ...(input.credential === undefined
              ? {}
              : { credential: input.credential }),
            ...(input.signal === undefined
              ? {}
              : { signal: input.signal })
          });
    if (!acquired.ok) {
      return acquired;
    }

    const fullRepository =
      buildGitHubResolverRepositorySnapshot(acquired.value);
    if (!fullRepository.ok) {
      return fullRepository;
    }

    const discoveredByCoordinate = new Map(
      fullRepository.value.packages.map((packageFact) => [
        packageFact.coordinate.canonical,
        packageFact
      ])
    );
    const discoveredRoots =
      fullRepository.value.packages.map(
        (packageFact) => packageFact.packageRoot
      );
    const candidatePackages = candidate.packages.filter(
      (packageFact) =>
        repositoryFromPackageCoordinate(
          packageFact.packageCoordinate
        ) === source.repositoryCoordinate
    );

    for (const packageFact of candidatePackages) {
      const discovered = discoveredByCoordinate.get(
        packageFact.packageCoordinate
      );
      if (discovered === undefined) {
        return snapshotMismatch(
          packageFact.packageCoordinate,
          "missing-source-package"
        );
      }
      if (discovered.packageRoot !== packageFact.packageRoot) {
        return snapshotMismatch(
          packageFact.packageCoordinate,
          "package-root-mismatch"
        );
      }

      const snapshot = buildPackageSnapshot({
        packageRoot: packageFact.packageRoot,
        discoveredPackageRoots: discoveredRoots,
        entries: acquired.value.entries
      });
      if (!snapshot.ok) {
        return snapshot;
      }
      if (
        snapshot.value.contentDigest !==
          packageFact.contentDigest ||
        discovered.contentDigest !== packageFact.contentDigest
      ) {
        return snapshotMismatch(
          packageFact.packageCoordinate,
          "content-digest-mismatch"
        );
      }
      snapshots.set(
        packageFact.packageCoordinate,
        snapshot.value
      );
    }
  }

  if (snapshots.size !== candidate.packages.length) {
    const missing = candidate.packages.find(
      (packageFact) =>
        !snapshots.has(packageFact.packageCoordinate)
    );
    return snapshotMismatch(
      missing?.packageCoordinate ?? "",
      "missing-source-package"
    );
  }

  return {
    ok: true,
    value: [...snapshots.entries()]
      .map(([packageCoordinate, snapshot]) => ({
        packageCoordinate,
        snapshot
      }))
      .sort((left, right) =>
        compareUtf8(
          left.packageCoordinate,
          right.packageCoordinate
        )
      )
  };
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

function registryDirectRequirement(
  requirement: DirectInstallRequirement
): RegistryDirectRequirement {
  return requirement.sourceKind === "git"
    ? {
        kind: requirement.kind,
        coordinate: requirement.coordinate.canonical,
        sourceKind: "git",
        requestedRef: requirement.requestedRef
      }
    : {
        kind: requirement.kind,
        coordinate: requirement.coordinate.canonical,
        sourceKind: "github-release",
        versionRequirement:
          requirement.versionRequirement ?? null
      };
}

function registryResolvedSource(
  source: ResolverSourceBindingSummary
): RegistryResolvedSource {
  return source.sourceKind === "git"
    ? {
        repositoryCoordinate: source.repositoryCoordinate,
        sourceKind: "git",
        requestedRef: source.requestedRef,
        exactCommit: source.exactCommit
      }
    : {
        repositoryCoordinate: source.repositoryCoordinate,
        sourceKind: "github-release",
        version: source.version,
        actualTag: source.actualTag,
        exactCommit: source.exactCommit,
        immutable: source.immutable
      };
}

function projectionMaterialization(
  projection: TargetProjection
): "symlink" | "junction" | "copy" {
  if (projection.transform !== null) {
    return "copy";
  }
  return process.platform === "win32"
    ? "junction"
    : "symlink";
}

function projectionTransformJson(
  projection: TargetProjection
): string | null {
  return projection.transform === null
    ? null
    : JSON.stringify({
        rename: projection.transform.rename,
        dependencyRoutes:
          projection.transform.dependencyRoutes
      });
}

function buildMarkerFacts(
  state: RegistryTargetState,
  plan: TargetPlan
): TargetRecoveryMarkerFacts {
  const projectionOverrides =
    plan.projections.flatMap((projection) => {
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

  return {
    targetId: state.targetId,
    generation: state.generation,
    requirements: state.directRequirements,
    projectionOverrides,
    detached: []
  };
}

function repositoryFromPackageCoordinate(
  packageCoordinate: string
): string {
  return packageCoordinate
    .split("/")
    .slice(0, 2)
    .join("/");
}

function snapshotMismatch(
  packageCoordinate: string,
  reason:
    LifecycleCandidateSnapshotMismatch["facts"]["reason"]
): Result<never, LifecycleCandidateSnapshotMismatch> {
  return {
    ok: false,
    error: productError(
      "LifecycleCandidateSnapshotMismatch",
      {
        packageCoordinate,
        reason
      }
    )
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

function compareUtf8(
  left: string,
  right: string
): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
