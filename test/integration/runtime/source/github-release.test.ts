import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  buildReleaseCandidateGroups
} from "../../../../src/domain/resolver/candidates.js";
import {
  acquirePublishedGitHubReleaseFacts,
  createGitHubJsonFetchTransport,
  type GitHubJsonTransport
} from "../../../../src/runtime/source/github/index.js";

test("published GitHub Releases resolve actual tags to exact commits and ignore target_commitish", async () => {
  const seenPaths: string[] = [];
  const transport: GitHubJsonTransport = async (request) => {
    seenPaths.push(withQuery(request.path, request.query));

    if (request.path.endsWith("/releases")) {
      const page = Number(request.query?.page ?? "1");
      if (page === 1) {
        return {
          status: 200,
          body: [
            {
              tag_name: "v9.0.0",
              draft: true,
              immutable: false,
              target_commitish: "must-not-resolve",
              published_at: "2030-01-01T00:00:00Z"
            },
            {
              tag_name: "v2.0.0",
              draft: false,
              immutable: false,
              target_commitish: "wrong-v2",
              published_at: "2020-01-01T00:00:00Z"
            }
          ]
        };
      }
      if (page === 2) {
        return {
          status: 200,
          body: [
            {
              tag_name: "v1.0.0",
              draft: false,
              immutable: true,
              target_commitish: "wrong-v1",
              published_at: "2035-01-01T00:00:00Z"
            }
          ]
        };
      }
      return { status: 200, body: [] };
    }

    if (request.path.endsWith("/commits/v2.0.0")) {
      return {
        status: 200,
        body: { sha: "2222222222222222222222222222222222222222" }
      };
    }
    if (request.path.endsWith("/commits/v1.0.0")) {
      return {
        status: 200,
        body: { sha: "1111111111111111111111111111111111111111" }
      };
    }
    throw new Error("unexpected path " + request.path);
  };

  const result = await acquirePublishedGitHubReleaseFacts({
    repository: repository("Akira-TL/Skiloom"),
    transport
  });

  assert.deepEqual(result, {
    ok: true,
    value: [
      {
        actualTag: "v1.0.0",
        draft: false,
        exactCommit: "1111111111111111111111111111111111111111",
        immutable: true
      },
      {
        actualTag: "v2.0.0",
        draft: false,
        exactCommit: "2222222222222222222222222222222222222222",
        immutable: false
      }
    ]
  });

  assert.equal(
    seenPaths.some((path) => path.includes("must-not-resolve")),
    false
  );
  assert.equal(
    seenPaths.some((path) => path.endsWith("/commits/v9.0.0")),
    false,
    "draft releases must not resolve tags"
  );
  assert.equal(
    seenPaths.filter((path) => path.includes("/releases?")).length,
    3,
    "pagination continues until an empty page"
  );
});

test("published exact facts attach snapshots and feed the existing Release candidate engine directly", async () => {
  const repositoryCoordinate = repository("akira-tl/skiloom");
  const acquired = await acquirePublishedGitHubReleaseFacts({
    repository: repositoryCoordinate,
    transport: orderedReleaseTransport([
      release("v2.0.0", false),
      release("not-semver", false),
      release("v1.0.0", true)
    ])
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) {
    return;
  }

  const groups = buildReleaseCandidateGroups({
    repository: repositoryCoordinate,
    requirements: [],
    releases: acquired.value.map((fact) => ({
      ...fact,
      snapshot: {
        source: fact.actualTag
      }
    }))
  });
  assert.equal(groups.ok, true);
  if (!groups.ok) {
    return;
  }

  assert.deepEqual(
    groups.value.map((group) => ({
      precedence: group.precedence,
      tags: group.candidates.map((candidate) => candidate.actualTag)
    })),
    [
      { precedence: "2.0.0", tags: ["v2.0.0"] },
      { precedence: "1.0.0", tags: ["v1.0.0"] }
    ]
  );
});

test("Release API ordering does not change normalized exact facts", async () => {
  const facts = [
    release("v2.0.0", false),
    release("v1.0.0", true)
  ];

  const forward = await acquirePublishedGitHubReleaseFacts({
    repository: repository("akira-tl/skiloom"),
    transport: orderedReleaseTransport(facts)
  });
  const reversed = await acquirePublishedGitHubReleaseFacts({
    repository: repository("akira-tl/skiloom"),
    transport: orderedReleaseTransport([...facts].reverse())
  });

  assert.deepEqual(reversed, forward);
});

test("Release listing rate-limit response stays distinct from source access denial", async () => {
  const result = await acquirePublishedGitHubReleaseFacts({
    repository: repository("akira-tl/skiloom"),
    transport: async () => ({
      status: 403,
      body: { message: "rate-limit provider detail" },
      rateLimit: {
        remaining: 0,
        retryAfterSeconds: null,
        resetAtUnixSeconds: 1790329700
      }
    })
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubRateLimited",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        operation: "list-releases",
        status: 403,
        retryAfterSeconds: null,
        resetAtUnixSeconds: 1790329700
      }
    }
  });
});

for (const status of [401, 403, 404] as const) {
  test(`Release listing access status ${status} maps to SourceAccessUnavailable`, async () => {
    const result = await acquirePublishedGitHubReleaseFacts({
      repository: repository("akira-tl/private"),
      transport: async () => ({
        status,
        body: { message: "do not expose transport text" }
      })
    });

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "SourceAccessUnavailable",
        facts: {
          repositoryCoordinate: "akira-tl/private",
          status
        }
      }
    });
  });
}

test("published Release metadata must contain tag_name draft and immutable fields", async () => {
  const result = await acquirePublishedGitHubReleaseFacts({
    repository: repository("akira-tl/skiloom"),
    transport: async (request) =>
      request.path.endsWith("/releases")
        ? {
            status: 200,
            body: [
              {
                tag_name: "v1.0.0",
                draft: false,
                target_commitish: "main"
              }
            ]
          }
        : { status: 200, body: { sha: "1".repeat(40) } }
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "InvalidGitHubReleaseResponse",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom"
      }
    }
  });
});

test("tag resolution requires an exact 40-hex commit response", async () => {
  const result = await acquirePublishedGitHubReleaseFacts({
    repository: repository("akira-tl/skiloom"),
    transport: async (request) => {
      if (request.path.endsWith("/releases")) {
        return {
          status: 200,
          body: [release("v1.0.0", false)]
        };
      }
      return { status: 200, body: { sha: "not-a-commit" } };
    }
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "InvalidGitHubCommitResponse",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        actualTag: "v1.0.0"
      }
    }
  });
});

test("caller cancellation while resolving a Release tag reports resolve-tag without retry", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const result = await acquirePublishedGitHubReleaseFacts({
    repository: repository("akira-tl/skiloom"),
    signal: controller.signal,
    transport: createGitHubJsonFetchTransport({
      maxAttempts: 4,
      retryDelayMs: 0,
      fetchImpl: async (input, init) => {
        attempts += 1;
        const url = String(input);
        if (url.includes("/releases?")) {
          return jsonResponse(200, [
            release("v1.0.0", false)
          ]);
        }
        if (url.endsWith("/commits/v1.0.0")) {
          controller.abort();
          return waitForAbort(init?.signal);
        }
        throw new RangeError("unexpected release request");
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
        operation: "resolve-tag",
        reason: "cancelled"
      }
    }
  });
});

test("Release transport exceptions are normalized without leaking exception text", async () => {
  const secret = "github_pat_release_transport_secret";
  const result = await acquirePublishedGitHubReleaseFacts({
    repository: repository("akira-tl/skiloom"),
    credential: secret,
    transport: async () => {
      throw new Error("release transport failed " + secret);
    }
  });

  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubReleaseTransportUnavailable",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        operation: "list-releases",
        status: null
      }
    }
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
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

function release(actualTag: string, immutable: boolean) {
  return {
    tag_name: actualTag,
    draft: false,
    immutable,
    target_commitish: "ignored"
  };
}

function orderedReleaseTransport(
  releases: ReadonlyArray<ReturnType<typeof release>>
): GitHubJsonTransport {
  return async (request) => {
    if (request.path.endsWith("/releases")) {
      const page = Number(request.query?.page ?? "1");
      return {
        status: 200,
        body: page === 1 ? releases : []
      };
    }

    const actualTag = decodeURIComponent(
      request.path.slice(request.path.lastIndexOf("/") + 1)
    );
    return {
      status: 200,
      body: {
        sha:
          actualTag === "v1.0.0"
            ? "1111111111111111111111111111111111111111"
            : "2222222222222222222222222222222222222222"
      }
    };
  };
}

function withQuery(
  path: string,
  query: Readonly<Record<string, string>> | undefined
): string {
  if (query === undefined) {
    return path;
  }
  return (
    path +
    "?" +
    new URLSearchParams(
      Object.entries(query)
    ).toString()
  );
}
