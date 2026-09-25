import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  resolveExplicitGitHubGitSource
} from "../../../../src/runtime/source/github/index.js";

for (const example of [
  {
    name: "branch",
    requestedRef: "main",
    exactCommit: "1111111111111111111111111111111111111111"
  },
  {
    name: "tag",
    requestedRef: "v1.2.3",
    exactCommit: "2222222222222222222222222222222222222222"
  },
  {
    name: "exact sha",
    requestedRef: "3333333333333333333333333333333333333333",
    exactCommit: "3333333333333333333333333333333333333333"
  },
  {
    name: "slash-containing ref",
    requestedRef: "refs/heads/feature/demo",
    exactCommit: "4444444444444444444444444444444444444444"
  }
] as const) {
  test(`explicit Git ${example.name} preserves requested ref and resolves exact commit`, async () => {
    const seenPaths: string[] = [];
    const result = await resolveExplicitGitHubGitSource({
      repository: repository("Akira-TL/Skiloom"),
      requestedRef: example.requestedRef,
      transport: async (request) => {
        seenPaths.push(request.path);
        return {
          status: 200,
          body: {
            sha: example.exactCommit,
            irrelevant: {
              order: ["does", "not", "matter"]
            }
          }
        };
      }
    });

    assert.deepEqual(result, {
      ok: true,
      value: {
        repository: {
          owner: "akira-tl",
          repo: "skiloom",
          canonical: "akira-tl/skiloom"
        },
        sourceKind: "git",
        requestedRef: example.requestedRef,
        exactCommit: example.exactCommit
      }
    });

    assert.deepEqual(seenPaths, [
      "/repos/akira-tl/skiloom/commits/" +
        encodeURIComponent(example.requestedRef)
    ]);
    assert.equal(
      seenPaths.some((path) => path.includes("/releases")),
      false
    );
  });
}

test("explicit Git ref rate-limit response stays distinct from source access denial", async () => {
  const result = await resolveExplicitGitHubGitSource({
    repository: repository("akira-tl/skiloom"),
    requestedRef: "main",
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
        operation: "resolve-ref",
        status: 403,
        retryAfterSeconds: null,
        resetAtUnixSeconds: 1790329700
      }
    }
  });
});

for (const status of [401, 403, 404] as const) {
  test(`explicit Git ref access status ${status} remains SourceAccessUnavailable`, async () => {
    const result = await resolveExplicitGitHubGitSource({
      repository: repository("akira-tl/private"),
      requestedRef: "main",
      transport: async () => ({
        status,
        body: {
          message: "transport detail must not escape"
        }
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

test("explicit Git ref rejects malformed exact commit responses", async () => {
  const result = await resolveExplicitGitHubGitSource({
    repository: repository("akira-tl/skiloom"),
    requestedRef: "main",
    transport: async () => ({
      status: 200,
      body: {
        sha: "not-a-commit"
      }
    })
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "InvalidGitHubExactCommitResponse",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        requestedRef: "main"
      }
    }
  });
});

test("explicit Git ref transport errors do not trigger Release fallback", async () => {
  const paths: string[] = [];
  const result = await resolveExplicitGitHubGitSource({
    repository: repository("akira-tl/skiloom"),
    requestedRef: "missing-branch",
    transport: async (request) => {
      paths.push(request.path);
      return {
        status: 422,
        body: { message: "unprocessable" }
      };
    }
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubExactCommitTransportUnavailable",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        requestedRef: "missing-branch",
        status: 422
      }
    }
  });
  assert.equal(paths.length, 1);
  assert.equal(paths[0]?.includes("/releases"), false);
});

test("explicit Git transport exceptions are normalized without leaking credential or exception text", async () => {
  const secret = "github_pat_git_ref_secret";
  const result = await resolveExplicitGitHubGitSource({
    repository: repository("akira-tl/skiloom"),
    requestedRef: "main",
    credential: secret,
    transport: async () => {
      throw new Error("network failed with " + secret);
    }
  });

  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubExactCommitTransportUnavailable",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        requestedRef: "main",
        status: null
      }
    }
  });
});

test("exact Git binding is insensitive to irrelevant response field ordering", async () => {
  const responses = [
    {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      commit: { message: "first" },
      parents: []
    },
    {
      parents: [],
      commit: { message: "second" },
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ];

  const results = [];
  for (const body of responses) {
    results.push(
      await resolveExplicitGitHubGitSource({
        repository: repository("akira-tl/skiloom"),
        requestedRef: "main",
        transport: async () => ({
          status: 200,
          body
        })
      })
    );
  }

  assert.deepEqual(results[1], results[0]);
});

function repository(input: string) {
  const parsed = parseRepositoryCoordinate(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}
