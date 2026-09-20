import { parsePackageCoordinate, parseRepositoryCoordinate } from "../../../domain/coordinate/index.js";
import { productError, type ProductError, type Result } from "../../../domain/errors/index.js";
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
  type TargetProjection,
  type TargetProjectionRename
} from "../../../domain/target/index.js";
import type { TargetRecoveryMarkerFacts } from "../../../domain/target/recovery.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../../home.js";
import type {
  RegistryDirectRequirement,
  RegistryResolvedSource,
  RegistryTargetState
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
  type BuildGitHubResolverRepositorySnapshotError,
  type GitHubJsonTransport
} from "../../source/github/index.js";

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

export type LifecycleCandidateSnapshotError =
  | OperationLockLost
  | LifecycleCandidateSnapshotMismatch
  | AcquireExactGitHubRepositorySnapshotError
  | BuildGitHubResolverRepositorySnapshotError
  | PackageSnapshotError;

export type CandidatePackageSnapshot = Readonly<{
  packageCoordinate: string;
  snapshot: PackageSnapshot;
}>;

export type LifecycleSnapshotRuntime = Readonly<{
  lock: OperationLockSession;
  transport: GitHubJsonTransport;
  credential?: string;
  signal?: AbortSignal;
  sourceCachePath?: string;
}>;

export function planLifecycleTarget(
  directRequirements: ReadonlyArray<DirectInstallRequirement>,
  candidate: ResolverCandidateGraph,
  renames: ReadonlyArray<TargetProjectionRename> = []
): Result<TargetPlan, TargetPlanError> {
  const directRoots = new Set<string>();
  for (const requirement of directRequirements) {
    if (requirement.kind === "package") {
      directRoots.add(requirement.coordinate.canonical);
      continue;
    }
    for (const packageFact of candidate.packages) {
      if (
        repositoryFromPackageCoordinate(packageFact.packageCoordinate) ===
        requirement.coordinate.canonical
      ) {
        directRoots.add(packageFact.packageCoordinate);
      }
    }
  }
  return planTargetProjections({
    packages: candidate.packages,
    dependencyEdges: candidate.dependencyEdges,
    directRoots: [...directRoots].sort(compareUtf8),
    renames
  });
}

export async function acquireLifecycleCandidatePackageSnapshots(
  input: LifecycleSnapshotRuntime,
  candidate: ResolverCandidateGraph
): Promise<
  Result<
    ReadonlyArray<CandidatePackageSnapshot>,
    LifecycleCandidateSnapshotError
  >
> {
  const snapshots = new Map<string, PackageSnapshot>();

  for (const source of candidate.sourceBindings) {
    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    const repository = parseRepositoryCoordinate(source.repositoryCoordinate);
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
            ...(input.credential === undefined ? {} : { credential: input.credential }),
            ...(input.signal === undefined ? {} : { signal: input.signal })
          })
        : await acquireCachedExactGitHubRepositorySnapshot({
            repository: repository.value,
            exactCommit: source.exactCommit,
            cacheRoot: input.sourceCachePath,
            transport: input.transport,
            ...(input.credential === undefined ? {} : { credential: input.credential }),
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
    if (!acquired.ok) {
      return acquired;
    }

    const repositorySnapshot =
      buildGitHubResolverRepositorySnapshot(acquired.value);
    if (!repositorySnapshot.ok) {
      return repositorySnapshot;
    }
    const discoveredByCoordinate = new Map(
      repositorySnapshot.value.packages.map((packageFact) => [
        packageFact.coordinate.canonical,
        packageFact
      ])
    );
    const discoveredRoots = repositorySnapshot.value.packages.map(
      (packageFact) => packageFact.packageRoot
    );

    for (const packageFact of candidate.packages.filter(
      (entry) =>
        repositoryFromPackageCoordinate(entry.packageCoordinate) ===
        source.repositoryCoordinate
    )) {
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
        snapshot.value.contentDigest !== packageFact.contentDigest ||
        discovered.contentDigest !== packageFact.contentDigest
      ) {
        return snapshotMismatch(
          packageFact.packageCoordinate,
          "content-digest-mismatch"
        );
      }
      snapshots.set(packageFact.packageCoordinate, snapshot.value);
    }
  }

  if (snapshots.size !== candidate.packages.length) {
    const missing = candidate.packages.find(
      (entry) => !snapshots.has(entry.packageCoordinate)
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
        compareUtf8(left.packageCoordinate, right.packageCoordinate)
      )
  };
}

export async function publishLifecycleCandidateSnapshots(
  home: SkiloomHomePaths,
  lock: OperationLockSession,
  snapshots: ReadonlyArray<CandidatePackageSnapshot>
): Promise<Result<void, OperationLockLost | PackageStoreError>> {
  for (const entry of snapshots) {
    const held = lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    const published = await publishPackageSnapshot(home, entry.snapshot);
    if (!published.ok) {
      return published;
    }
  }
  return { ok: true, value: undefined };
}

export function registryDirectRequirement(
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
        versionRequirement: requirement.versionRequirement ?? null
      };
}

export function registryResolvedSource(
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

export function projectionMaterialization(
  projection: TargetProjection
): "symlink" | "junction" | "copy" {
  return projection.transform !== null
    ? "copy"
    : process.platform === "win32"
      ? "junction"
      : "symlink";
}

export function projectionTransformJson(
  projection: TargetProjection
): string | null {
  return projection.transform === null
    ? null
    : JSON.stringify({
        rename: projection.transform.rename,
        dependencyRoutes: projection.transform.dependencyRoutes
      });
}

export function buildMarkerFacts(
  state: RegistryTargetState,
  plan: TargetPlan
): TargetRecoveryMarkerFacts {
  const projectionOverrides = plan.projections.flatMap((projection) => {
    const coordinate = parsePackageCoordinate(projection.packageCoordinate);
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

  const packageByCoordinate = new Map(
    state.resolvedPackages.map((packageFact) => [
      packageFact.packageCoordinate,
      packageFact
    ])
  );
  const managed = state.projections
    .filter((projection) => projection.ownership === "managed")
    .map((projection) => {
      const packageFact = packageByCoordinate.get(
        projection.packageCoordinate
      );
      if (packageFact === undefined) {
        throw new Error(
          "managed projection package missing from accepted Registry state"
        );
      }
      return {
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName,
        materialization: projection.materialization,
        packageRoot: packageFact.packageRoot,
        contentDigest: packageFact.contentDigest,
        transformJson: projection.transformJson
      };
    });

  return {
    targetId: state.targetId,
    generation: state.generation,
    requirements: state.directRequirements,
    projectionOverrides,
    managed,
    detached: state.detachedBaselines.map((baseline) =>
      baseline.sourceKind === "git"
        ? {
            packageCoordinate: baseline.packageCoordinate,
            sourceKind: "git" as const,
            requestedRef: baseline.requestedRef,
            exactCommit: baseline.exactCommit,
            packageRoot: baseline.packageRoot,
            contentDigest: baseline.contentDigest
          }
        : {
            packageCoordinate: baseline.packageCoordinate,
            sourceKind: "github-release" as const,
            version: baseline.version,
            actualTag: baseline.actualTag,
            exactCommit: baseline.exactCommit,
            packageRoot: baseline.packageRoot,
            contentDigest: baseline.contentDigest
          }
    )
  };
}

export function repositoryFromPackageCoordinate(
  packageCoordinate: string
): string {
  return packageCoordinate.split("/").slice(0, 2).join("/");
}

function snapshotMismatch(
  packageCoordinate: string,
  reason: LifecycleCandidateSnapshotMismatch["facts"]["reason"]
): Result<never, LifecycleCandidateSnapshotMismatch> {
  return {
    ok: false,
    error: productError("LifecycleCandidateSnapshotMismatch", {
      packageCoordinate,
      reason
    })
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
