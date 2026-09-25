import {
  parseRepositoryCoordinate,
  type RepositoryCoordinate
} from "../../domain/coordinate/index.js";
import type {
  CandidateComparison,
  DirectInstallRequirement,
  FixedReleaseRepositorySource,
  ResolverCandidateGraph,
  ResolverGitBinding,
  ResolverSearchError
} from "../../domain/resolver/index.js";
import {
  compareCandidateGraphs,
  resolveTargetGraph
} from "../../domain/resolver/index.js";
import {
  parseReleaseRequirement
} from "../../domain/requirement/index.js";
import type {
  RegistryDirectRequirement,
  RegistryTargetState
} from "../registry/index.js";
import {
  acquireGitHubGitBinding,
  acquireGitHubReleaseRepositorySource,
  type AcquireGitHubGitBindingError,
  type AcquireGitHubReleaseRepositorySourceError,
  type GitHubSourceRuntimeInput
} from "../source/github/index.js";

export type LifecycleCandidateError =
  | AcquireGitHubGitBindingError
  | AcquireGitHubReleaseRepositorySourceError
  | ResolverSearchError;

export type LifecycleCandidatePlan = Readonly<{
  directRequirements: ReadonlyArray<DirectInstallRequirement>;
  candidate: ResolverCandidateGraph;
  comparison: CandidateComparison;
  noChange: boolean;
}>;

export type ComputeLifecycleCandidateInput =
  GitHubSourceRuntimeInput &
    Readonly<{
      directRequirements: ReadonlyArray<DirectInstallRequirement>;
      currentState?: RegistryTargetState;
    }>;

type SourceState = Readonly<{
  releaseSources: Map<string, FixedReleaseRepositorySource>;
  gitBindings: Map<string, ResolverGitBinding>;
  attemptedReleaseRepositories: Set<string>;
  deferredSourceErrors: Map<
    string,
    AcquireGitHubReleaseRepositorySourceError
  >;
}>;

export async function computeLifecycleCandidate(
  input: ComputeLifecycleCandidateInput
): Promise<
  | Readonly<{ ok: true; value: LifecycleCandidatePlan }>
  | Readonly<{ ok: false; error: LifecycleCandidateError }>
> {
  const directRequirements = normalizeDirectRequirements(
    input.directRequirements
  );

  const preflight = resolveTargetGraph({
    directRequirements,
    releaseSources: [],
    gitBindings: []
  });
  if (
    !preflight.ok &&
    isDirectRequirementFailure(preflight.error)
  ) {
    return preflight;
  }

  const sourceState: SourceState = {
    releaseSources: new Map(),
    gitBindings: new Map(),
    attemptedReleaseRepositories: new Set(),
    deferredSourceErrors: new Map()
  };

  const directRepositories = collectDirectRepositories(
    directRequirements
  );
  for (const entry of directRepositories) {
    if (entry.sourceKind === "git") {
      const binding = await acquireGitHubGitBinding({
        repository: entry.repository,
        requestedRef: entry.requestedRef,
        repositoryTransport: input.repositoryTransport,
        transport: input.transport,
        ...(input.gitTransport === undefined
          ? {}
          : { gitTransport: input.gitTransport }),
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
      if (!binding.ok) {
        return binding;
      }
      sourceState.gitBindings.set(
        entry.repository.canonical,
        binding.value
      );
      continue;
    }

    const source = await acquireReleaseSource(
      input,
      entry.repository
    );
    sourceState.attemptedReleaseRepositories.add(
      entry.repository.canonical
    );
    if (!source.ok) {
      return source;
    }
    sourceState.releaseSources.set(
      entry.repository.canonical,
      source.value
    );
  }

  await prefetchReachableReleaseSources(
    input,
    sourceState
  );

  const resolved = resolveTargetGraph({
    directRequirements,
    releaseSources: sortedReleaseSources(
      sourceState.releaseSources
    ),
    gitBindings: sortedGitBindings(sourceState.gitBindings)
  });
  if (!resolved.ok) {
    const deferred = firstRelevantDeferredError(
      resolved.error,
      sourceState
    );
    return deferred === undefined
      ? resolved
      : { ok: false, error: deferred };
  }

  const previous =
    input.currentState === undefined
      ? undefined
      : registryStateToCandidateGraph(input.currentState);
  const comparison = compareCandidateGraphs({
    ...(previous === undefined ? {} : { previous }),
    candidate: resolved.value,
    directRequirements
  });

  return {
    ok: true,
    value: {
      directRequirements,
      candidate: resolved.value,
      comparison,
      noChange:
        previous !== undefined &&
        comparisonHasNoDeltas(comparison) &&
        sameDirectRequirementSet(
          directRequirements,
          input.currentState?.directRequirements ?? []
        )
    }
  };
}

type DirectRepositorySource =
  | Readonly<{
      repository: RepositoryCoordinate;
      sourceKind: "github-release";
    }>
  | Readonly<{
      repository: RepositoryCoordinate;
      sourceKind: "git";
      requestedRef: string;
    }>;

function collectDirectRepositories(
  directRequirements: ReadonlyArray<DirectInstallRequirement>
): ReadonlyArray<DirectRepositorySource> {
  const byKey = new Map<string, DirectRepositorySource>();

  for (const requirement of directRequirements) {
    const repository = directRequirementRepository(requirement);
    const entry: DirectRepositorySource =
      requirement.sourceKind === "git"
        ? {
            repository,
            sourceKind: "git",
            requestedRef: requirement.requestedRef
          }
        : {
            repository,
            sourceKind: "github-release"
          };
    const key =
      entry.sourceKind === "git"
        ? `${repository.canonical}\u0000git\u0000${entry.requestedRef}`
        : `${repository.canonical}\u0000github-release`;
    byKey.set(key, entry);
  }

  return [...byKey.values()].sort((left, right) =>
    compareUtf8(
      directRepositorySourceKey(left),
      directRepositorySourceKey(right)
    )
  );
}

function directRepositorySourceKey(
  entry: DirectRepositorySource
): string {
  return entry.sourceKind === "git"
    ? `${entry.repository.canonical}\u0000git\u0000${entry.requestedRef}`
    : `${entry.repository.canonical}\u0000github-release`;
}

async function acquireReleaseSource(
  input: ComputeLifecycleCandidateInput,
  repository: RepositoryCoordinate
): Promise<
  | Readonly<{
      ok: true;
      value: FixedReleaseRepositorySource;
    }>
  | Readonly<{
      ok: false;
      error: AcquireGitHubReleaseRepositorySourceError;
    }>
> {
  return acquireGitHubReleaseRepositorySource({
    repository,
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
}

async function prefetchReachableReleaseSources(
  input: ComputeLifecycleCandidateInput,
  state: SourceState
): Promise<void> {
  for (;;) {
    const nextRepository =
      allKnownDependencyRepositories(state).find(
        (dependency) =>
          shouldAcquireReleaseRepository(
            dependency.canonical,
            state
          )
      );
    if (nextRepository === undefined) {
      return;
    }

    state.attemptedReleaseRepositories.add(
      nextRepository.canonical
    );
    const source = await acquireReleaseSource(
      input,
      nextRepository
    );
    if (source.ok) {
      state.releaseSources.set(
        nextRepository.canonical,
        source.value
      );
      state.deferredSourceErrors.delete(
        nextRepository.canonical
      );
    } else {
      state.deferredSourceErrors.set(
        nextRepository.canonical,
        source.error
      );
    }
  }
}

function shouldAcquireReleaseRepository(
  repositoryCoordinate: string,
  state: SourceState
): boolean {
  return (
    !state.gitBindings.has(repositoryCoordinate) &&
    !state.releaseSources.has(repositoryCoordinate) &&
    !state.attemptedReleaseRepositories.has(
      repositoryCoordinate
    )
  );
}

function normalizeSubjectRepository(
  coordinate: string
): string {
  const repository = parseRepositoryCoordinate(coordinate);
  return repository.ok
    ? repository.value.canonical
    : repositoryFromPackageCoordinate(coordinate);
}

function repositoryFromPackageCoordinate(
  coordinate: string
): string {
  return coordinate.split("/").slice(0, 2).join("/");
}

function allKnownDependencyRepositories(
  state: SourceState
): ReadonlyArray<RepositoryCoordinate> {
  const snapshots = [
    ...[...state.releaseSources.values()].flatMap((source) =>
      source.releases.map((entry) => entry.snapshot)
    ),
    ...[...state.gitBindings.values()].map(
      (binding) => binding.snapshot
    )
  ];
  return dependencyRepositories(snapshots);
}

function dependencyRepositories(
  snapshots: ReadonlyArray<
    FixedReleaseRepositorySource["releases"][number]["snapshot"]
  >
): ReadonlyArray<RepositoryCoordinate> {
  const byCoordinate = new Map<string, RepositoryCoordinate>();

  for (const snapshot of snapshots) {
    for (const packageFact of snapshot.packages) {
      for (const dependency of packageFact.dependencies) {
        byCoordinate.set(
          dependency.target.repository.canonical,
          dependency.target.repository
        );
      }
    }
  }

  return [...byCoordinate.values()].sort((left, right) =>
    compareUtf8(left.canonical, right.canonical)
  );
}

function firstRelevantDeferredError(
  error: ResolverSearchError,
  state: SourceState
): AcquireGitHubReleaseRepositorySourceError | undefined {
  if (error.code === "UnsatisfiableReleaseRequirements") {
    return state.deferredSourceErrors.get(
      error.facts.repositoryCoordinate
    );
  }
  if (error.code !== "UnresolvableDependencyGraph") {
    return undefined;
  }

  const deferredByAttempt = error.facts.attempts.map((attempt) =>
    deferredCoordinatesForSubject(
      normalizeSubjectRepository(attempt.subjectCoordinate),
      state
    )
  );
  if (
    deferredByAttempt.length === 0 ||
    deferredByAttempt.some((coordinates) => coordinates.length === 0)
  ) {
    return undefined;
  }

  const common = deferredByAttempt[0]!.filter((coordinate) =>
    deferredByAttempt.every((coordinates) =>
      coordinates.includes(coordinate)
    )
  );
  if (common.length !== 1) {
    return undefined;
  }

  return state.deferredSourceErrors.get(common[0]!);
}

function deferredCoordinatesForSubject(
  repositoryCoordinate: string,
  state: SourceState
): ReadonlyArray<string> {
  return state.deferredSourceErrors.has(repositoryCoordinate)
    ? [repositoryCoordinate]
    : [];
}

function registryStateToCandidateGraph(
  state: RegistryTargetState
): ResolverCandidateGraph {
  return {
    sourceBindings: state.resolvedSources
      .map((source) =>
        source.sourceKind === "git"
          ? {
              repositoryCoordinate:
                source.repositoryCoordinate,
              sourceKind: "git" as const,
              requestedRef: source.requestedRef,
              exactCommit: source.exactCommit
            }
          : {
              repositoryCoordinate:
                source.repositoryCoordinate,
              sourceKind: "github-release" as const,
              version: source.version,
              actualTag: source.actualTag,
              exactCommit: source.exactCommit,
              immutable: source.immutable
            }
      )
      .sort((left, right) =>
        compareUtf8(
          left.repositoryCoordinate,
          right.repositoryCoordinate
        )
      ),
    packages: state.resolvedPackages
      .map((entry) => ({
        packageCoordinate: entry.packageCoordinate,
        packageRoot: entry.packageRoot,
        contentDigest: entry.contentDigest
      }))
      .sort((left, right) =>
        compareUtf8(
          left.packageCoordinate,
          right.packageCoordinate
        )
      ),
    dependencyEdges: state.dependencyEdges
      .map((edge) => ({
        sourcePackageCoordinate: edge.fromPackage,
        targetPackageCoordinate: edge.toPackage
      }))
      .sort((left, right) =>
        compareUtf8(
          `${left.sourcePackageCoordinate}\u0000${left.targetPackageCoordinate}`,
          `${right.sourcePackageCoordinate}\u0000${right.targetPackageCoordinate}`
        )
      )
  };
}

function comparisonHasNoDeltas(
  comparison: CandidateComparison
): boolean {
  return (
    comparison.sourceDeltas.length === 0 &&
    comparison.packageDeltas.length === 0 &&
    comparison.dependencyEdgeDeltas.length === 0
  );
}

function sameDirectRequirementSet(
  requested: ReadonlyArray<DirectInstallRequirement>,
  accepted: ReadonlyArray<RegistryDirectRequirement>
): boolean {
  const left = requested
    .map(domainDirectRequirementKey)
    .sort(compareUtf8);
  const right = accepted
    .map(registryDirectRequirementKey)
    .sort(compareUtf8);

  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function normalizeDirectRequirements(
  requirements: ReadonlyArray<DirectInstallRequirement>
): ReadonlyArray<DirectInstallRequirement> {
  const byKey = new Map<string, DirectInstallRequirement>();

  for (const requirement of requirements) {
    const normalized = normalizeDirectRequirement(requirement);
    byKey.set(domainDirectRequirementKey(normalized), normalized);
  }

  return [...byKey.values()].sort((left, right) =>
    compareUtf8(
      domainDirectRequirementKey(left),
      domainDirectRequirementKey(right)
    )
  );
}

function normalizeDirectRequirement(
  requirement: DirectInstallRequirement
): DirectInstallRequirement {
  if (requirement.sourceKind === "git") {
    return requirement;
  }

  const versionRequirement = requirement.versionRequirement;
  if (versionRequirement === undefined) {
    return requirement;
  }
  const parsed = parseReleaseRequirement(versionRequirement);
  if (!parsed.ok) {
    return requirement;
  }

  return {
    ...requirement,
    versionRequirement: parsed.value.canonical
  };
}

function domainDirectRequirementKey(
  requirement: DirectInstallRequirement
): string {
  const source =
    requirement.sourceKind === "git"
      ? `git\u0000${requirement.requestedRef}`
      : `github-release\u0000${canonicalRequirement(
          requirement.versionRequirement
        )}`;
  return `${requirement.kind}\u0000${requirement.coordinate.canonical}\u0000${source}`;
}

function registryDirectRequirementKey(
  requirement: RegistryDirectRequirement
): string {
  const source =
    requirement.sourceKind === "git"
      ? `git\u0000${requirement.requestedRef}`
      : `github-release\u0000${canonicalRequirement(
          requirement.versionRequirement ?? undefined
        )}`;
  return `${requirement.kind}\u0000${requirement.coordinate}\u0000${source}`;
}

function canonicalRequirement(
  requirement: string | undefined
): string {
  if (requirement === undefined) {
    return "";
  }
  const parsed = parseReleaseRequirement(requirement);
  return parsed.ok ? parsed.value.canonical : requirement;
}

function directRequirementRepository(
  requirement: DirectInstallRequirement
): RepositoryCoordinate {
  return requirement.kind === "package"
    ? requirement.coordinate.repository
    : requirement.coordinate;
}

function isDirectRequirementFailure(
  error: ResolverSearchError
): boolean {
  return (
    error.code === "RepositorySourceConflict" ||
    error.code === "InvalidReleaseRequirement"
  );
}

function sortedReleaseSources(
  sources: ReadonlyMap<string, FixedReleaseRepositorySource>
): ReadonlyArray<FixedReleaseRepositorySource> {
  return [...sources.values()].sort((left, right) =>
    compareUtf8(
      left.repository.canonical,
      right.repository.canonical
    )
  );
}

function sortedGitBindings(
  bindings: ReadonlyMap<string, ResolverGitBinding>
): ReadonlyArray<ResolverGitBinding> {
  return [...bindings.values()].sort((left, right) =>
    compareUtf8(
      left.repository.canonical,
      right.repository.canonical
    )
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
