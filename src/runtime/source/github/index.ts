export {
  verifyGitHubRepository,
  type GitHubRepositoryTransport,
  type GitHubRepositoryTransportRequest,
  type GitHubRepositoryTransportResponse,
  type GitHubRepositoryTransportUnavailable,
  type InvalidGitHubRepositoryResponse,
  type RepositoryCoordinateChanged,
  type SourceAccessUnavailable,
  type VerifiedGitHubRepository,
  type VerifyGitHubRepositoryError,
  type VerifyGitHubRepositoryInput
} from "./repository.js";

export {
  resolveGitHubExactCommit,
  type GitHubExactCommitTransportUnavailable,
  type InvalidGitHubExactCommitResponse,
  type ResolveGitHubExactCommitError,
  type ResolveGitHubExactCommitInput
} from "./commit.js";

export {
  resolveExplicitGitHubGitSource,
  type GitHubGitSourceFact,
  type ResolveExplicitGitHubGitSourceInput
} from "./git-ref.js";

export {
  acquirePublishedGitHubReleaseFacts,
  acquirePublishedGitHubReleaseMetadata,
  type AcquirePublishedGitHubReleaseFactsError,
  type AcquirePublishedGitHubReleaseFactsInput,
  type AcquirePublishedGitHubReleaseMetadataError,
  type GitHubPublishedReleaseFact,
  type GitHubPublishedReleaseMetadata,
  type GitHubReleaseTransportUnavailable,
  type InvalidGitHubCommitResponse,
  type InvalidGitHubReleaseResponse
} from "./release.js";

export {
  acquireExactGitHubRepositorySnapshot,
  type AcquiredGitHubRepositorySnapshot,
  type AcquireExactGitHubRepositorySnapshotError,
  type AcquireExactGitHubRepositorySnapshotInput,
  type GitHubSnapshotTransportUnavailable,
  type GitHubTreeTruncated,
  type InvalidExactGitHubCommit,
  type InvalidGitHubBlobResponse,
  type InvalidGitHubGitCommitResponse,
  type InvalidGitHubTreeResponse,
  type UnsupportedGitTreeEntry
} from "./snapshot.js";

export {
  acquireCachedExactGitHubRepositorySnapshot,
  readCachedExactGitHubRepositorySnapshot,
  sourceCacheEntryPath,
  writeCachedExactGitHubRepositorySnapshot,
  type AcquireCachedExactGitHubRepositorySnapshotInput,
  type ExactGitHubRepositorySnapshotCacheInput
} from "./cache/index.js";

export {
  acquireGitHubGitBinding,
  acquireGitHubReleaseRepositorySource,
  buildGitHubResolverRepositorySnapshot,
  type AcquireGitHubGitBindingError,
  type AcquireGitHubGitBindingInput,
  type AcquireGitHubReleaseRepositorySourceError,
  type AcquireGitHubReleaseRepositorySourceInput,
  type BuildGitHubResolverRepositorySnapshotError,
  type GitHubSourceRuntimeInput,
  type InvalidGitHubSourceTextEncoding,
  type UnsupportedGitHubSourceTextFileType
} from "./pipeline.js";

export {
  acquireGitHubRepositorySnapshotWithSystemGit,
  acquireGitRepositorySnapshotWithSystemGit,
  gitHubSystemGitRemoteCandidates,
  type AcquireGitHubRepositorySnapshotWithSystemGitInput,
  type AcquireGitRepositorySnapshotWithSystemGitError,
  type AcquireGitRepositorySnapshotWithSystemGitInput,
  type GitHubSystemGitOperation,
  type GitHubSystemGitRemoteCandidate,
  type GitHubSystemGitSnapshotTransport,
  type GitHubSystemGitUnavailable
} from "./system-git/index.js";

export {
  createGitHubJsonFetchTransport,
  createGitHubRepositoryFetchTransport,
  type GitHubFetchTransportOptions,
  type GitHubJsonTransport,
  type GitHubJsonTransportRequest,
  type GitHubJsonTransportResponse,
  type GitHubRateLimited,
  type GitHubRateLimitMetadata,
  type GitHubTransportAborted,
  type GitHubTransportAbortReason,
  type GitHubTransportOperation
} from "./transport.js";
