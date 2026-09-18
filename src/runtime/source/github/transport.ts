import {
  productError,
  type ProductError
} from "../../../domain/errors/index.js";
import type {
  GitHubRepositoryTransport
} from "./repository.js";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_ACCEPT = "application/vnd.github+json";
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_CONFIGURED_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE_HTTP_STATUSES = new Set([
  408,
  429,
  500,
  502,
  503,
  504
]);

export type GitHubTransportAbortReason = "cancelled" | "timeout";

export type GitHubTransportOperation =
  | "verify-repository"
  | "resolve-ref"
  | "list-releases"
  | "resolve-tag"
  | "read-commit"
  | "read-tree"
  | "read-blob";

export type GitHubTransportAborted = ProductError<
  "GitHubTransportAborted",
  Readonly<{
    repositoryCoordinate: string;
    operation: GitHubTransportOperation;
    reason: GitHubTransportAbortReason;
  }>
>;

export type GitHubFetchTransportOptions = Readonly<{
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  userAgent?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}>;

export type GitHubJsonTransportRequest = Readonly<{
  path: string;
  query?: Readonly<Record<string, string>>;
  credential?: string;
  signal?: AbortSignal;
}>;

export type GitHubJsonTransportResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export type GitHubJsonTransport = (
  request: GitHubJsonTransportRequest
) => Promise<GitHubJsonTransportResponse>;

class GitHubFetchAbort extends Error {
  readonly reason: GitHubTransportAbortReason;

  constructor(reason: GitHubTransportAbortReason) {
    super("GitHub transport aborted");
    this.name = "GitHubFetchAbort";
    this.reason = reason;
  }
}

class GitHubFetchUnavailable extends Error {
  constructor() {
    super("GitHub transport unavailable");
    this.name = "GitHubFetchUnavailable";
  }
}

type AttemptAbortState = Readonly<{
  signal: AbortSignal;
  reason: () => GitHubTransportAbortReason | undefined;
  cleanup: () => void;
}>;

export function createGitHubJsonFetchTransport(
  options: GitHubFetchTransportOptions = {}
): GitHubJsonTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = stripTrailingSlash(
    options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL
  );
  const userAgent = options.userAgent ?? "skiloom";
  const maxAttempts = boundedInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
    1,
    MAX_CONFIGURED_ATTEMPTS
  );
  const retryDelayMs = boundedInteger(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    "retryDelayMs",
    0,
    60_000
  );
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    1,
    300_000
  );

  return async (request) => {
    const url = new URL(apiBaseUrl + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Accept: GITHUB_ACCEPT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": userAgent
    };
    if (request.credential !== undefined) {
      headers.Authorization = "Bearer " + request.credential;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (request.signal?.aborted) {
        throw new GitHubFetchAbort("cancelled");
      }

      const abortState = createAttemptAbortState(
        request.signal,
        timeoutMs
      );
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers,
          redirect: "follow",
          signal: abortState.signal
        });

        if (
          RETRYABLE_HTTP_STATUSES.has(response.status) &&
          attempt < maxAttempts
        ) {
          abortState.cleanup();
          await waitBeforeRetry(
            retryDelayMs * attempt,
            request.signal
          );
          continue;
        }

        return {
          status: response.status,
          body: await readJsonBody(response, abortState)
        };
      } catch (error) {
        const abortReason = abortState.reason();
        abortState.cleanup();

        if (abortReason === "cancelled") {
          throw new GitHubFetchAbort("cancelled");
        }
        if (abortReason === "timeout") {
          if (attempt < maxAttempts) {
            await waitBeforeRetry(
              retryDelayMs * attempt,
              request.signal
            );
            continue;
          }
          throw new GitHubFetchAbort("timeout");
        }

        if (error instanceof GitHubFetchAbort) {
          throw error;
        }
        if (!isRetryableFetchError(error)) {
          throw new GitHubFetchUnavailable();
        }
        if (attempt < maxAttempts) {
          await waitBeforeRetry(
            retryDelayMs * attempt,
            request.signal
          );
          continue;
        }
        throw new GitHubFetchUnavailable();
      } finally {
        abortState.cleanup();
      }
    }

    throw new GitHubFetchUnavailable();
  };
}

export function createGitHubRepositoryFetchTransport(
  options: GitHubFetchTransportOptions = {}
): GitHubRepositoryTransport {
  const transport = createGitHubJsonFetchTransport(options);

  return async (request) =>
    transport({
      path:
        "/repos/" +
        encodeURIComponent(request.repository.owner) +
        "/" +
        encodeURIComponent(request.repository.repo),
      ...(request.credential === undefined
        ? {}
        : { credential: request.credential }),
      ...(request.signal === undefined
        ? {}
        : { signal: request.signal })
    });
}

export function gitHubTransportAbortResult(
  error: unknown,
  repositoryCoordinate: string,
  operation: GitHubTransportOperation
): GitHubTransportAborted | undefined {
  if (!(error instanceof GitHubFetchAbort)) {
    return undefined;
  }
  return productError("GitHubTransportAborted", {
    repositoryCoordinate,
    operation,
    reason: error.reason
  });
}

async function readJsonBody(
  response: Response,
  abortState: AttemptAbortState
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    const reason = abortState.reason();
    if (reason !== undefined) {
      throw new GitHubFetchAbort(reason);
    }
    return null;
  }
}

function createAttemptAbortState(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): AttemptAbortState {
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = (): void => {
    controller.abort();
  };
  callerSignal?.addEventListener("abort", onCallerAbort, {
    once: true
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    reason: () =>
      callerSignal?.aborted
        ? "cancelled"
        : timedOut
          ? "timeout"
          : undefined,
    cleanup: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };
}

async function waitBeforeRetry(
  delayMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal?.aborted) {
    throw new GitHubFetchAbort("cancelled");
  }
  if (delayMs === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new GitHubFetchAbort("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableFetchError(error: unknown): boolean {
  return error instanceof TypeError;
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
