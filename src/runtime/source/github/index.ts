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
  type AcquirePublishedGitHubReleaseFactsError,
  type AcquirePublishedGitHubReleaseFactsInput,
  type GitHubPublishedReleaseFact,
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
  sourceCacheEntryPath,
  type AcquireCachedExactGitHubRepositorySnapshotInput
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
