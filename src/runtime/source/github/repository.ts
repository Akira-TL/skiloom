import type { RepositoryCoordinate } from "../../../domain/coordinate/index.js";
import {
  parseRepositoryCoordinate
} from "../../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import {
  gitHubTransportAbortResult,
  type GitHubTransportAborted
} from "./transport.js";

export type GitHubRepositoryTransportRequest = Readonly<{
  repository: RepositoryCoordinate;
  credential?: string;
  signal?: AbortSignal;
}>;

export type GitHubRepositoryTransportResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export type GitHubRepositoryTransport = (
  request: GitHubRepositoryTransportRequest
) => Promise<GitHubRepositoryTransportResponse>;

export type VerifiedGitHubRepository = Readonly<{
  repository: RepositoryCoordinate;
}>;

export type RepositoryCoordinateChanged = ProductError<
  "RepositoryCoordinateChanged",
  Readonly<{
    requestedRepositoryCoordinate: string;
    resolvedRepositoryCoordinate: string;
  }>
>;

export type SourceAccessUnavailable = ProductError<
  "SourceAccessUnavailable",
  Readonly<{
    repositoryCoordinate: string;
    status: 401 | 403 | 404;
  }>
>;

export type InvalidGitHubRepositoryResponse = ProductError<
  "InvalidGitHubRepositoryResponse",
  Readonly<{
    repositoryCoordinate: string;
  }>
>;

export type GitHubRepositoryTransportUnavailable = ProductError<
  "GitHubRepositoryTransportUnavailable",
  Readonly<{
    repositoryCoordinate: string;
    status: number | null;
  }>
>;

export type VerifyGitHubRepositoryError =
  | RepositoryCoordinateChanged
  | SourceAccessUnavailable
  | InvalidGitHubRepositoryResponse
  | GitHubRepositoryTransportUnavailable
  | GitHubTransportAborted;

export type VerifyGitHubRepositoryInput = Readonly<{
  repository: RepositoryCoordinate;
  credential?: string;
  signal?: AbortSignal;
  transport: GitHubRepositoryTransport;
}>;

export async function verifyGitHubRepository(
  input: VerifyGitHubRepositoryInput
): Promise<Result<VerifiedGitHubRepository, VerifyGitHubRepositoryError>> {
  let response: GitHubRepositoryTransportResponse;
  try {
    response = await input.transport({
      repository: input.repository,
      ...(input.credential === undefined
        ? {}
        : { credential: input.credential }),
      ...(input.signal === undefined
        ? {}
        : { signal: input.signal })
    });
  } catch (error) {
    const aborted = gitHubTransportAbortResult(
      error,
      input.repository.canonical,
      "verify-repository"
    );
    if (aborted !== undefined) {
      return { ok: false, error: aborted };
    }
    return {
      ok: false,
      error: productError("GitHubRepositoryTransportUnavailable", {
        repositoryCoordinate: input.repository.canonical,
        status: null
      })
    };
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
    return {
      ok: false,
      error: productError("GitHubRepositoryTransportUnavailable", {
        repositoryCoordinate: input.repository.canonical,
        status: response.status
      })
    };
  }

  const fullName = repositoryFullName(response.body);
  if (fullName === undefined) {
    return {
      ok: false,
      error: productError("InvalidGitHubRepositoryResponse", {
        repositoryCoordinate: input.repository.canonical
      })
    };
  }

  const resolved = parseRepositoryCoordinate(fullName);
  if (!resolved.ok) {
    return {
      ok: false,
      error: productError("InvalidGitHubRepositoryResponse", {
        repositoryCoordinate: input.repository.canonical
      })
    };
  }

  if (resolved.value.canonical !== input.repository.canonical) {
    return {
      ok: false,
      error: productError("RepositoryCoordinateChanged", {
        requestedRepositoryCoordinate: input.repository.canonical,
        resolvedRepositoryCoordinate: resolved.value.canonical
      })
    };
  }

  return {
    ok: true,
    value: {
      repository: input.repository
    }
  };
}

function repositoryFullName(body: unknown): string | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("full_name" in body)
  ) {
    return undefined;
  }

  const fullName = (body as { full_name?: unknown }).full_name;
  return typeof fullName === "string" ? fullName : undefined;
}
