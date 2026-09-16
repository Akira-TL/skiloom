import type { RepositoryCoordinate } from "../coordinate/index.js";
import {
  matchesReleaseRequirement,
  parseReleaseRequirement,
  type ReleaseRequirement
} from "../requirement/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";
import {
  buildReleaseCandidateGroups,
  type AmbiguousReleaseVersion,
  type FixedReleaseFact,
  type ReleaseCandidate,
  type ReleaseCandidateGroup
} from "./candidates.js";
import { compareUtf8 } from "./ordering.js";
import {
  propagateResolverState,
  type BoundRepositorySource,
  type DirectInstallRequirement,
  type ResolverDependencyEdge,
  type ResolverExpandedPackage,
  type ResolverInvalidReleaseRequirement,
  type ResolverPackageNotFound,
  type ResolverPropagationError,
  type ResolverPropagationResult,
  type ResolverReleaseConstraintSet,
  type ResolverRepositorySnapshot,
  type ResolverSourceBindingSummary,
  type RepositorySourceConflict
} from "./propagation.js";

export type FixedReleaseRepositorySource = Readonly<{
  repository: RepositoryCoordinate;
  releases: ReadonlyArray<FixedReleaseFact<ResolverRepositorySnapshot>>;
}>;

export type ResolverGitBinding = Extract<
  BoundRepositorySource,
  Readonly<{ sourceKind: "git" }>
>;

export type ResolverCandidateGraph = Readonly<{
  sourceBindings: ReadonlyArray<ResolverSourceBindingSummary>;
  packages: ReadonlyArray<ResolverExpandedPackage>;
  dependencyEdges: ReadonlyArray<ResolverDependencyEdge>;
}>;

export type AmbiguousReleasePrecedence = ProductError<
  "AmbiguousReleasePrecedence",
  Readonly<{
    repositoryCoordinate: string;
    precedence: string;
    candidates: ReadonlyArray<Readonly<{
      version: string;
      actualTag: string;
    }>>;
  }>
>;

export type UnsatisfiableReleaseRequirements = ProductError<
  "UnsatisfiableReleaseRequirements",
  Readonly<{
    repositoryCoordinate: string;
    requirements: ResolverReleaseConstraintSet["constraints"];
  }>
>;

export type ResolverAttemptFailure = Readonly<{
  version: string;
  rootFailureCode: string;
  subjectCoordinate: string;
}>;

export type UnresolvableDependencyGraph = ProductError<
  "UnresolvableDependencyGraph",
  Readonly<{
    repositoryCoordinate: string;
    candidateVersions: ReadonlyArray<string>;
    attempts: ReadonlyArray<ResolverAttemptFailure>;
  }>
>;

export type ResolverSearchError =
  | ResolverPropagationError
  | AmbiguousReleaseVersion
  | AmbiguousReleasePrecedence
  | UnsatisfiableReleaseRequirements
  | UnresolvableDependencyGraph;

export type ResolverSearchInput = Readonly<{
  directRequirements: ReadonlyArray<DirectInstallRequirement>;
  releaseSources: ReadonlyArray<FixedReleaseRepositorySource>;
  gitBindings: ReadonlyArray<ResolverGitBinding>;
}>;

type ReleaseSourceIndexEntry = Readonly<{
  repository: RepositoryCoordinate;
  releases: ReadonlyArray<FixedReleaseFact<ResolverRepositorySnapshot>>;
}>;

export function resolveTargetGraph(
  input: ResolverSearchInput
): Result<ResolverCandidateGraph, ResolverSearchError> {
  const sourceIndex = buildReleaseSourceIndex(input.releaseSources);
  const gitBindings = [...input.gitBindings].sort(compareBindings);

  return searchBranch(input.directRequirements, sourceIndex, gitBindings);
}

function searchBranch(
  directRequirements: ReadonlyArray<DirectInstallRequirement>,
  sourceIndex: ReadonlyMap<string, ReleaseSourceIndexEntry>,
  bindings: ReadonlyArray<BoundRepositorySource>
): Result<ResolverCandidateGraph, ResolverSearchError> {
  const propagated = propagateResolverState({
    directRequirements,
    bindings
  });
  if (!propagated.ok) {
    return propagated;
  }

  const assignedConstraintFailure = validateAssignedReleaseBindings(
    propagated.value,
    bindings
  );
  if (assignedConstraintFailure !== undefined) {
    return { ok: false, error: assignedConstraintFailure };
  }

  const decisionRepository = propagated.value.unresolvedRepositories[0];
  if (decisionRepository === undefined) {
    return {
      ok: true,
      value: candidateGraph(propagated.value)
    };
  }

  const source = sourceIndex.get(decisionRepository);
  const constraintSet = findConstraintSet(propagated.value, decisionRepository);
  if (source === undefined) {
    return {
      ok: false,
      error: unsatisfiableRequirements(decisionRepository, constraintSet)
    };
  }

  const requirements = parseCanonicalRequirements(constraintSet);
  const groups = buildReleaseCandidateGroups({
    repository: source.repository,
    requirements,
    releases: source.releases
  });
  if (!groups.ok) {
    return groups;
  }

  if (groups.value.length === 0) {
    return {
      ok: false,
      error: unsatisfiableRequirements(decisionRepository, constraintSet)
    };
  }

  const attempts: ResolverAttemptFailure[] = [];
  for (const group of groups.value) {
    if (group.candidates.length > 1) {
      return {
        ok: false,
        error: ambiguousPrecedence(group)
      };
    }

    const candidate = group.candidates[0];
    if (candidate === undefined) {
      continue;
    }

    const branch = searchBranch(
      directRequirements,
      sourceIndex,
      [...bindings, releaseBinding(source.repository, candidate)]
    );
    if (branch.ok) {
      return branch;
    }

    attempts.push({
      version: candidate.version.canonical,
      rootFailureCode: branch.error.code,
      subjectCoordinate: errorSubjectCoordinate(branch.error)
    });
  }

  return {
    ok: false,
    error: productError("UnresolvableDependencyGraph", {
      repositoryCoordinate: decisionRepository,
      candidateVersions: attempts.map((attempt) => attempt.version),
      attempts
    })
  };
}

function buildReleaseSourceIndex(
  sources: ReadonlyArray<FixedReleaseRepositorySource>
): ReadonlyMap<string, ReleaseSourceIndexEntry> {
  const byRepository = new Map<string, {
    repository: RepositoryCoordinate;
    releases: Array<FixedReleaseFact<ResolverRepositorySnapshot>>;
  }>();

  for (const source of [...sources].sort((left, right) =>
    compareUtf8(left.repository.canonical, right.repository.canonical)
  )) {
    const existing = byRepository.get(source.repository.canonical);
    if (existing === undefined) {
      byRepository.set(source.repository.canonical, {
        repository: source.repository,
        releases: [...source.releases]
      });
    } else {
      existing.releases.push(...source.releases);
    }
  }

  return new Map(
    [...byRepository.entries()].sort(([left], [right]) => compareUtf8(left, right))
  );
}

function validateAssignedReleaseBindings(
  state: ResolverPropagationResult,
  bindings: ReadonlyArray<BoundRepositorySource>
): UnsatisfiableReleaseRequirements | undefined {
  const constraints = new Map(
    state.releaseConstraintSets.map((constraintSet) => [
      constraintSet.repositoryCoordinate,
      constraintSet
    ])
  );

  for (const binding of [...bindings].sort(compareBindings)) {
    if (binding.sourceKind !== "github-release") {
      continue;
    }

    const constraintSet = constraints.get(binding.repository.canonical);
    if (constraintSet === undefined) {
      continue;
    }

    const requirements = parseCanonicalRequirements(constraintSet);
    if (
      requirements.every((requirement) =>
        matchesReleaseRequirement(requirement, binding.version)
      )
    ) {
      continue;
    }

    return unsatisfiableRequirements(binding.repository.canonical, constraintSet);
  }

  return undefined;
}

function parseCanonicalRequirements(
  constraintSet: ResolverReleaseConstraintSet | undefined
): ReadonlyArray<ReleaseRequirement> {
  if (constraintSet === undefined) {
    return [];
  }

  const requirements: ReleaseRequirement[] = [];
  for (const constraint of constraintSet.constraints) {
    const parsed = parseReleaseRequirement(constraint.requirement);
    if (parsed.ok) {
      requirements.push(parsed.value);
    }
  }
  return requirements;
}

function findConstraintSet(
  state: ResolverPropagationResult,
  repositoryCoordinate: string
): ResolverReleaseConstraintSet | undefined {
  return state.releaseConstraintSets.find(
    (constraintSet) => constraintSet.repositoryCoordinate === repositoryCoordinate
  );
}

function unsatisfiableRequirements(
  repositoryCoordinate: string,
  constraintSet: ResolverReleaseConstraintSet | undefined
): UnsatisfiableReleaseRequirements {
  return productError("UnsatisfiableReleaseRequirements", {
    repositoryCoordinate,
    requirements: constraintSet?.constraints ?? []
  });
}

function ambiguousPrecedence(
  group: ReleaseCandidateGroup<ResolverRepositorySnapshot>
): AmbiguousReleasePrecedence {
  return productError("AmbiguousReleasePrecedence", {
    repositoryCoordinate: group.repositoryCoordinate,
    precedence: group.precedence,
    candidates: group.candidates
      .map((candidate) => ({
        version: candidate.version.canonical,
        actualTag: candidate.actualTag
      }))
      .sort((left, right) => {
        const version = compareUtf8(left.version, right.version);
        return version !== 0 ? version : compareUtf8(left.actualTag, right.actualTag);
      })
  });
}

function releaseBinding(
  repository: RepositoryCoordinate,
  candidate: ReleaseCandidate<ResolverRepositorySnapshot>
): BoundRepositorySource {
  return {
    repository,
    sourceKind: "github-release",
    version: candidate.version,
    actualTag: candidate.actualTag,
    exactCommit: candidate.exactCommit,
    immutable: candidate.immutable,
    snapshot: candidate.snapshot
  };
}

function candidateGraph(state: ResolverPropagationResult): ResolverCandidateGraph {
  return {
    sourceBindings: state.sourceBindings,
    packages: state.expandedPackages,
    dependencyEdges: state.dependencyEdges
  };
}

function compareBindings(left: BoundRepositorySource, right: BoundRepositorySource): number {
  return compareUtf8(left.repository.canonical, right.repository.canonical);
}

function errorSubjectCoordinate(error: ResolverSearchError): string {
  switch (error.code) {
    case "PackageNotFound":
      return error.facts.packageCoordinate;
    case "RepositorySourceConflict":
    case "AmbiguousReleaseVersion":
    case "AmbiguousReleasePrecedence":
    case "UnsatisfiableReleaseRequirements":
    case "UnresolvableDependencyGraph":
      return error.facts.repositoryCoordinate;
    case "InvalidReleaseRequirement":
      return "originCoordinate" in error.facts
        ? error.facts.originCoordinate
        : error.facts.targetPackageCoordinate;
  }
}

export type {
  ResolverInvalidReleaseRequirement,
  ResolverPackageNotFound,
  RepositorySourceConflict
};
