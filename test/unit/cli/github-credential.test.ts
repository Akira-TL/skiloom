import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGitHubCredentialEnvironment
} from "../../../src/cli/github-credential/index.js";

test("GitHub credential environment uses GH_TOKEN before GITHUB_TOKEN", () => {
  assert.equal(
    resolveGitHubCredentialEnvironment({
      GH_TOKEN: "gh-primary",
      GITHUB_TOKEN: "github-secondary"
    }),
    "gh-primary"
  );
});

test("GitHub credential environment skips empty and whitespace-only values", () => {
  assert.equal(
    resolveGitHubCredentialEnvironment({
      GH_TOKEN: "   ",
      GITHUB_TOKEN: " github-fallback "
    }),
    "github-fallback"
  );
  assert.equal(
    resolveGitHubCredentialEnvironment({
      GH_TOKEN: "",
      GITHUB_TOKEN: " \t "
    }),
    undefined
  );
});

test("GitHub credential environment stays anonymous when neither token exists", () => {
  assert.equal(
    resolveGitHubCredentialEnvironment({}),
    undefined
  );
});
