import type { RepositoryCoordinate } from "../../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type { FixedReleaseFact } from "../../../domain/resolver/candidates.js";
import type { SourceAccessUnavailable } from "./repository.js";
import type { GitHubJsonTransport } from "./transport.js";

const RELEASE_PAGE_SIZE = "100";
const MAX_RELEASE_PAGES = 1000;
const EXACT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export type GitHubPublishedReleaseFact = Omit<
  FixedReleaseFact<unknown>,
  "snapshot"
>;

export type InvalidGitHubReleaseResponse = ProductError<
  "InvalidGitHubReleaseResponse",
  Readonly<{
    repositoryCoordinate: string;
  }>
>;

export type InvalidGitHubCommitResponse = ProductError<
  "InvalidGitHubCommitResponse",
  Readonly<{
    repositoryCoordinate: string;
    actualTag: string;
  }>
>;

export type GitHubReleaseTransportUnavailable = ProductError<
  "GitHubReleaseTransportUnavailable",
  Readonly<{
    repositoryCoordinate: string;
    operation: "list-releases" | "resolve-tag";
    status: number | null;
  }>
>;

export type AcquirePublishedGitHubReleaseFactsError =
  | SourceAccessUnavailable
  | InvalidGitHubReleaseResponse
  | InvalidGitHubCommitResponse
  | GitHubReleaseTransportUnavailable;

export type AcquirePublishedGitHubReleaseFactsInput = Readonly<{
  repository: RepositoryCoordinate;
  credential?: string;
  transport: GitHubJsonTransport;
}>;

export async function acquirePublishedGitHubReleaseFacts(
  input: AcquirePublishedGitHubReleaseFactsInput
): Promise<
  Result<
    ReadonlyArray<GitHubPublishedReleaseFact>,
    AcquirePublishedGitHubReleaseFactsError
  >
> {
  const facts: GitHubPublishedReleaseFact[] = [];

  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const response = await requestJson(
      input,
      {
        path: repositoryPath(input.repository) + "/releases",
        query: {
          per_page: RELEASE_PAGE_SIZE,
          page: String(page)
        }
      },
      "list-releases"
    );
    if (!response.ok) {
      return response;
    }
    if (!Array.isArray(response.value.body)) {
      return invalidReleaseResponse(input.repository);
    }
    if (response.value.body.length === 0) {
      facts.sort(compareReleaseFacts);
      return { ok: true, value: facts };
    }

    for (const release of response.value.body) {
      const parsed = parseReleaseRecord(release);
      if (parsed === undefined) {
        return invalidReleaseResponse(input.repository);
      }
      if (parsed.draft) {
        continue;
      }

      const exactCommit = await resolveActualTagCommit(
        input,
        parsed.actualTag
      );
      if (!exactCommit.ok) {
        return exactCommit;
      }

      facts.push({
        actualTag: parsed.actualTag,
        draft: false,
        exactCommit: exactCommit.value,
        immutable: parsed.immutable
      });
    }
  }

  return invalidReleaseResponse(input.repository);
}

type ParsedReleaseRecord = Readonly<{
  actualTag: string;
  draft: boolean;
  immutable: boolean;
}>;

function parseReleaseRecord(
  value: unknown
): ParsedReleaseRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const tagName = value.tag_name;
  const draft = value.draft;
  if (typeof tagName !== "string" || typeof draft !== "boolean") {
    return undefined;
  }

  if (draft) {
    return {
      actualTag: tagName,
      draft: true,
      immutable: false
    };
  }

  if (typeof value.immutable !== "boolean") {
    return undefined;
  }

  return {
    actualTag: tagName,
    draft: false,
    immutable: value.immutable
  };
}

async function resolveActualTagCommit(
  input: AcquirePublishedGitHubReleaseFactsInput,
  actualTag: string
): Promise<Result<string, AcquirePublishedGitHubReleaseFactsError>> {
  const response = await requestJson(
    input,
    {
      path:
        repositoryPath(input.repository) +
        "/commits/" +
        encodeURIComponent(actualTag)
    },
    "resolve-tag"
  );
  if (!response.ok) {
    return response;
  }

  if (!isRecord(response.value.body)) {
    return invalidCommitResponse(input.repository, actualTag);
  }
  const sha = response.value.body.sha;
  if (typeof sha !== "string" || !EXACT_COMMIT_PATTERN.test(sha)) {
    return invalidCommitResponse(input.repository, actualTag);
  }

  return { ok: true, value: sha };
}

type JsonRequest = Readonly<{
  path: string;
  query?: Readonly<Record<string, string>>;
}>;

async function requestJson(
  input: AcquirePublishedGitHubReleaseFactsInput,
  request: JsonRequest,
  operation: GitHubReleaseTransportUnavailable["facts"]["operation"]
): Promise<
  Result<
    Readonly<{ body: unknown }>,
    SourceAccessUnavailable | GitHubReleaseTransportUnavailable
  >
> {
  let response;
  try {
    response = await input.transport({
      ...request,
      ...(input.credential === undefined
        ? {}
        : { credential: input.credential })
    });
  } catch {
    return transportUnavailable(
      input.repository,
      operation,
      null
    );
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
    return transportUnavailable(
      input.repository,
      operation,
      response.status
    );
  }

  return {
    ok: true,
    value: {
      body: response.body
    }
  };
}

function repositoryPath(repository: RepositoryCoordinate): string {
  return (
    "/repos/" +
    encodeURIComponent(repository.owner) +
    "/" +
    encodeURIComponent(repository.repo)
  );
}

function compareReleaseFacts(
  left: GitHubPublishedReleaseFact,
  right: GitHubPublishedReleaseFact
): number {
  const tag = compareUtf8(left.actualTag, right.actualTag);
  return tag !== 0
    ? tag
    : compareUtf8(left.exactCommit, right.exactCommit);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function invalidReleaseResponse(
  repository: RepositoryCoordinate
): Result<never, InvalidGitHubReleaseResponse> {
  return {
    ok: false,
    error: productError("InvalidGitHubReleaseResponse", {
      repositoryCoordinate: repository.canonical
    })
  };
}

function invalidCommitResponse(
  repository: RepositoryCoordinate,
  actualTag: string
): Result<never, InvalidGitHubCommitResponse> {
  return {
    ok: false,
    error: productError("InvalidGitHubCommitResponse", {
      repositoryCoordinate: repository.canonical,
      actualTag
    })
  };
}

function transportUnavailable(
  repository: RepositoryCoordinate,
  operation: GitHubReleaseTransportUnavailable["facts"]["operation"],
  status: number | null
): Result<never, GitHubReleaseTransportUnavailable> {
  return {
    ok: false,
    error: productError("GitHubReleaseTransportUnavailable", {
      repositoryCoordinate: repository.canonical,
      operation,
      status
    })
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
