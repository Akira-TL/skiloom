import type { RepositoryCoordinate } from "../../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type { SourceAccessUnavailable } from "./repository.js";
import type { GitHubJsonTransport } from "./transport.js";

const EXACT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export type InvalidGitHubExactCommitResponse = ProductError<
  "InvalidGitHubExactCommitResponse",
  Readonly<{
    repositoryCoordinate: string;
    requestedRef: string;
  }>
>;

export type GitHubExactCommitTransportUnavailable = ProductError<
  "GitHubExactCommitTransportUnavailable",
  Readonly<{
    repositoryCoordinate: string;
    requestedRef: string;
    status: number | null;
  }>
>;

export type ResolveGitHubExactCommitError =
  | SourceAccessUnavailable
  | InvalidGitHubExactCommitResponse
  | GitHubExactCommitTransportUnavailable;

export type ResolveGitHubExactCommitInput = Readonly<{
  repository: RepositoryCoordinate;
  requestedRef: string;
  credential?: string;
  transport: GitHubJsonTransport;
}>;

export async function resolveGitHubExactCommit(
  input: ResolveGitHubExactCommitInput
): Promise<Result<string, ResolveGitHubExactCommitError>> {
  let response;
  try {
    response = await input.transport({
      path:
        repositoryPath(input.repository) +
        "/commits/" +
        encodeURIComponent(input.requestedRef),
      ...(input.credential === undefined
        ? {}
        : { credential: input.credential })
    });
  } catch {
    return transportUnavailable(input, null);
  }

  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return {
      ok: false,
      error: productError("SourceAccessUnavailable", {
        repositoryCoordinate: input.repository.canonical,
        status: response.status
      })
    };
  }

  if (response.status !== 200) {
    return transportUnavailable(input, response.status);
  }

  if (!isRecord(response.body)) {
    return invalidCommitResponse(input);
  }
  const sha = response.body.sha;
  if (typeof sha !== "string" || !EXACT_COMMIT_PATTERN.test(sha)) {
    return invalidCommitResponse(input);
  }

  return { ok: true, value: sha };
}

function repositoryPath(repository: RepositoryCoordinate): string {
  return (
    "/repos/" +
    encodeURIComponent(repository.owner) +
    "/" +
    encodeURIComponent(repository.repo)
  );
}

function invalidCommitResponse(
  input: ResolveGitHubExactCommitInput
): Result<never, InvalidGitHubExactCommitResponse> {
  return {
    ok: false,
    error: productError("InvalidGitHubExactCommitResponse", {
      repositoryCoordinate: input.repository.canonical,
      requestedRef: input.requestedRef
    })
  };
}

function transportUnavailable(
  input: ResolveGitHubExactCommitInput,
  status: number | null
): Result<never, GitHubExactCommitTransportUnavailable> {
  return {
    ok: false,
    error: productError("GitHubExactCommitTransportUnavailable", {
      repositoryCoordinate: input.repository.canonical,
      requestedRef: input.requestedRef,
      status
    })
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
