import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  verifyGitHubRepository,
  type GitHubRepositoryTransport,
  type GitHubRepositoryTransportRequest,
  type GitHubRepositoryTransportResponse
} from "../../../../src/runtime/source/github/index.js";

test("GitHub repository identity accepts case-only full_name differences", async () => {
  const requested = repository("Akira-TL/Skiloom");
  const transport = fakeTransport({
    status: 200,
    body: { full_name: "AKIRA-TL/SKILOOM" }
  });

  const result = await verifyGitHubRepository({
    repository: requested,
    transport
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      repository: {
        owner: "akira-tl",
        repo: "skiloom",
        canonical: "akira-tl/skiloom"
      }
    }
  });
});

test("GitHub repository identity rejects a true redirect without rewriting the requested coordinate", async () => {
  const requested = repository("legacy-owner/legacy-repo");
  const result = await verifyGitHubRepository({
    repository: requested,
    transport: fakeTransport({
      status: 200,
      body: { full_name: "new-owner/new-repo" }
    })
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "RepositoryCoordinateChanged",
      facts: {
        requestedRepositoryCoordinate: "legacy-owner/legacy-repo",
        resolvedRepositoryCoordinate: "new-owner/new-repo"
      }
    }
  });
});

for (const status of [401, 403, 404] as const) {
  test(`GitHub repository access status ${status} remains ambiguous and fails closed`, async () => {
    const result = await verifyGitHubRepository({
      repository: repository("private-owner/private-repo"),
      transport: fakeTransport({
        status,
        body: {
          message: "sensitive transport text should not escape"
        }
      })
    });

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "SourceAccessUnavailable",
        facts: {
          repositoryCoordinate: "private-owner/private-repo",
          status
        }
      }
    });
  });
}

test("GitHub repository metadata rejects malformed successful responses", async () => {
  const result = await verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    transport: fakeTransport({
      status: 200,
      body: {
        full_name: 123,
        token: "transport-secret"
      }
    })
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "InvalidGitHubRepositoryResponse",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom"
      }
    }
  });
  assert.equal(JSON.stringify(result).includes("transport-secret"), false);
});

test("GitHub transport exceptions are normalized without leaking exception text", async () => {
  const secret = "github_pat_transport_exception_secret";
  const result = await verifyGitHubRepository({
    repository: repository("akira-tl/skiloom"),
    credential: secret,
    transport: async () => {
      throw new Error("transport failed with " + secret);
    }
  });

  assert.equal(JSON.stringify(result).includes(secret), false);
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

test("GitHub credential is passed only to transport and never appears in identity results or errors", async () => {
  const requests: GitHubRepositoryTransportRequest[] = [];
  const credential = "github_pat_fixture_secret";
  const transport: GitHubRepositoryTransport = async (request) => {
    requests.push(request);
    return {
      status: 404,
      body: { message: credential }
    };
  };

  const result = await verifyGitHubRepository({
    repository: repository("akira-tl/private"),
    credential,
    transport
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.credential, credential);
  assert.equal(JSON.stringify(result).includes(credential), false);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "SourceAccessUnavailable",
      facts: {
        repositoryCoordinate: "akira-tl/private",
        status: 404
      }
    }
  });
});

function repository(input: string) {
  const parsed = parseRepositoryCoordinate(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}

function fakeTransport(
  response: GitHubRepositoryTransportResponse
): GitHubRepositoryTransport {
  return async () => response;
}
