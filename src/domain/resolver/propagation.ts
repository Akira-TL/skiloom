import type {
  PackageCoordinate,
  RepositoryCoordinate
} from "../coordinate/index.js";
import {
  parseReleaseRequirement,
  type ReleaseRequirementErrorReason,
  type ReleaseVersion
} from "../requirement/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";
import { compareUtf8 } from "./ordering.js";

export type ResolverPackageDependencyFact = Readonly<{
  target: PackageCoordinate;
  requirement: string;
}>;

export type ResolverPackageFact = Readonly<{
  coordinate: PackageCoordinate;
  packageRoot: string;
  contentDigest: string;
  dependencies: ReadonlyArray<ResolverPackageDependencyFact>;
}>;

export type ResolverRepositorySnapshot = Readonly<{
  packages: ReadonlyArray<ResolverPackageFact>;
}>;

export type DirectInstallRequirement =
  | Readonly<{
      kind: "package";
      coordinate: PackageCoordinate;
      sourceKind: "github-release";
      versionRequirement?: string;
    }>
  | Readonly<{
      kind: "repository";
      coordinate: RepositoryCoordinate;
      sourceKind: "github-release";
      versionRequirement?: string;
    }>
  | Readonly<{
      kind: "package";
      coordinate: PackageCoordinate;
      sourceKind: "git";
      requestedRef: string;
    }>
  | Readonly<{
      kind: "repository";
      coordinate: RepositoryCoordinate;
      sourceKind: "git";
      requestedRef: string;
    }>;

export type BoundRepositorySource =
  | Readonly<{
      repository: RepositoryCoordinate;
      sourceKind: "github-release";
      version: ReleaseVersion;
      actualTag: string;
      exactCommit: string;
      immutable: boolean;
      snapshot: ResolverRepositorySnapshot;
    }>
  | Readonly<{
      repository: RepositoryCoordinate;
      sourceKind: "git";
      requestedRef: string;
      exactCommit: string;
      snapshot: ResolverRepositorySnapshot;
    }>;

export type ResolverConstraintOrigin =
  | Readonly<{
      kind: "direct";
      coordinate: string;
    }>
  | Readonly<{
      kind: "dependency";
      sourcePackageCoordinate: string;
      targetPackageCoordinate: string;
    }>;

export type ResolverReleaseConstraint = Readonly<{
  requirement: string;
  origin: ResolverConstraintOrigin;
}>;

export type ResolverReleaseConstraintSet = Readonly<{
  repositoryCoordinate: string;
  constraints: ReadonlyArray<ResolverReleaseConstraint>;
}>;

export type ResolverSourceBindingSummary =
  | Readonly<{
      repositoryCoordinate: string;
      sourceKind: "github-release";
      version: string;
      actualTag: string;
      exactCommit: string;
      immutable: boolean;
    }>
  | Readonly<{
      repositoryCoordinate: string;
      sourceKind: "git";
      requestedRef: string;
      exactCommit: string;
    }>;

export type ResolverExpandedPackage = Readonly<{
  packageCoordinate: string;
  packageRoot: string;
  contentDigest: string;
}>;

export type ResolverDependencyEdge = Readonly<{
  sourcePackageCoordinate: string;
  targetPackageCoordinate: string;
}>;

export type ResolverPropagationResult = Readonly<{
  repositoryWideRoots: ReadonlyArray<string>;
  requiredPackages: ReadonlyArray<string>;
  releaseConstraintSets: ReadonlyArray<ResolverReleaseConstraintSet>;
  sourceBindings: ReadonlyArray<ResolverSourceBindingSummary>;
  expandedPackages: ReadonlyArray<ResolverExpandedPackage>;
  dependencyEdges: ReadonlyArray<ResolverDependencyEdge>;
  unresolvedRepositories: ReadonlyArray<string>;
}>;

export type RepositorySourceConflict = ProductError<
  "RepositorySourceConflict",
  Readonly<{
    repositoryCoordinate: string;
    requestedSources: ReadonlyArray<string>;
  }>
>;

export type ResolverInvalidReleaseRequirement =
  | ProductError<
      "InvalidReleaseRequirement",
      Readonly<{
        requirement: string;
        reason: ReleaseRequirementErrorReason;
        originKind: "direct";
        originCoordinate: string;
      }>
    >
  | ProductError<
      "InvalidReleaseRequirement",
      Readonly<{
        requirement: string;
        reason: ReleaseRequirementErrorReason;
        originKind: "dependency";
        sourcePackageCoordinate: string;
        targetPackageCoordinate: string;
      }>
    >;

export type ResolverPackageNotFound = ProductError<
  "PackageNotFound",
  Readonly<{
    repositoryCoordinate: string;
    packageCoordinate: string;
  }>
>;

export type ResolverPropagationError =
  | RepositorySourceConflict
  | ResolverInvalidReleaseRequirement
  | ResolverPackageNotFound;

export type ResolverPropagationInput = Readonly<{
  directRequirements: ReadonlyArray<DirectInstallRequirement>;
  bindings: ReadonlyArray<BoundRepositorySource>;
}>;

export function propagateResolverState(
  input: ResolverPropagationInput
): Result<ResolverPropagationResult, ResolverPropagationError> {
  const sourceConflict = findSourceConflict(input.directRequirements, input.bindings);
  if (sourceConflict !== undefined) {
    return { ok: false, error: sourceConflict };
  }

  const bindings = [...input.bindings].sort((left, right) =>
    compareUtf8(left.repository.canonical, right.repository.canonical)
  );
  const bindingByRepository = new Map<string, BoundRepositorySource>(
    bindings.map((binding) => [binding.repository.canonical, binding])
  );
  const packageMaps = buildPackageMaps(bindings);

  const explicitGitRepositories = new Set<string>();
  for (const requirement of input.directRequirements) {
    if (requirement.sourceKind === "git") {
      explicitGitRepositories.add(directRepositoryCoordinate(requirement));
    }
  }
  for (const binding of bindings) {
    if (binding.sourceKind === "git") {
      explicitGitRepositories.add(binding.repository.canonical);
    }
  }

  const repositoryWideRoots = new Set<string>();
  const requiredPackages = new Set<string>();
  const packageCoordinates = new Map<string, PackageCoordinate>();
  const expandedPackages = new Map<string, ResolverExpandedPackage>();
  const dependencyEdges = new Map<string, ResolverDependencyEdge>();
  const constraintMaps = new Map<string, Map<string, ResolverReleaseConstraint>>();

  const addRequiredPackage = (coordinate: PackageCoordinate): void => {
    requiredPackages.add(coordinate.canonical);
    packageCoordinates.set(coordinate.canonical, coordinate);
  };

  for (const direct of [...input.directRequirements].sort((left, right) =>
    compareUtf8(directRequirementKey(left), directRequirementKey(right))
  )) {
    const repositoryCoordinate = directRepositoryCoordinate(direct);

    if (direct.kind === "repository") {
      repositoryWideRoots.add(direct.coordinate.canonical);
    } else {
      addRequiredPackage(direct.coordinate);
    }

    if (
      direct.sourceKind === "github-release" &&
      direct.versionRequirement !== undefined
    ) {
      const parsed = parseReleaseRequirement(direct.versionRequirement);
      if (!parsed.ok) {
        return {
          ok: false,
          error: productError("InvalidReleaseRequirement", {
            requirement: direct.versionRequirement,
            reason: parsed.error.facts.reason,
            originKind: "direct",
            originCoordinate: direct.coordinate.canonical
          })
        };
      }
      addConstraint(constraintMaps, repositoryCoordinate, parsed.value.canonical, {
        kind: "direct",
        coordinate: direct.coordinate.canonical
      });
    }
  }

  for (const repositoryCoordinate of sortedStrings(repositoryWideRoots)) {
    const binding = bindingByRepository.get(repositoryCoordinate);
    if (binding === undefined) {
      continue;
    }
    for (const packageFact of sortedPackageFacts(binding.snapshot.packages)) {
      addRequiredPackage(packageFact.coordinate);
    }
  }

  let expandedInPass = true;
  while (expandedInPass) {
    expandedInPass = false;

    for (const packageCoordinate of sortedStrings(requiredPackages)) {
      if (expandedPackages.has(packageCoordinate)) {
        continue;
      }

      const coordinate = packageCoordinates.get(packageCoordinate);
      if (coordinate === undefined) {
        continue;
      }
      const repositoryCoordinate = coordinate.repository.canonical;
      const binding = bindingByRepository.get(repositoryCoordinate);
      if (binding === undefined) {
        continue;
      }

      const packageFact = packageMaps
        .get(repositoryCoordinate)
        ?.get(packageCoordinate);
      if (packageFact === undefined) {
        return {
          ok: false,
          error: productError("PackageNotFound", {
            repositoryCoordinate,
            packageCoordinate
          })
        };
      }

      expandedPackages.set(packageCoordinate, {
        packageCoordinate,
        packageRoot: packageFact.packageRoot,
        contentDigest: packageFact.contentDigest
      });
      expandedInPass = true;

      for (const dependency of [...packageFact.dependencies].sort(
        compareDependencyFacts
      )) {
        const parsed = parseReleaseRequirement(dependency.requirement);
        if (!parsed.ok) {
          return {
            ok: false,
            error: productError("InvalidReleaseRequirement", {
              requirement: dependency.requirement,
              reason: parsed.error.facts.reason,
              originKind: "dependency",
              sourcePackageCoordinate: packageCoordinate,
              targetPackageCoordinate: dependency.target.canonical
            })
          };
        }

        addRequiredPackage(dependency.target);
        const edge = {
          sourcePackageCoordinate: packageCoordinate,
          targetPackageCoordinate: dependency.target.canonical
        } satisfies ResolverDependencyEdge;
        dependencyEdges.set(dependencyEdgeKey(edge), edge);

        const targetRepository = dependency.target.repository.canonical;
        if (!explicitGitRepositories.has(targetRepository)) {
          addConstraint(
            constraintMaps,
            targetRepository,
            parsed.value.canonical,
            {
              kind: "dependency",
              sourcePackageCoordinate: packageCoordinate,
              targetPackageCoordinate: dependency.target.canonical
            }
          );
        }
      }
    }
  }

  const unresolvedRepositories = new Set<string>();
  for (const repositoryCoordinate of repositoryWideRoots) {
    if (!bindingByRepository.has(repositoryCoordinate)) {
      unresolvedRepositories.add(repositoryCoordinate);
    }
  }
  for (const coordinate of packageCoordinates.values()) {
    if (!bindingByRepository.has(coordinate.repository.canonical)) {
      unresolvedRepositories.add(coordinate.repository.canonical);
    }
  }
  for (const repositoryCoordinate of constraintMaps.keys()) {
    if (!bindingByRepository.has(repositoryCoordinate)) {
      unresolvedRepositories.add(repositoryCoordinate);
    }
  }

  return {
    ok: true,
    value: {
      repositoryWideRoots: sortedStrings(repositoryWideRoots),
      requiredPackages: sortedStrings(requiredPackages),
      releaseConstraintSets: buildConstraintSets(constraintMaps),
      sourceBindings: bindings.map(summarizeBinding),
      expandedPackages: [...expandedPackages.values()].sort((left, right) =>
        compareUtf8(left.packageCoordinate, right.packageCoordinate)
      ),
      dependencyEdges: [...dependencyEdges.values()].sort(compareDependencyEdges),
      unresolvedRepositories: sortedStrings(unresolvedRepositories)
    }
  };
}

function findSourceConflict(
  directRequirements: ReadonlyArray<DirectInstallRequirement>,
  bindings: ReadonlyArray<BoundRepositorySource>
): RepositorySourceConflict | undefined {
  const directClaims = new Map<string, Set<string>>();
  for (const direct of directRequirements) {
    const repositoryCoordinate = directRepositoryCoordinate(direct);
    const claims = directClaims.get(repositoryCoordinate) ?? new Set<string>();
    claims.add(directSourceClaim(direct));
    directClaims.set(repositoryCoordinate, claims);
  }

  const bindingGroups = new Map<string, BoundRepositorySource[]>();
  for (const binding of bindings) {
    const existing = bindingGroups.get(binding.repository.canonical) ?? [];
    existing.push(binding);
    bindingGroups.set(binding.repository.canonical, existing);
  }

  const repositories = new Set<string>([
    ...directClaims.keys(),
    ...bindingGroups.keys()
  ]);

  for (const repositoryCoordinate of sortedStrings(repositories)) {
    const claims = sortedStrings(directClaims.get(repositoryCoordinate) ?? []);
    if (claims.length > 1) {
      return productError("RepositorySourceConflict", {
        repositoryCoordinate,
        requestedSources: claims
      });
    }

    const repositoryBindings = bindingGroups.get(repositoryCoordinate) ?? [];
    if (repositoryBindings.length > 1) {
      return productError("RepositorySourceConflict", {
        repositoryCoordinate,
        requestedSources: repositoryBindings
          .map(bindingIdentityClaim)
          .sort(compareUtf8)
      });
    }

    const directClaim = claims[0];
    const binding = repositoryBindings[0];
    if (
      directClaim !== undefined &&
      binding !== undefined &&
      directClaim !== bindingSourceClaim(binding)
    ) {
      return productError("RepositorySourceConflict", {
        repositoryCoordinate,
        requestedSources: [directClaim, bindingSourceClaim(binding)].sort(compareUtf8)
      });
    }
  }

  return undefined;
}

function directRepositoryCoordinate(requirement: DirectInstallRequirement): string {
  return requirement.kind === "package"
    ? requirement.coordinate.repository.canonical
    : requirement.coordinate.canonical;
}

function directSourceClaim(requirement: DirectInstallRequirement): string {
  return requirement.sourceKind === "git"
    ? `git:${requirement.requestedRef}`
    : "github-release";
}

function bindingSourceClaim(binding: BoundRepositorySource): string {
  return binding.sourceKind === "git"
    ? `git:${binding.requestedRef}`
    : "github-release";
}

function bindingIdentityClaim(binding: BoundRepositorySource): string {
  return binding.sourceKind === "git"
    ? `git:${binding.requestedRef}#${binding.exactCommit}`
    : `github-release:${binding.version.canonical}@${binding.actualTag}#${binding.exactCommit}`;
}

function directRequirementKey(requirement: DirectInstallRequirement): string {
  const source =
    requirement.sourceKind === "git"
      ? `git:${requirement.requestedRef}`
      : `github-release:${requirement.versionRequirement ?? ""}`;
  return `${directRepositoryCoordinate(requirement)}\u0000${requirement.kind}\u0000${requirement.coordinate.canonical}\u0000${source}`;
}

function buildPackageMaps(
  bindings: ReadonlyArray<BoundRepositorySource>
): ReadonlyMap<string, ReadonlyMap<string, ResolverPackageFact>> {
  const result = new Map<string, ReadonlyMap<string, ResolverPackageFact>>();

  for (const binding of bindings) {
    const packages = new Map<string, ResolverPackageFact>();
    for (const packageFact of sortedPackageFacts(binding.snapshot.packages)) {
      if (!packages.has(packageFact.coordinate.canonical)) {
        packages.set(packageFact.coordinate.canonical, packageFact);
      }
    }
    result.set(binding.repository.canonical, packages);
  }

  return result;
}

function sortedPackageFacts(
  packages: ReadonlyArray<ResolverPackageFact>
): ReadonlyArray<ResolverPackageFact> {
  return [...packages].sort((left, right) =>
    compareUtf8(packageFactKey(left), packageFactKey(right))
  );
}

function packageFactKey(packageFact: ResolverPackageFact): string {
  const dependencies = [...packageFact.dependencies]
    .map((dependency) => `${dependency.target.canonical}:${dependency.requirement}`)
    .sort(compareUtf8)
    .join("\u0001");
  return `${packageFact.coordinate.canonical}\u0000${packageFact.packageRoot}\u0000${packageFact.contentDigest}\u0000${dependencies}`;
}

function compareDependencyFacts(
  left: ResolverPackageDependencyFact,
  right: ResolverPackageDependencyFact
): number {
  const target = compareUtf8(left.target.canonical, right.target.canonical);
  return target !== 0
    ? target
    : compareUtf8(left.requirement, right.requirement);
}

function addConstraint(
  maps: Map<string, Map<string, ResolverReleaseConstraint>>,
  repositoryCoordinate: string,
  requirement: string,
  origin: ResolverConstraintOrigin
): void {
  const constraints = maps.get(repositoryCoordinate) ?? new Map<string, ResolverReleaseConstraint>();
  const constraint = { requirement, origin } satisfies ResolverReleaseConstraint;
  constraints.set(constraintKey(constraint), constraint);
  maps.set(repositoryCoordinate, constraints);
}

function constraintKey(constraint: ResolverReleaseConstraint): string {
  return `${constraint.requirement}\u0000${originKey(constraint.origin)}`;
}

function originKey(origin: ResolverConstraintOrigin): string {
  return origin.kind === "direct"
    ? `direct:${origin.coordinate}`
    : `dependency:${origin.sourcePackageCoordinate}\u0000${origin.targetPackageCoordinate}`;
}

function buildConstraintSets(
  maps: ReadonlyMap<string, ReadonlyMap<string, ResolverReleaseConstraint>>
): ReadonlyArray<ResolverReleaseConstraintSet> {
  return [...maps.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([repositoryCoordinate, constraints]) => ({
      repositoryCoordinate,
      constraints: [...constraints.values()].sort((left, right) => {
        const requirement = compareUtf8(left.requirement, right.requirement);
        return requirement !== 0
          ? requirement
          : compareUtf8(originKey(left.origin), originKey(right.origin));
      })
    }));
}

function summarizeBinding(binding: BoundRepositorySource): ResolverSourceBindingSummary {
  if (binding.sourceKind === "git") {
    return {
      repositoryCoordinate: binding.repository.canonical,
      sourceKind: "git",
      requestedRef: binding.requestedRef,
      exactCommit: binding.exactCommit
    };
  }

  return {
    repositoryCoordinate: binding.repository.canonical,
    sourceKind: "github-release",
    version: binding.version.canonical,
    actualTag: binding.actualTag,
    exactCommit: binding.exactCommit,
    immutable: binding.immutable
  };
}

function dependencyEdgeKey(edge: ResolverDependencyEdge): string {
  return `${edge.sourcePackageCoordinate}\u0000${edge.targetPackageCoordinate}`;
}

function compareDependencyEdges(
  left: ResolverDependencyEdge,
  right: ResolverDependencyEdge
): number {
  const source = compareUtf8(
    left.sourcePackageCoordinate,
    right.sourcePackageCoordinate
  );
  return source !== 0
    ? source
    : compareUtf8(left.targetPackageCoordinate, right.targetPackageCoordinate);
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareUtf8);
}
