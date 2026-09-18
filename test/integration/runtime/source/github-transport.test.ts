import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  createGitHubRepositoryFetchTransport
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

function repository(input: string) {
  const parsed = parseRepositoryCoordinate(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}
