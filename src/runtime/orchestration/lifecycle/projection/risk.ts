import type {
  ResolverSourceBindingSummary
} from "../../../../domain/resolver/index.js";
import type {
  TargetRecoveryDetachedBaseline
} from "../../../../domain/target/recovery.js";
import type {
  RegistryTargetState
} from "../../../registry/index.js";
import type {
  LifecycleCandidatePlan
} from "../../lifecycle-candidate.js";
import type {
  LifecycleCandidateProjection
} from "./plan.js";

export type DetachedContentChangeRisk = Readonly<{
  kind: "detached-content-change";
  packageCoordinate: string;
  previousPackage: Readonly<{
    packageRoot: string;
    contentDigest: string;
  }>;
  candidatePackage: Readonly<{
    packageRoot: string;
    contentDigest: string;
  }>;
  previousSource: ResolverSourceBindingSummary | null;
  candidateSource: ResolverSourceBindingSummary | null;
}>;

export function detachedContentChangeRisks(
  current: RegistryTargetState,
  plan: LifecycleCandidatePlan,
  projections: ReadonlyArray<LifecycleCandidateProjection>
): ReadonlyArray<DetachedContentChangeRisk> {
  const detached = new Set(
    projections
      .filter((projection) => projection.ownership === "detached")
      .map((projection) => projection.packageCoordinate)
  );
  if (detached.size === 0) {
    return [];
  }

  const currentPackages = new Map(
    current.resolvedPackages.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  const candidatePackages = new Map(
    plan.candidate.packages.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  const previousSources = new Map(
    plan.comparison.previousRepositories.map((entry) => [
      entry.repositoryCoordinate,
      entry
    ])
  );
  const candidateSources = new Map(
    plan.comparison.candidateRepositories.map((entry) => [
      entry.repositoryCoordinate,
      entry
    ])
  );

  const risks: DetachedContentChangeRisk[] = [];
  for (const packageCoordinate of [...detached].sort(compareUtf8)) {
    const previousPackage = currentPackages.get(packageCoordinate);
    const candidatePackage = candidatePackages.get(packageCoordinate);
    if (previousPackage === undefined || candidatePackage === undefined) {
      continue;
    }

    const previousSource =
      previousSources.get(previousPackage.repositoryCoordinate) ?? null;
    const candidateSource =
      candidateSources.get(previousPackage.repositoryCoordinate) ?? null;
    const packageChanged =
      previousPackage.packageRoot !== candidatePackage.packageRoot ||
      previousPackage.contentDigest !== candidatePackage.contentDigest;
    const sourceChanged = !sameSource(
      previousSource,
      candidateSource
    );
    if (!packageChanged && !sourceChanged) {
      continue;
    }

    risks.push({
      kind: "detached-content-change",
      packageCoordinate,
      previousPackage: {
        packageRoot: previousPackage.packageRoot,
        contentDigest: previousPackage.contentDigest
      },
      candidatePackage: {
        packageRoot: candidatePackage.packageRoot,
        contentDigest: candidatePackage.contentDigest
      },
      previousSource,
      candidateSource
    });
  }
  return risks;
}

export function recoveryDetachedContentChangeRisks(
  detachedBaselines: ReadonlyArray<TargetRecoveryDetachedBaseline>,
  plan: LifecycleCandidatePlan,
  projections: ReadonlyArray<LifecycleCandidateProjection>
): ReadonlyArray<DetachedContentChangeRisk> {
  const detached = new Set(
    projections
      .filter((projection) => projection.ownership === "detached")
      .map((projection) => projection.packageCoordinate)
  );
  const candidatePackages = new Map(
    plan.candidate.packages.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  const candidateSources = new Map(
    plan.candidate.sourceBindings.map((entry) => [
      entry.repositoryCoordinate,
      entry
    ])
  );

  const risks: DetachedContentChangeRisk[] = [];
  for (
    const baseline of [...detachedBaselines].sort(
      (left, right) =>
        compareUtf8(
          left.packageCoordinate,
          right.packageCoordinate
        )
    )
  ) {
    if (!detached.has(baseline.packageCoordinate)) {
      continue;
    }
    const candidatePackage = candidatePackages.get(
      baseline.packageCoordinate
    );
    if (candidatePackage === undefined) {
      continue;
    }

    const previousSource = baselineSource(baseline);
    const candidateSource =
      candidateSources.get(
        repositoryCoordinateFromPackage(
          baseline.packageCoordinate
        )
      ) ?? null;
    const packageChanged =
      baseline.packageRoot !== candidatePackage.packageRoot ||
      baseline.contentDigest !== candidatePackage.contentDigest;
    const sourceChanged = !sameSource(
      previousSource,
      candidateSource
    );
    if (!packageChanged && !sourceChanged) {
      continue;
    }

    risks.push({
      kind: "detached-content-change",
      packageCoordinate: baseline.packageCoordinate,
      previousPackage: {
        packageRoot: baseline.packageRoot,
        contentDigest: baseline.contentDigest
      },
      candidatePackage: {
        packageRoot: candidatePackage.packageRoot,
        contentDigest: candidatePackage.contentDigest
      },
      previousSource,
      candidateSource
    });
  }
  return risks;
}

function baselineSource(
  baseline: TargetRecoveryDetachedBaseline
): ResolverSourceBindingSummary {
  const repositoryCoordinate =
    repositoryCoordinateFromPackage(
      baseline.packageCoordinate
    );
  return baseline.sourceKind === "git"
    ? {
        repositoryCoordinate,
        sourceKind: "git",
        requestedRef: baseline.requestedRef,
        exactCommit: baseline.exactCommit
      }
    : {
        repositoryCoordinate,
        sourceKind: "github-release",
        version: baseline.version,
        actualTag: baseline.actualTag,
        exactCommit: baseline.exactCommit,
        immutable: null
      };
}

function repositoryCoordinateFromPackage(
  packageCoordinate: string
): string {
  const [owner, repository] = packageCoordinate.split("/");
  return owner + "/" + repository;
}

function sameSource(
  left: ResolverSourceBindingSummary | null,
  right: ResolverSourceBindingSummary | null
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.sourceKind !== right.sourceKind) {
    return false;
  }
  if (left.sourceKind === "git" && right.sourceKind === "git") {
    return (
      left.requestedRef === right.requestedRef &&
      left.exactCommit === right.exactCommit
    );
  }
  if (
    left.sourceKind === "github-release" &&
    right.sourceKind === "github-release"
  ) {
    return (
      left.version === right.version &&
      left.actualTag === right.actualTag &&
      left.exactCommit === right.exactCommit
    );
  }
  return false;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
