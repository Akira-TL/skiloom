import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  createGitHubRepositoryFetchTransport,
  verifyGitHubRepository
} from "../../../../src/runtime/source/github/index.js";

const liveTest =
  process.env.SKILOOM_GITHUB_LIVE_TEST === "1" ? test : test.skip;

liveTest("live GitHub repository metadata smoke maps API full_name through the identity boundary", async () => {
  const parsed = parseRepositoryCoordinate("octocat/Hello-World");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  const result = await verifyGitHubRepository({
    repository: parsed.value,
    transport: createGitHubRepositoryFetchTransport({
      userAgent: "skiloom-live-smoke"
    })
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      repository: {
        owner: "octocat",
        repo: "hello-world",
        canonical: "octocat/hello-world"
      }
    }
  });
});
