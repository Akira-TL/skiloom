import {
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../coordinate/index.js";
import { compareUtf8 } from "./ordering.js";
import type {
  DirectInstallRequirement,
  ResolverDependencyEdge,
  ResolverExpandedPackage,
  ResolverSourceBindingSummary
} from "./propagation.js";
import type { ResolverCandidateGraph } from "./search.js";

export type SourceAuthorizationDelta =
  | Readonly<{
      kind: "repository-added";
      repositoryCoordinate: string;
      candidate: ResolverSourceBindingSummary;
    }>
  | Readonly<{
      kind: "repository-removed";
      repositoryCoordinate: string;
      previous: ResolverSourceBindingSummary;
    }>
  | Readonly<{
      kind: "source-kind-changed";
      repositoryCoordinate: string;
      previousSourceKind: ResolverSourceBindingSummary["sourceKind"];
      candidateSourceKind: ResolverSourceBindingSummary["sourceKind"];
    }>
  | Readonly<{
      kind: "release-version-changed";
      repositoryCoordinate: string;
      previousVersion: string;
      candidateVersion: string;
    }>
  | Readonly<{
      kind: "release-tag-changed";
      repositoryCoordinate: string;
      previousTag: string;
      candidateTag: string;
    }>
  | Readonly<{
      kind: "release-commit-changed";
      repositoryCoordinate: string;
      previousCommit: string;
      candidateCommit: string;
    }>
  | Readonly<{
      kind: "release-retarget";
      repositoryCoordinate: string;
      actualTag: string;
      previousCommit: string;
      candidateCommit: string;
      risk: "high";
    }>
  | Readonly<{
      kind: "git-commit-changed";
      repositoryCoordinate: string;
      previousCommit: string;
      candidateCommit: string;
    }>
  | Readonly<{
      kind: "immutable-signal-changed";
      repositoryCoordinate: string;
      previousImmutable: boolean | null;
      candidateImmutable: boolean | null;
      advisory: true;
    }>;

export type RepositoryOriginFact =
  | Readonly<{
      repositoryCoordinate: string;
      kind: "direct";
      directRequirementCoordinate: string;
    }>
  | Readonly<{
      repositoryCoordinate: string;
      kind: "transitive";
      directRequirementCoordinate: string;
      packagePath: ReadonlyArray<string>;
    }>;

export type CandidatePackageDelta =
  | Readonly<{
      kind: "package-added";
      packageCoordinate: string;
      candidate: Readonly<{
        packageRoot: string;
        contentDigest: string;
      }>;
    }>
  | Readonly<{
      kind: "package-removed";
      packageCoordinate: string;
      previous: Readonly<{
        packageRoot: string;
        contentDigest: string;
      }>;
    }>
  | Readonly<{
      kind: "package-root-changed";
      packageCoordinate: string;
      previousRoot: string;
      candidateRoot: string;
    }>
  | Readonly<{
      kind: "package-content-changed";
      packageCoordinate: string;
      previousDigest: string;
      candidateDigest: string;
    }>;

export type CandidateDependencyEdgeDelta = Readonly<{
  kind: "dependency-edge-added" | "dependency-edge-removed";
  sourcePackageCoordinate: string;
  targetPackageCoordinate: string;
}>;

export type CandidateComparison = Readonly<{
  previousRepositories: ReadonlyArray<ResolverSourceBindingSummary>;
  candidateRepositories: ReadonlyArray<ResolverSourceBindingSummary>;
  sourceDeltas: ReadonlyArray<SourceAuthorizationDelta>;
  repositoryOrigins: ReadonlyArray<RepositoryOriginFact>;
  packageDeltas: ReadonlyArray<CandidatePackageDelta>;
  dependencyEdgeDeltas: ReadonlyArray<CandidateDependencyEdgeDelta>;
}>;

export type CandidateComparisonInput = Readonly<{
  previous?: ResolverCandidateGraph | undefined;
  candidate: ResolverCandidateGraph;
  directRequirements: ReadonlyArray<DirectInstallRequirement>;
}>;

type NormalizedPackage = Readonly<{
  packageCoordinate: string;
  packageRoot: string;
  contentDigest: string;
}>;

type NormalizedEdge = Readonly<{
  sourcePackageCoordinate: string;
  targetPackageCoordinate: string;
}>;

type OriginPathState = Readonly<{
  directRequirementCoordinate: string;
  packagePath: ReadonlyArray<string>;
}>;

export function compareCandidateGraphs(input: CandidateComparisonInput): CandidateComparison {
  const previousRepositories = normalizeRepositorySet(
    input.previous?.sourceBindings ?? []
  );
  const candidateRepositories = normalizeRepositorySet(
    input.candidate.sourceBindings
  );
  const previousPackages = normalizePackages(input.previous?.packages ?? []);
  const candidatePackages = normalizePackages(input.candidate.packages);
  const previousEdges = normalizeEdges(input.previous?.dependencyEdges ?? []);
  const candidateEdges = normalizeEdges(input.candidate.dependencyEdges);

  const sourceDeltas = compareRepositorySets(
    previousRepositories,
    candidateRepositories
  );
  const addedRepositories = sourceDeltas
    .filter((delta): delta is Extract<SourceAuthorizationDelta, { kind: "repository-added" }> =>
      delta.kind === "repository-added"
    )
    .map((delta) => delta.repositoryCoordinate);

  return {
    previousRepositories,
    candidateRepositories,
    sourceDeltas,
    repositoryOrigins: buildRepositoryOrigins(
      addedRepositories,
      input.directRequirements,
      candidatePackages,
      candidateEdges
    ),
    packageDeltas: comparePackages(previousPackages, candidatePackages),
    dependencyEdgeDeltas: compareEdges(previousEdges, candidateEdges)
  };
}

function normalizeRepositorySet(
  bindings: ReadonlyArray<ResolverSourceBindingSummary>
): ReadonlyArray<ResolverSourceBindingSummary> {
  const normalized = bindings.map(normalizeSourceBinding).sort(compareSourceBindings);
  const byRepository = new Map<string, ResolverSourceBindingSummary>();
  for (const binding of normalized) {
    if (!byRepository.has(binding.repositoryCoordinate)) {
      byRepository.set(binding.repositoryCoordinate, binding);
    }
  }
  return [...byRepository.values()].sort(compareSourceBindings);
}

function normalizeSourceBinding(
  binding: ResolverSourceBindingSummary
): ResolverSourceBindingSummary {
  const repositoryCoordinate = canonicalRepositoryCoordinate(
    binding.repositoryCoordinate
  );
  if (binding.sourceKind === "git") {
    return {
      repositoryCoordinate,
      sourceKind: "git",
      requestedRef: binding.requestedRef,
      exactCommit: binding.exactCommit
    };
  }
  return {
    repositoryCoordinate,
    sourceKind: "github-release",
    version: binding.version,
    actualTag: binding.actualTag,
    exactCommit: binding.exactCommit,
    immutable: binding.immutable
  };
}

function compareRepositorySets(
  previous: ReadonlyArray<ResolverSourceBindingSummary>,
  candidate: ReadonlyArray<ResolverSourceBindingSummary>
): ReadonlyArray<SourceAuthorizationDelta> {
  const previousByRepository = new Map(
    previous.map((binding) => [binding.repositoryCoordinate, binding])
  );
  const candidateByRepository = new Map(
    candidate.map((binding) => [binding.repositoryCoordinate, binding])
  );
  const coordinates = sortedStrings(new Set([
    ...previousByRepository.keys(),
    ...candidateByRepository.keys()
  ]));
  const deltas: SourceAuthorizationDelta[] = [];

  for (const repositoryCoordinate of coordinates) {
    const oldBinding = previousByRepository.get(repositoryCoordinate);
    const newBinding = candidateByRepository.get(repositoryCoordinate);
    if (oldBinding === undefined && newBinding !== undefined) {
      deltas.push({
        kind: "repository-added",
        repositoryCoordinate,
        candidate: newBinding
      });
      continue;
    }
    if (oldBinding !== undefined && newBinding === undefined) {
      deltas.push({
        kind: "repository-removed",
        repositoryCoordinate,
        previous: oldBinding
      });
      continue;
    }
    if (oldBinding === undefined || newBinding === undefined) {
      continue;
    }
    if (oldBinding.sourceKind !== newBinding.sourceKind) {
      deltas.push({
        kind: "source-kind-changed",
        repositoryCoordinate,
        previousSourceKind: oldBinding.sourceKind,
        candidateSourceKind: newBinding.sourceKind
      });
      continue;
    }

    if (oldBinding.sourceKind === "git" && newBinding.sourceKind === "git") {
      if (oldBinding.exactCommit !== newBinding.exactCommit) {
        deltas.push({
          kind: "git-commit-changed",
          repositoryCoordinate,
          previousCommit: oldBinding.exactCommit,
          candidateCommit: newBinding.exactCommit
        });
      }
      continue;
    }

    if (
      oldBinding.sourceKind === "github-release" &&
      newBinding.sourceKind === "github-release"
    ) {
      if (oldBinding.version !== newBinding.version) {
        deltas.push({
          kind: "release-version-changed",
          repositoryCoordinate,
          previousVersion: oldBinding.version,
          candidateVersion: newBinding.version
        });
      }
      if (oldBinding.actualTag !== newBinding.actualTag) {
        deltas.push({
          kind: "release-tag-changed",
          repositoryCoordinate,
          previousTag: oldBinding.actualTag,
          candidateTag: newBinding.actualTag
        });
      }
      if (oldBinding.exactCommit !== newBinding.exactCommit) {
        if (oldBinding.actualTag === newBinding.actualTag) {
          deltas.push({
            kind: "release-retarget",
            repositoryCoordinate,
            actualTag: oldBinding.actualTag,
            previousCommit: oldBinding.exactCommit,
            candidateCommit: newBinding.exactCommit,
            risk: "high"
          });
        } else {
          deltas.push({
            kind: "release-commit-changed",
            repositoryCoordinate,
            previousCommit: oldBinding.exactCommit,
            candidateCommit: newBinding.exactCommit
          });
        }
      }
      if (oldBinding.immutable !== newBinding.immutable) {
        deltas.push({
          kind: "immutable-signal-changed",
          repositoryCoordinate,
          previousImmutable: oldBinding.immutable,
          candidateImmutable: newBinding.immutable,
          advisory: true
        });
      }
    }
  }

  return deltas.sort((left, right) => {
    const repository = compareUtf8(
      left.repositoryCoordinate,
      right.repositoryCoordinate
    );
    return repository !== 0 ? repository : compareUtf8(left.kind, right.kind);
  });
}

function normalizePackages(
  packages: ReadonlyArray<ResolverExpandedPackage>
): ReadonlyArray<NormalizedPackage> {
  const normalized = packages
    .map((packageFact) => ({
      packageCoordinate: canonicalPackageCoordinate(packageFact.packageCoordinate),
      packageRoot: packageFact.packageRoot,
      contentDigest: packageFact.contentDigest
    }))
    .sort((left, right) =>
      compareUtf8(left.packageCoordinate, right.packageCoordinate)
    );
  const byCoordinate = new Map<string, NormalizedPackage>();
  for (const packageFact of normalized) {
    if (!byCoordinate.has(packageFact.packageCoordinate)) {
      byCoordinate.set(packageFact.packageCoordinate, packageFact);
    }
  }
  return [...byCoordinate.values()];
}

function comparePackages(
  previous: ReadonlyArray<NormalizedPackage>,
  candidate: ReadonlyArray<NormalizedPackage>
): ReadonlyArray<CandidatePackageDelta> {
  const previousByCoordinate = new Map(
    previous.map((packageFact) => [packageFact.packageCoordinate, packageFact])
  );
  const candidateByCoordinate = new Map(
    candidate.map((packageFact) => [packageFact.packageCoordinate, packageFact])
  );
  const coordinates = sortedStrings(new Set([
    ...previousByCoordinate.keys(),
    ...candidateByCoordinate.keys()
  ]));
  const deltas: CandidatePackageDelta[] = [];

  for (const packageCoordinate of coordinates) {
    const oldPackage = previousByCoordinate.get(packageCoordinate);
    const newPackage = candidateByCoordinate.get(packageCoordinate);
    if (oldPackage === undefined && newPackage !== undefined) {
      deltas.push({
        kind: "package-added",
        packageCoordinate,
        candidate: {
          packageRoot: newPackage.packageRoot,
          contentDigest: newPackage.contentDigest
        }
      });
      continue;
    }
    if (oldPackage !== undefined && newPackage === undefined) {
      deltas.push({
        kind: "package-removed",
        packageCoordinate,
        previous: {
          packageRoot: oldPackage.packageRoot,
          contentDigest: oldPackage.contentDigest
        }
      });
      continue;
    }
    if (oldPackage === undefined || newPackage === undefined) {
      continue;
    }
    if (oldPackage.packageRoot !== newPackage.packageRoot) {
      deltas.push({
        kind: "package-root-changed",
        packageCoordinate,
        previousRoot: oldPackage.packageRoot,
        candidateRoot: newPackage.packageRoot
      });
    }
    if (oldPackage.contentDigest !== newPackage.contentDigest) {
      deltas.push({
        kind: "package-content-changed",
        packageCoordinate,
        previousDigest: oldPackage.contentDigest,
        candidateDigest: newPackage.contentDigest
      });
    }
  }

  return deltas.sort((left, right) => {
    const coordinate = compareUtf8(left.packageCoordinate, right.packageCoordinate);
    return coordinate !== 0 ? coordinate : compareUtf8(left.kind, right.kind);
  });
}

function normalizeEdges(
  edges: ReadonlyArray<ResolverDependencyEdge>
): ReadonlyArray<NormalizedEdge> {
  const normalized = edges
    .map((edge) => ({
      sourcePackageCoordinate: canonicalPackageCoordinate(
        edge.sourcePackageCoordinate
      ),
      targetPackageCoordinate: canonicalPackageCoordinate(
        edge.targetPackageCoordinate
      )
    }))
    .sort(compareNormalizedEdges);
  const byKey = new Map<string, NormalizedEdge>();
  for (const edge of normalized) {
    const key = edgeKey(edge);
    if (!byKey.has(key)) {
      byKey.set(key, edge);
    }
  }
  return [...byKey.values()];
}

function compareEdges(
  previous: ReadonlyArray<NormalizedEdge>,
  candidate: ReadonlyArray<NormalizedEdge>
): ReadonlyArray<CandidateDependencyEdgeDelta> {
  const previousByKey = new Map(previous.map((edge) => [edgeKey(edge), edge]));
  const candidateByKey = new Map(candidate.map((edge) => [edgeKey(edge), edge]));
  const keys = sortedStrings(new Set([
    ...previousByKey.keys(),
    ...candidateByKey.keys()
  ]));
  const deltas: CandidateDependencyEdgeDelta[] = [];

  for (const key of keys) {
    const oldEdge = previousByKey.get(key);
    const newEdge = candidateByKey.get(key);
    if (oldEdge === undefined && newEdge !== undefined) {
      deltas.push({
        kind: "dependency-edge-added",
        ...newEdge
      });
    } else if (oldEdge !== undefined && newEdge === undefined) {
      deltas.push({
        kind: "dependency-edge-removed",
        ...oldEdge
      });
    }
  }
  return deltas;
}

function buildRepositoryOrigins(
  addedRepositories: ReadonlyArray<string>,
  directRequirements: ReadonlyArray<DirectInstallRequirement>,
  packages: ReadonlyArray<NormalizedPackage>,
  edges: ReadonlyArray<NormalizedEdge>
): ReadonlyArray<RepositoryOriginFact> {
  const origins: RepositoryOriginFact[] = [];
  for (const repositoryCoordinate of [...addedRepositories].sort(compareUtf8)) {
    const direct = directRequirements
      .filter(
        (requirement) =>
          directRepositoryCoordinate(requirement) === repositoryCoordinate
      )
      .map(directRequirementCoordinate)
      .sort(compareUtf8)[0];
    if (direct !== undefined) {
      origins.push({
        repositoryCoordinate,
        kind: "direct",
        directRequirementCoordinate: direct
      });
      continue;
    }

    const transitive = findTransitiveOrigin(
      repositoryCoordinate,
      directRequirements,
      packages,
      edges
    );
    if (transitive !== undefined) {
      origins.push({
        repositoryCoordinate,
        kind: "transitive",
        directRequirementCoordinate: transitive.directRequirementCoordinate,
        packagePath: transitive.packagePath
      });
    }
  }
  return origins;
}

function findTransitiveOrigin(
  repositoryCoordinate: string,
  directRequirements: ReadonlyArray<DirectInstallRequirement>,
  packages: ReadonlyArray<NormalizedPackage>,
  edges: ReadonlyArray<NormalizedEdge>
): OriginPathState | undefined {
  const packageCoordinates = new Set(packages.map((packageFact) => packageFact.packageCoordinate));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.sourcePackageCoordinate) ?? [];
    targets.push(edge.targetPackageCoordinate);
    outgoing.set(edge.sourcePackageCoordinate, targets);
  }
  for (const targets of outgoing.values()) {
    targets.sort(compareUtf8);
  }

  const queue: OriginPathState[] = [];
  for (const requirement of [...directRequirements].sort((left, right) =>
    compareUtf8(directRequirementCoordinate(left), directRequirementCoordinate(right))
  )) {
    const directCoordinate = directRequirementCoordinate(requirement);
    if (requirement.kind === "package") {
      if (packageCoordinates.has(requirement.coordinate.canonical)) {
        queue.push({
          directRequirementCoordinate: directCoordinate,
          packagePath: [requirement.coordinate.canonical]
        });
      }
      continue;
    }

    for (const packageFact of packages) {
      if (
        packageRepositoryCoordinate(packageFact.packageCoordinate) ===
        requirement.coordinate.canonical
      ) {
        queue.push({
          directRequirementCoordinate: directCoordinate,
          packagePath: [packageFact.packageCoordinate]
        });
      }
    }
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    queue.sort(compareOriginPathStates);
    const state = queue.shift();
    if (state === undefined) {
      break;
    }
    const current = state.packagePath[state.packagePath.length - 1];
    if (current === undefined) {
      continue;
    }
    if (packageRepositoryCoordinate(current) === repositoryCoordinate) {
      return state;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const target of outgoing.get(current) ?? []) {
      if (state.packagePath.includes(target)) {
        continue;
      }
      queue.push({
        directRequirementCoordinate: state.directRequirementCoordinate,
        packagePath: [...state.packagePath, target]
      });
    }
  }

  return undefined;
}

function compareOriginPathStates(left: OriginPathState, right: OriginPathState): number {
  const direct = compareUtf8(
    left.directRequirementCoordinate,
    right.directRequirementCoordinate
  );
  if (direct !== 0) {
    return direct;
  }
  const commonLength = Math.min(left.packagePath.length, right.packagePath.length);
  for (let index = 0; index < commonLength; index += 1) {
    const compared = compareUtf8(
      left.packagePath[index] ?? "",
      right.packagePath[index] ?? ""
    );
    if (compared !== 0) {
      return compared;
    }
  }
  return left.packagePath.length - right.packagePath.length;
}

function directRepositoryCoordinate(requirement: DirectInstallRequirement): string {
  return requirement.kind === "package"
    ? requirement.coordinate.repository.canonical
    : requirement.coordinate.canonical;
}

function directRequirementCoordinate(requirement: DirectInstallRequirement): string {
  return requirement.coordinate.canonical;
}

function canonicalRepositoryCoordinate(input: string): string {
  const parsed = parseRepositoryCoordinate(input);
  return parsed.ok ? parsed.value.canonical : input;
}

function canonicalPackageCoordinate(input: string): string {
  const parsed = parsePackageCoordinate(input);
  return parsed.ok ? parsed.value.canonical : input;
}

function packageRepositoryCoordinate(input: string): string {
  const parsed = parsePackageCoordinate(input);
  if (parsed.ok) {
    return parsed.value.repository.canonical;
  }
  return input.split("/").slice(0, 2).join("/");
}

function compareSourceBindings(
  left: ResolverSourceBindingSummary,
  right: ResolverSourceBindingSummary
): number {
  const repository = compareUtf8(
    left.repositoryCoordinate,
    right.repositoryCoordinate
  );
  if (repository !== 0) {
    return repository;
  }
  return compareUtf8(sourceBindingKey(left), sourceBindingKey(right));
}

function sourceBindingKey(binding: ResolverSourceBindingSummary): string {
  return binding.sourceKind === "git"
    ? `git\u0000${binding.requestedRef}\u0000${binding.exactCommit}`
    : `github-release\u0000${binding.version}\u0000${binding.actualTag}\u0000${binding.exactCommit}\u0000${immutableKey(binding.immutable)}`;
}

function immutableKey(value: boolean | null): string {
  return value === null ? "n" : value ? "1" : "0";
}

function compareNormalizedEdges(left: NormalizedEdge, right: NormalizedEdge): number {
  const source = compareUtf8(
    left.sourcePackageCoordinate,
    right.sourcePackageCoordinate
  );
  return source !== 0
    ? source
    : compareUtf8(left.targetPackageCoordinate, right.targetPackageCoordinate);
}

function edgeKey(edge: NormalizedEdge): string {
  return `${edge.sourcePackageCoordinate}\u0000${edge.targetPackageCoordinate}`;
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareUtf8);
}
