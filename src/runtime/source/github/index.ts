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
  createGitHubJsonFetchTransport,
  createGitHubRepositoryFetchTransport,
  type GitHubFetchTransportOptions,
  type GitHubJsonTransport,
  type GitHubJsonTransportRequest,
  type GitHubJsonTransportResponse
} from "./transport.js";
