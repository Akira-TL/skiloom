import type { RepositoryCoordinate } from "../../../domain/coordinate/index.js";
import type {
  ResolverGitBinding
} from "../../../domain/resolver/search.js";
import type { Result } from "../../../domain/errors/index.js";
import {
  resolveGitHubExactCommit,
  type ResolveGitHubExactCommitError
} from "./commit.js";
import type { GitHubJsonTransport } from "./transport.js";

export type GitHubGitSourceFact = Omit<
  ResolverGitBinding,
  "snapshot"
>;

export type ResolveExplicitGitHubGitSourceInput = Readonly<{
  repository: RepositoryCoordinate;
  requestedRef: string;
  credential?: string;
  transport: GitHubJsonTransport;
}>;

export async function resolveExplicitGitHubGitSource(
  input: ResolveExplicitGitHubGitSourceInput
): Promise<Result<GitHubGitSourceFact, ResolveGitHubExactCommitError>> {
  const exactCommit = await resolveGitHubExactCommit({
    repository: input.repository,
    requestedRef: input.requestedRef,
    transport: input.transport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential })
  });
  if (!exactCommit.ok) {
    return exactCommit;
  }

  return {
    ok: true,
    value: {
      repository: input.repository,
      sourceKind: "git",
      requestedRef: input.requestedRef,
      exactCommit: exactCommit.value
    }
  };
}
