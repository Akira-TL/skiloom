import type {
  ResolverSourceBindingSummary
} from "../../../../domain/resolver/index.js";
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
