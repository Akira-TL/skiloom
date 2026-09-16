import { compareUtf8 } from "./ordering.js";
import type { RepositoryCoordinate } from "../coordinate/index.js";
import {
  compareReleaseVersions,
  matchesReleaseRequirement,
  parseReleaseVersion,
  type ReleaseRequirement,
  type ReleaseVersion
} from "../requirement/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";

export type FixedReleaseFact<Snapshot> = Readonly<{
  actualTag: string;
  draft: boolean;
  exactCommit: string;
  immutable: boolean;
  snapshot: Snapshot;
}>;

export type ReleaseCandidate<Snapshot> = Readonly<{
  repositoryCoordinate: string;
  version: ReleaseVersion;
  actualTag: string;
  exactCommit: string;
  immutable: boolean;
  snapshot: Snapshot;
}>;

export type ReleaseCandidateGroup<Snapshot> = Readonly<{
  repositoryCoordinate: string;
  precedence: string;
  candidates: ReadonlyArray<ReleaseCandidate<Snapshot>>;
}>;

export type AmbiguousReleaseVersion = ProductError<
  "AmbiguousReleaseVersion",
  Readonly<{
    repositoryCoordinate: string;
    normalizedVersion: string;
    actualTags: ReadonlyArray<string>;
  }>
>;

export type ReleaseCandidateGroupInput<Snapshot> = Readonly<{
  repository: RepositoryCoordinate;
  requirements: ReadonlyArray<ReleaseRequirement>;
  releases: ReadonlyArray<FixedReleaseFact<Snapshot>>;
}>;

export function buildReleaseCandidateGroups<Snapshot>(
  input: ReleaseCandidateGroupInput<Snapshot>
): Result<ReadonlyArray<ReleaseCandidateGroup<Snapshot>>, AmbiguousReleaseVersion> {
  const eligible: ReleaseCandidate<Snapshot>[] = [];

  for (const release of input.releases) {
    if (release.draft) {
      continue;
    }

    const version = parseActualReleaseTag(release.actualTag);
    if (version === undefined || !matchesAllRequirements(input.requirements, version)) {
      continue;
    }

    eligible.push({
      repositoryCoordinate: input.repository.canonical,
      version,
      actualTag: release.actualTag,
      exactCommit: release.exactCommit,
      immutable: release.immutable,
      snapshot: release.snapshot
    });
  }

  eligible.sort(compareCandidates);

  const byNormalizedVersion = new Map<string, ReleaseCandidate<Snapshot>[]>();
  for (const candidate of eligible) {
    const existing = byNormalizedVersion.get(candidate.version.canonical);
    if (existing === undefined) {
      byNormalizedVersion.set(candidate.version.canonical, [candidate]);
    } else {
      existing.push(candidate);
    }
  }

  for (const [normalizedVersion, candidates] of [...byNormalizedVersion.entries()].sort(
    ([left], [right]) => compareUtf8(left, right)
  )) {
    if (candidates.length > 1) {
      return {
        ok: false,
        error: productError("AmbiguousReleaseVersion", {
          repositoryCoordinate: input.repository.canonical,
          normalizedVersion,
          actualTags: [...candidates]
            .map((candidate) => candidate.actualTag)
            .sort(compareUtf8)
        })
      };
    }
  }

  const byPrecedence = new Map<string, ReleaseCandidate<Snapshot>[]>();
  for (const candidate of eligible) {
    const key = precedenceKey(candidate.version);
    const existing = byPrecedence.get(key);
    if (existing === undefined) {
      byPrecedence.set(key, [candidate]);
    } else {
      existing.push(candidate);
    }
  }

  const groups: ReleaseCandidateGroup<Snapshot>[] = [...byPrecedence.entries()].map(
    ([precedence, candidates]) => ({
      repositoryCoordinate: input.repository.canonical,
      precedence,
      candidates: [...candidates].sort(compareCandidates)
    })
  );

  groups.sort((left, right) => {
    const leftVersion = left.candidates[0]?.version;
    const rightVersion = right.candidates[0]?.version;
    if (leftVersion === undefined || rightVersion === undefined) {
      return compareUtf8(left.precedence, right.precedence);
    }
    return -compareReleaseVersions(leftVersion, rightVersion);
  });

  return { ok: true, value: groups };
}

function parseActualReleaseTag(actualTag: string): ReleaseVersion | undefined {
  const versionText = actualTag.startsWith("v") ? actualTag.slice(1) : actualTag;
  const parsed = parseReleaseVersion(versionText);
  return parsed.ok ? parsed.value : undefined;
}

function matchesAllRequirements(
  requirements: ReadonlyArray<ReleaseRequirement>,
  version: ReleaseVersion
): boolean {
  if (requirements.length === 0) {
    return version.prerelease.length === 0;
  }

  return requirements.every((requirement) =>
    matchesReleaseRequirement(requirement, version)
  );
}

function precedenceKey(version: ReleaseVersion): string {
  return `${version.major}.${version.minor}.${version.patch}${
    version.prerelease.length === 0 ? "" : `-${version.prerelease}`
  }`;
}

function compareCandidates<Snapshot>(
  left: ReleaseCandidate<Snapshot>,
  right: ReleaseCandidate<Snapshot>
): number {
  const version = compareUtf8(left.version.canonical, right.version.canonical);
  if (version !== 0) {
    return version;
  }

  const tag = compareUtf8(left.actualTag, right.actualTag);
  if (tag !== 0) {
    return tag;
  }

  return compareUtf8(left.exactCommit, right.exactCommit);
}
