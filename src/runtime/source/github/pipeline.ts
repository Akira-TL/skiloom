import {
  parsePackageCoordinate,
  type InvalidPackageCoordinate
} from "../../../domain/coordinate/index.js";
import {
  discoverRepositorySkills,
  type RepositoryDiscoveryError
} from "../../../domain/discovery/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import {
  parsePackageMetadata,
  type PackageMetadataError
} from "../../../domain/package/index.js";
import type {
  FixedReleaseRepositorySource,
  ResolverGitBinding,
  ResolverPackageDependencyFact,
  ResolverPackageFact,
  ResolverRepositorySnapshot
} from "../../../domain/resolver/index.js";
import {
  buildPackageSnapshot,
  type PackageSnapshotError,
  type RepositorySnapshotEntry
} from "../../../domain/snapshot/index.js";
import type {
  ResolveGitHubExactCommitError
} from "./commit.js";
import {
  resolveExplicitGitHubGitSource
} from "./git-ref.js";
import {
  acquirePublishedGitHubReleaseFacts,
  acquirePublishedGitHubReleaseMetadata,
  type AcquirePublishedGitHubReleaseFactsError,
  type AcquirePublishedGitHubReleaseMetadataError
} from "./release.js";
import {
  verifyGitHubRepository,
  type GitHubRepositoryTransport,
  type VerifyGitHubRepositoryError
} from "./repository.js";
import {
  acquireCachedExactGitHubRepositorySnapshot
} from "./cache/index.js";
import {
  acquireExactGitHubRepositorySnapshot,
  type AcquiredGitHubRepositorySnapshot,
  type AcquireExactGitHubRepositorySnapshotError,
  type AcquireExactGitHubRepositorySnapshotInput
} from "./snapshot.js";
import type { GitHubJsonTransport } from "./transport.js";
import type {
  AcquireGitRepositorySnapshotWithSystemGitError,
  GitHubSystemGitSnapshotTransport,
  GitHubSystemGitUnavailable
} from "./system-git/index.js";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const PATH_DECODER = new TextDecoder("utf-8");
const REPOSITORY_METADATA_PATH = "skiloom-repo.toml";
const PACKAGE_METADATA_BASENAME = "skiloom-package.toml";

export type InvalidGitHubSourceTextEncoding = ProductError<
  "InvalidGitHubSourceTextEncoding",
  Readonly<{
    repositoryCoordinate: string;
    path: string;
  }>
>;

export type UnsupportedGitHubSourceTextFileType = ProductError<
  "UnsupportedGitHubSourceTextFileType",
  Readonly<{
    repositoryCoordinate: string;
    path: string;
    fileType: Exclude<RepositorySnapshotEntry["fileType"], "regular">;
  }>
>;

export type BuildGitHubResolverRepositorySnapshotError =
  | RepositoryDiscoveryError
  | PackageMetadataError
  | PackageSnapshotError
  | InvalidPackageCoordinate
  | InvalidGitHubSourceTextEncoding
  | UnsupportedGitHubSourceTextFileType;

export type GitHubSourceRuntimeInput = Readonly<{
  credential?: string;
  signal?: AbortSignal;
  sourceCachePath?: string;
  gitTransport?: GitHubSystemGitSnapshotTransport;
  repositoryTransport: GitHubRepositoryTransport;
  transport: GitHubJsonTransport;
}>;

export type AcquireGitHubReleaseRepositorySourceInput =
  GitHubSourceRuntimeInput &
    Readonly<{
      repository: AcquiredGitHubRepositorySnapshot["repository"];
    }>;

export type AcquireGitHubReleaseRepositorySourceError =
  | VerifyGitHubRepositoryError
  | AcquirePublishedGitHubReleaseFactsError
  | AcquirePublishedGitHubReleaseMetadataError
  | AcquireExactGitHubRepositorySnapshotError
  | AcquireGitRepositorySnapshotWithSystemGitError
  | BuildGitHubResolverRepositorySnapshotError;

export type AcquireGitHubGitBindingInput =
  GitHubSourceRuntimeInput &
    Readonly<{
      repository: AcquiredGitHubRepositorySnapshot["repository"];
      requestedRef: string;
    }>;

export type AcquireGitHubGitBindingError =
  | GitHubSystemGitUnavailable
  | VerifyGitHubRepositoryError
  | ResolveGitHubExactCommitError
  | AcquireExactGitHubRepositorySnapshotError
  | BuildGitHubResolverRepositorySnapshotError;

export async function acquireGitHubReleaseRepositorySource(
  input: AcquireGitHubReleaseRepositorySourceInput
): Promise<
  Result<
    FixedReleaseRepositorySource,
    AcquireGitHubReleaseRepositorySourceError
  >
> {
  const verified = await verifyGitHubRepository({
    repository: input.repository,
    transport: input.repositoryTransport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential }),
    ...(input.signal === undefined
      ? {}
      : { signal: input.signal })
  });
  if (!verified.ok) {
    return verified;
  }

  const resolvedReleases: FixedReleaseRepositorySource["releases"][number][] = [];
  let gitTransportUnavailable = false;

  if (input.gitTransport !== undefined) {
    const metadata = await acquirePublishedGitHubReleaseMetadata({
      repository: verified.value.repository,
      transport: input.transport,
      ...(input.credential === undefined
        ? {}
        : { credential: input.credential }),
      ...(input.signal === undefined
        ? {}
        : { signal: input.signal })
    });
    if (!metadata.ok) {
      return metadata;
    }

    for (const release of metadata.value) {
      const acquired = await input.gitTransport({
        repository: verified.value.repository,
        requestedRef: release.actualTag,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.sourceCachePath === undefined
          ? {}
          : { sourceCachePath: input.sourceCachePath })
      });
      if (!acquired.ok) {
        if (
          acquired.error.code === "GitHubSystemGitUnavailable" &&
          acquired.error.facts.reason !== "aborted"
        ) {
          gitTransportUnavailable = true;
          resolvedReleases.length = 0;
          break;
        }
        return acquired;
      }
      const snapshot = buildGitHubResolverRepositorySnapshot(acquired.value);
      if (!snapshot.ok) {
        return snapshot;
      }
      resolvedReleases.push({
        ...release,
        exactCommit: acquired.value.exactCommit,
        snapshot: snapshot.value
      });
    }
  }

  if (input.gitTransport === undefined || gitTransportUnavailable) {
    const releases = await acquirePublishedGitHubReleaseFacts({
      repository: verified.value.repository,
      transport: input.transport,
      ...(input.credential === undefined
        ? {}
        : { credential: input.credential }),
      ...(input.signal === undefined
        ? {}
        : { signal: input.signal })
    });
    if (!releases.ok) {
      return releases;
    }

    for (const release of releases.value) {
      const acquired = await acquireRepositorySnapshot(
        input,
        verified.value.repository,
        release.exactCommit
      );
      if (!acquired.ok) {
        return acquired;
      }

      const snapshot = buildGitHubResolverRepositorySnapshot(acquired.value);
      if (!snapshot.ok) {
        return snapshot;
      }

      resolvedReleases.push({
        ...release,
        snapshot: snapshot.value
      });
    }
  }

  return {
    ok: true,
    value: {
      repository: verified.value.repository,
      releases: resolvedReleases
    }
  };
}

export async function acquireGitHubGitBinding(
  input: AcquireGitHubGitBindingInput
): Promise<Result<ResolverGitBinding, AcquireGitHubGitBindingError>> {
  if (input.gitTransport !== undefined) {
    const gitAcquired = await input.gitTransport({
      repository: input.repository,
      requestedRef: input.requestedRef,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.sourceCachePath === undefined
        ? {}
        : { sourceCachePath: input.sourceCachePath })
    });
    if (gitAcquired.ok) {
      const snapshot = buildGitHubResolverRepositorySnapshot(
        gitAcquired.value
      );
      if (!snapshot.ok) {
        return snapshot;
      }
      return {
        ok: true,
        value: {
          repository: input.repository,
          sourceKind: "git",
          requestedRef: input.requestedRef,
          exactCommit: gitAcquired.value.exactCommit,
          snapshot: snapshot.value
        }
      };
    }
    if (
      gitAcquired.error.code !== "GitHubSystemGitUnavailable" ||
      gitAcquired.error.facts.reason === "aborted"
    ) {
      return gitAcquired;
    }
  }

  const verified = await verifyGitHubRepository({
    repository: input.repository,
    transport: input.repositoryTransport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential }),
    ...(input.signal === undefined
      ? {}
      : { signal: input.signal })
  });
  if (!verified.ok) {
    return verified;
  }

  const source = await resolveExplicitGitHubGitSource({
    repository: verified.value.repository,
    requestedRef: input.requestedRef,
    transport: input.transport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential }),
    ...(input.signal === undefined
      ? {}
      : { signal: input.signal })
  });
  if (!source.ok) {
    return source;
  }

  const acquired = await acquireRepositorySnapshot(
    input,
    verified.value.repository,
    source.value.exactCommit
  );
  if (!acquired.ok) {
    return acquired;
  }

  const snapshot = buildGitHubResolverRepositorySnapshot(acquired.value);
  if (!snapshot.ok) {
    return snapshot;
  }

  return {
    ok: true,
    value: {
      ...source.value,
      snapshot: snapshot.value
    }
  };
}

async function acquireRepositorySnapshot(
  input: GitHubSourceRuntimeInput,
  repository: AcquiredGitHubRepositorySnapshot["repository"],
  exactCommit: string
): Promise<
  Result<
    AcquiredGitHubRepositorySnapshot,
    AcquireExactGitHubRepositorySnapshotError
  >
> {
  const request = {
    repository,
    exactCommit,
    transport: input.transport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential }),
    ...(input.signal === undefined
      ? {}
      : { signal: input.signal })
  } satisfies AcquireExactGitHubRepositorySnapshotInput;

  return input.sourceCachePath === undefined
    ? acquireExactGitHubRepositorySnapshot(request)
    : acquireCachedExactGitHubRepositorySnapshot({
        ...request,
        cacheRoot: input.sourceCachePath
      });
}

export function buildGitHubResolverRepositorySnapshot(
  acquired: AcquiredGitHubRepositorySnapshot
): Result<
  ResolverRepositorySnapshot,
  BuildGitHubResolverRepositorySnapshotError
> {
  const entriesByPath = indexEntries(acquired.entries);

  const repositoryMetadata = optionalTextFile(
    acquired,
    entriesByPath,
    REPOSITORY_METADATA_PATH
  );
  if (!repositoryMetadata.ok) {
    return repositoryMetadata;
  }

  const discoveryFiles = [];
  for (const [path, entry] of entriesByPath) {
    if (!isSkillMarkdownPath(path) || entry.fileType !== "regular") {
      continue;
    }
    const content = decodeText(acquired, path, entry.content);
    if (!content.ok) {
      return content;
    }
    discoveryFiles.push({
      path,
      content: content.value
    });
  }

  const discovered = discoverRepositorySkills({
    repositoryRootBasename: acquired.repository.repo,
    ...(repositoryMetadata.value === undefined
      ? {}
      : { repositoryMetadata: repositoryMetadata.value }),
    files: discoveryFiles
  });
  if (!discovered.ok) {
    return discovered;
  }

  const discoveredRoots = discovered.value.map((skill) => skill.packageRoot);
  const packages: ResolverPackageFact[] = [];

  for (const skill of discovered.value) {
    const coordinate = parsePackageCoordinate(
      `${acquired.repository.canonical}/${skill.name}`
    );
    if (!coordinate.ok) {
      return coordinate;
    }

    const metadataPath =
      skill.packageRoot === "."
        ? PACKAGE_METADATA_BASENAME
        : `${skill.packageRoot}/${PACKAGE_METADATA_BASENAME}`;
    const metadataText = optionalTextFile(
      acquired,
      entriesByPath,
      metadataPath
    );
    if (!metadataText.ok) {
      return metadataText;
    }

    const metadata = parsePackageMetadata(metadataText.value);
    if (!metadata.ok) {
      return metadata;
    }

    const packageSnapshot = buildPackageSnapshot({
      packageRoot: skill.packageRoot,
      discoveredPackageRoots: discoveredRoots,
      entries: acquired.entries
    });
    if (!packageSnapshot.ok) {
      return packageSnapshot;
    }

    const dependencies: ResolverPackageDependencyFact[] = [];
    for (const [dependencyCoordinate, requirement] of Object.entries(
      metadata.value.dependencies
    )) {
      const target = parsePackageCoordinate(dependencyCoordinate);
      if (!target.ok) {
        return target;
      }
      dependencies.push({
        target: target.value,
        requirement
      });
    }

    packages.push({
      coordinate: coordinate.value,
      packageRoot: skill.packageRoot,
      contentDigest: packageSnapshot.value.contentDigest,
      dependencies
    });
  }

  packages.sort((left, right) =>
    compareUtf8(left.coordinate.canonical, right.coordinate.canonical)
  );

  return {
    ok: true,
    value: { packages }
  };
}

function indexEntries(
  entries: ReadonlyArray<RepositorySnapshotEntry>
): ReadonlyMap<string, RepositorySnapshotEntry> {
  return new Map(
    entries.map((entry) => [
      PATH_DECODER.decode(entry.pathBytes),
      entry
    ] as const)
  );
}

function optionalTextFile(
  acquired: AcquiredGitHubRepositorySnapshot,
  entriesByPath: ReadonlyMap<string, RepositorySnapshotEntry>,
  path: string
): Result<
  string | undefined,
  InvalidGitHubSourceTextEncoding | UnsupportedGitHubSourceTextFileType
> {
  const entry = entriesByPath.get(path);
  if (entry === undefined) {
    return { ok: true, value: undefined };
  }
  if (entry.fileType !== "regular") {
    return {
      ok: false,
      error: productError("UnsupportedGitHubSourceTextFileType", {
        repositoryCoordinate: acquired.repository.canonical,
        path,
        fileType: entry.fileType
      })
    };
  }
  return decodeText(acquired, path, entry.content);
}

function decodeText(
  acquired: AcquiredGitHubRepositorySnapshot,
  path: string,
  content: Uint8Array
): Result<string, InvalidGitHubSourceTextEncoding> {
  try {
    return {
      ok: true,
      value: TEXT_DECODER.decode(content)
    };
  } catch {
    return {
      ok: false,
      error: productError("InvalidGitHubSourceTextEncoding", {
        repositoryCoordinate: acquired.repository.canonical,
        path
      })
    };
  }
}

function isSkillMarkdownPath(path: string): boolean {
  return path === "SKILL.md" || path.endsWith("/SKILL.md");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
