import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  acquireGitHubGitBinding,
  createGitHubJsonFetchTransport,
  createGitHubRepositoryFetchTransport,
  resolveExplicitGitHubGitSource,
  verifyGitHubRepository
} from "../../../../src/runtime/source/github/index.js";

test("GitHub fetch transport maps canonical repository coordinates and credential headers", async () => {
  const seen: Array<Readonly<{
    input: string | URL | Request;
    init: RequestInit | undefined;
  }>> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ input, init });
    return new Response(
      JSON.stringify({ full_name: "Akira-TL/Skiloom" }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  const transport = createGitHubRepositoryFetchTransport({
    fetchImpl,
    apiBaseUrl: "https://api.github.test/",
    userAgent: "skiloom-test"
  });
  const response = await transport({
    repository: repository("Akira-TL/Skiloom"),
    credential: "github_pat_transport_only"
  });

  assert.equal(seen.length, 1);
  assert.equal(String(seen[0]?.input), "https://api.github.test/repos/akira-tl/skiloom");

  const headers = new Headers(seen[0]?.init?.headers);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  assert.equal(headers.get("user-agent"), "skiloom-test");
  assert.equal(headers.get("authorization"), "Bearer github_pat_transport_only");
  assert.deepEqual(response, {
    status: 200,
    body: { full_name: "Akira-TL/Skiloom" }
  });
});

test("GitHub fetch transport omits authorization without a credential and tolerates non-JSON error bodies", async () => {
  let authorization: string | null | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response("not json", { status: 502 });
  };

  const transport = createGitHubRepositoryFetchTransport({ fetchImpl });
  const response = await transport({
    repository: repository("akira-tl/skiloom")
  });

  assert.equal(authorization, null);
  assert.deepEqual(response, {
    status: 502,
    body: null
  });
});

test("GitHub fetch transport retries only bounded transient failures and preserves normalized facts", async () => {
  let attempts = 0;
  const transport = createGitHubRepositoryFetchTransport({
    maxAttempts: 3,
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      return attempts < 3
        ? jsonResponse(503, { message: "transient" })
        : jsonResponse(200, { full_name: "Akira-TL/Skiloom" });
    }
  });

  const retried = await verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    transport
  });
  const immediate = await verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    transport: createGitHubRepositoryFetchTransport({
      maxAttempts: 1,
      fetchImpl: async () =>
        jsonResponse(200, { full_name: "Akira-TL/Skiloom" })
    })
  });

  assert.equal(attempts, 3);
  assert.deepEqual(retried, immediate);
});

test("stable source-access status is not retried", async () => {
  let attempts = 0;
  const result = await verifyGitHubRepository({
    repository: repository("akira-tl/private"),
    transport: createGitHubRepositoryFetchTransport({
      maxAttempts: 4,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return jsonResponse(403, { message: "ambiguous access" });
      }
    })
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "SourceAccessUnavailable",
      facts: {
        repositoryCoordinate: "akira-tl/private",
        status: 403
      }
    }
  });
});

test("primary GitHub rate-limit 403 is distinct from source access denial", async () => {
  const result = await verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    transport: createGitHubRepositoryFetchTransport({
      maxAttempts: 1,
      fetchImpl: async () =>
        jsonResponse(
          403,
          { message: "sensitive provider text must not escape" },
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1790329700",
            "x-sensitive-header": "credential-sentinel"
          }
        )
    })
  });

  assert.equal(JSON.stringify(result).includes("credential-sentinel"), false);
  assert.equal(
    JSON.stringify(result).includes("sensitive provider text"),
    false
  );
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubRateLimited",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        operation: "verify-repository",
        status: 403,
        retryAfterSeconds: null,
        resetAtUnixSeconds: 1790329700
      }
    }
  });
});

test("secondary GitHub rate-limit 403 preserves only normalized retry guidance", async () => {
  const result = await verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    transport: createGitHubRepositoryFetchTransport({
      maxAttempts: 1,
      fetchImpl: async () =>
        jsonResponse(
          403,
          { message: "secondary rate limit detail" },
          {
            "retry-after": "60",
            "x-ratelimit-remaining": "42"
          }
        )
    })
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubRateLimited",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        operation: "verify-repository",
        status: 403,
        retryAfterSeconds: 60,
        resetAtUnixSeconds: null
      }
    }
  });
});

test("caller cancellation aborts in-flight GitHub work without hidden retries", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const transport = createGitHubRepositoryFetchTransport({
    maxAttempts: 4,
    retryDelayMs: 0,
    fetchImpl: async (_input, init) => {
      attempts += 1;
      return waitForAbort(init?.signal);
    }
  });

  const pending = verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    signal: controller.signal,
    credential: "credential-cancel-sentinel",
    transport
  });
  controller.abort();

  const result = await pending;
  assert.equal(attempts, 1);
  assert.equal(JSON.stringify(result).includes("credential-cancel-sentinel"), false);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubTransportAborted",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        operation: "verify-repository",
        reason: "cancelled"
      }
    }
  });
});

test("GitHub request timeout is a stable structured runtime result", async () => {
  let attempts = 0;
  const result = await verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    transport: createGitHubRepositoryFetchTransport({
      maxAttempts: 1,
      timeoutMs: 10,
      fetchImpl: async (_input, init) => {
        attempts += 1;
        return waitForAbort(init?.signal);
      }
    })
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubTransportAborted",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        operation: "verify-repository",
        reason: "timeout"
      }
    }
  });
});

test("stable missing Git ref response is not retried or converted into fallback", async () => {
  let attempts = 0;
  const result = await resolveExplicitGitHubGitSource({
    repository: repository("akira-tl/skiloom"),
    requestedRef: "missing-ref",
    transport: createGitHubJsonFetchTransport({
      maxAttempts: 4,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        return jsonResponse(422, { message: "unprocessable" });
      }
    })
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubExactCommitTransportUnavailable",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        requestedRef: "missing-ref",
        status: 422
      }
    }
  });
});

test("pipeline cancellation during exact snapshot acquisition keeps the precise operation", async () => {
  const controller = new AbortController();
  const exactCommit = "1".repeat(40);
  let attempts = 0;

  const result = await acquireGitHubGitBinding({
    repository: repository("akira-tl/skiloom"),
    requestedRef: "main",
    signal: controller.signal,
    repositoryTransport: async () => ({
      status: 200,
      body: { full_name: "Akira-TL/Skiloom" }
    }),
    transport: createGitHubJsonFetchTransport({
      maxAttempts: 4,
      retryDelayMs: 0,
      fetchImpl: async (input, init) => {
        attempts += 1;
        const url = String(input);
        if (url.endsWith("/commits/main")) {
          return jsonResponse(200, { sha: exactCommit });
        }
        if (url.endsWith("/git/commits/" + exactCommit)) {
          controller.abort();
          return waitForAbort(init?.signal);
        }
        throw new RangeError("unexpected source request");
      }
    })
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubTransportAborted",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        operation: "read-commit",
        reason: "cancelled"
      }
    }
  });
});

test("unclassified fetch exceptions are not retried as transient failures", async () => {
  let attempts = 0;
  const result = await verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    transport: createGitHubRepositoryFetchTransport({
      maxAttempts: 4,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        throw new RangeError("programming failure");
      }
    })
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubRepositoryTransportUnavailable",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        status: null
      }
    }
  });
});

test("transient network retry is bounded and secret-safe when exhausted", async () => {
  let attempts = 0;
  const result = await verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    credential: "credential-network-sentinel",
    transport: createGitHubRepositoryFetchTransport({
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError("network failure credential-network-sentinel");
      }
    })
  });

  assert.equal(attempts, 2);
  assert.equal(JSON.stringify(result).includes("credential-network-sentinel"), false);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubRepositoryTransportUnavailable",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        status: null
      }
    }
  });
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

function waitForAbort(
  signal: AbortSignal | null | undefined
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true }
    );
  });
}

function repository(input: string) {
  const parsed = parseRepositoryCoordinate(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}
