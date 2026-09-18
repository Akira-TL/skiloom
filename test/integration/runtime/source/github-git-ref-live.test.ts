import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  createGitHubJsonFetchTransport,
  resolveExplicitGitHubGitSource
} from "../../../../src/runtime/source/github/index.js";

const liveTest =
  process.env.SKILOOM_GITHUB_LIVE_TEST === "1" ? test : test.skip;

liveTest("live GitHub Git-ref smoke resolves an explicit branch to one exact commit", async () => {
  const parsed = parseRepositoryCoordinate("octocat/Hello-World");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  const result = await resolveExplicitGitHubGitSource({
    repository: parsed.value,
    requestedRef: "master",
    transport: createGitHubJsonFetchTransport({
      userAgent: "skiloom-live-smoke"
    })
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.requestedRef, "master");
  assert.match(result.value.exactCommit, /^[0-9a-f]{40}$/u);
});
