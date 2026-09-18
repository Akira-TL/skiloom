import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  acquireGitHubGitBinding,
  createGitHubJsonFetchTransport,
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

liveTest("live GitHub exact Git source reaches deterministic repository discovery facts", async () => {
  const parsed = parseRepositoryCoordinate("Akira-TL/fig_modify");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  const result = await acquireGitHubGitBinding({
    repository: parsed.value,
    requestedRef: "master",
    repositoryTransport: createGitHubRepositoryFetchTransport({
      userAgent: "skiloom-live-smoke"
    }),
    transport: createGitHubJsonFetchTransport({
      userAgent: "skiloom-live-smoke"
    })
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.repository.canonical, "akira-tl/fig_modify");
  assert.equal(result.value.sourceKind, "git");
  assert.equal(result.value.requestedRef, "master");
  assert.match(result.value.exactCommit, /^[0-9a-f]{40}$/u);
  assert.deepEqual(result.value.snapshot.packages, []);
});
