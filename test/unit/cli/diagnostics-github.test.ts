import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDiagnosticFailure
} from "../../../src/cli/diagnostics/index.js";
import {
  productError
} from "../../../src/domain/errors/index.js";

test("GitHub rate-limit diagnostics prefer Retry-After guidance", () => {
  const message = formatDiagnosticFailure(
    productError("GitHubRateLimited", {
      repositoryCoordinate: "akira-tl/skiloom",
      operation: "verify-repository",
      status: 403 as const,
      retryAfterSeconds: 60,
      resetAtUnixSeconds: null
    }),
    1
  );

  assert.equal(
    message,
    "skiloom: GitHub rate limit reached (HTTP 403); retry after 60 seconds, or set GH_TOKEN/GITHUB_TOKEN for authenticated GitHub access (exit 1)"
  );
});

test("GitHub rate-limit diagnostics preserve a known reset instant", () => {
  const message = formatDiagnosticFailure(
    productError("GitHubRateLimited", {
      repositoryCoordinate: "akira-tl/skiloom",
      operation: "resolve-ref",
      status: 403 as const,
      retryAfterSeconds: null,
      resetAtUnixSeconds: 1790329700
    }),
    1
  );

  assert.equal(
    message,
    "skiloom: GitHub rate limit reached (HTTP 403); retry after 2026-09-25T09:48:20.000Z, or set GH_TOKEN/GITHUB_TOKEN for authenticated GitHub access (exit 1)"
  );
});

test("GitHub rate-limit diagnostics tolerate an out-of-range reset instant", () => {
  assert.equal(
    formatDiagnosticFailure(
      productError("GitHubRateLimited", {
        repositoryCoordinate: "akira-tl/skiloom",
        operation: "read-blob",
        status: 403 as const,
        retryAfterSeconds: null,
        resetAtUnixSeconds: Number.MAX_SAFE_INTEGER
      }),
      1
    ),
    "skiloom: GitHub rate limit reached (HTTP 403); retry later, or set GH_TOKEN/GITHUB_TOKEN for authenticated GitHub access (exit 1)"
  );
});
