import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  discoverRepositorySkills
} from "../../../../src/domain/discovery/index.js";
import {
  buildPackageSnapshot
} from "../../../../src/domain/snapshot/index.js";
import {
  acquireExactGitHubRepositorySnapshot,
  type GitHubJsonTransport
} from "../../../../src/runtime/source/github/index.js";

test("exact GitHub commit acquisition reproduces regular bytes and Git executable mode deterministically", async () => {
  const result = await acquireExactGitHubRepositorySnapshot({
    repository: repository("Akira-TL/Skiloom"),
    exactCommit: "1111111111111111111111111111111111111111",
    transport: snapshotTransport([
      treeEntry("scripts/run.sh", "100755", "blob", "b".repeat(40)),
      treeEntry("docs", "040000", "tree", "d".repeat(40)),
      treeEntry("SKILL.md", "100644", "blob", "a".repeat(40))
    ], {
      ["a".repeat(40)]: Buffer.from(
        "---\nname: skiloom\ndescription: exact snapshot fixture\n---\n",
        "utf8"
      ),
      ["b".repeat(40)]: Buffer.from("#!/bin/sh\necho ok\n", "utf8")
    })
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.value.repository.canonical, "akira-tl/skiloom");
  assert.equal(
    result.value.exactCommit,
    "1111111111111111111111111111111111111111"
  );
  assert.deepEqual(
    result.value.entries.map((entry) =>
      entry.fileType === "regular"
        ? {
            path: new TextDecoder().decode(entry.pathBytes),
            fileType: entry.fileType,
            gitMode: entry.gitMode,
            content: Buffer.from(entry.content).toString("utf8")
          }
        : {
            path: new TextDecoder().decode(entry.pathBytes),
            fileType: entry.fileType
          }
    ),
    [
      {
        path: "SKILL.md",
        fileType: "regular",
        gitMode: "100644",
        content:
          "---\nname: skiloom\ndescription: exact snapshot fixture\n---\n"
      },
      {
        path: "scripts/run.sh",
        fileType: "regular",
        gitMode: "100755",
        content: "#!/bin/sh\necho ok\n"
      }
    ]
  );

  const discovery = discoverRepositorySkills({
    repositoryRootBasename: "skiloom",
    files: result.value.entries.flatMap((entry) =>
      entry.fileType === "regular"
        ? [
            {
              path: new TextDecoder().decode(entry.pathBytes),
              content: new TextDecoder().decode(entry.content)
            }
          ]
        : []
    )
  });
  assert.equal(discovery.ok, true);
  if (discovery.ok) {
    assert.deepEqual(discovery.value, [
      {
        name: "skiloom",
        description: "exact snapshot fixture",
        packageRoot: "."
      }
    ]);
  }

  const packageSnapshot = buildPackageSnapshot({
    packageRoot: ".",
    discoveredPackageRoots: ["."],
    entries: result.value.entries
  });
  assert.equal(packageSnapshot.ok, true);
  if (packageSnapshot.ok) {
    assert.deepEqual(
      packageSnapshot.value.entries.map((entry) => ({
        path: entry.path,
        executable: entry.executable
      })),
      [
        { path: "SKILL.md", executable: false },
        { path: "scripts/run.sh", executable: true }
      ]
    );
  }
});

test("Git tree response ordering cannot change the acquired repository snapshot", async () => {
  const entries = [
    treeEntry("b.txt", "100644", "blob", "b".repeat(40)),
    treeEntry("a.txt", "100644", "blob", "a".repeat(40))
  ];
  const blobs = {
    ["a".repeat(40)]: Buffer.from("a"),
    ["b".repeat(40)]: Buffer.from("b")
  };

  const forward = await acquireExactGitHubRepositorySnapshot({
    repository: repository("akira-tl/skiloom"),
    exactCommit: "1".repeat(40),
    transport: snapshotTransport(entries, blobs)
  });
  const reversed = await acquireExactGitHubRepositorySnapshot({
    repository: repository("akira-tl/skiloom"),
    exactCommit: "1".repeat(40),
    transport: snapshotTransport([...entries].reverse(), blobs)
  });

  assert.deepEqual(reversed, forward);
});

test("Git symlink entries are preserved as symlink facts and their target blobs are never followed", async () => {
  const seenBlobShas: string[] = [];
  const symlinkSha = "c".repeat(40);
  const result = await acquireExactGitHubRepositorySnapshot({
    repository: repository("akira-tl/skiloom"),
    exactCommit: "1".repeat(40),
    transport: snapshotTransport(
      [
        treeEntry("SKILL.md", "100644", "blob", "a".repeat(40)),
        treeEntry("linked", "120000", "blob", symlinkSha)
      ],
      {
        ["a".repeat(40)]: Buffer.from(
          "---\nname: skiloom\ndescription: symlink fixture\n---\n"
        )
      },
      seenBlobShas
    )
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(seenBlobShas, ["a".repeat(40)]);
  assert.deepEqual(result.value.entries[1], {
    pathBytes: new TextEncoder().encode("linked"),
    fileType: "symlink"
  });

  const packageSnapshot = buildPackageSnapshot({
    packageRoot: ".",
    discoveredPackageRoots: ["."],
    entries: result.value.entries
  });
  assert.deepEqual(packageSnapshot, {
    ok: false,
    error: {
      code: "UnsupportedPackageFileType",
      facts: {
        path: "linked",
        fileType: "symlink"
      }
    }
  });
});

test("Git submodule/gitlink entries fail closed instead of being skipped", async () => {
  const result = await acquireExactGitHubRepositorySnapshot({
    repository: repository("akira-tl/skiloom"),
    exactCommit: "1".repeat(40),
    transport: snapshotTransport(
      [
        treeEntry(
          "vendor/dependency",
          "160000",
          "commit",
          "d".repeat(40)
        )
      ],
      {}
    )
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "UnsupportedGitTreeEntry",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        path: "vendor/dependency",
        mode: "160000",
        type: "commit"
      }
    }
  });
});

test("truncated recursive Git trees fail closed", async () => {
  const transport: GitHubJsonTransport = async (request) => {
    if (request.path.includes("/git/commits/")) {
      return commitResponse();
    }
    if (request.path.includes("/git/trees/")) {
      return {
        status: 200,
        body: {
          sha: "2".repeat(40),
          truncated: true,
          tree: []
        }
      };
    }
    throw new Error("unexpected request");
  };

  const result = await acquireExactGitHubRepositorySnapshot({
    repository: repository("akira-tl/skiloom"),
    exactCommit: "1".repeat(40),
    transport
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubTreeTruncated",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        exactCommit: "1111111111111111111111111111111111111111"
      }
    }
  });
});

test("malformed Git blob responses fail with the affected repository path", async () => {
  const blobSha = "a".repeat(40);
  const transport: GitHubJsonTransport = async (request) => {
    if (request.path.includes("/git/commits/")) {
      return commitResponse();
    }
    if (request.path.includes("/git/trees/")) {
      return treeResponse([
        treeEntry("SKILL.md", "100644", "blob", blobSha)
      ]);
    }
    if (request.path.includes("/git/blobs/")) {
      return {
        status: 200,
        body: {
          sha: blobSha,
          encoding: "base64",
          content: "not valid base64 ***"
        }
      };
    }
    throw new Error("unexpected request");
  };

  const result = await acquireExactGitHubRepositorySnapshot({
    repository: repository("akira-tl/skiloom"),
    exactCommit: "1".repeat(40),
    transport
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "InvalidGitHubBlobResponse",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        path: "SKILL.md"
      }
    }
  });
});

test("exact snapshot rate-limit response stays distinct from source access denial", async () => {
  const result = await acquireExactGitHubRepositorySnapshot({
    repository: repository("akira-tl/skiloom"),
    exactCommit: "1".repeat(40),
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
        operation: "read-commit",
        status: 403,
        retryAfterSeconds: null,
        resetAtUnixSeconds: 1790329700
      }
    }
  });
});

for (const status of [401, 403, 404] as const) {
  test(`exact snapshot access status ${status} remains SourceAccessUnavailable`, async () => {
    const result = await acquireExactGitHubRepositorySnapshot({
      repository: repository("akira-tl/private"),
      exactCommit: "1".repeat(40),
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

test("snapshot transport exceptions are normalized without leaking credentials or exception text", async () => {
  const secret = "github_pat_snapshot_secret";
  const result = await acquireExactGitHubRepositorySnapshot({
    repository: repository("akira-tl/skiloom"),
    exactCommit: "1".repeat(40),
    credential: secret,
    transport: async () => {
      throw new Error("snapshot failed " + secret);
    }
  });

  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubSnapshotTransportUnavailable",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        operation: "read-commit",
        status: null
      }
    }
  });
});

test("invalid exact commit input fails before any GitHub request", async () => {
  let called = false;
  const result = await acquireExactGitHubRepositorySnapshot({
    repository: repository("akira-tl/skiloom"),
    exactCommit: "not-a-commit",
    transport: async () => {
      called = true;
      throw new Error("must not be called");
    }
  });

  assert.equal(called, false);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "InvalidExactGitHubCommit",
      facts: {
        repositoryCoordinate: "akira-tl/skiloom",
        exactCommit: "not-a-commit"
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

function treeEntry(
  path: string,
  mode: string,
  type: string,
  sha: string
) {
  return { path, mode, type, sha };
}

function commitResponse() {
  return {
    status: 200,
    body: {
      sha: "1".repeat(40),
      tree: {
        sha: "2".repeat(40)
      }
    }
  };
}

function treeResponse(
  entries: ReadonlyArray<ReturnType<typeof treeEntry>>
) {
  return {
    status: 200,
    body: {
      sha: "2".repeat(40),
      truncated: false,
      tree: entries
    }
  };
}

function snapshotTransport(
  entries: ReadonlyArray<ReturnType<typeof treeEntry>>,
  blobs: Readonly<Record<string, Buffer>>,
  seenBlobShas: string[] = []
): GitHubJsonTransport {
  return async (request) => {
    if (request.path.includes("/git/commits/")) {
      return commitResponse();
    }
    if (request.path.includes("/git/trees/")) {
      return treeResponse(entries);
    }
    if (request.path.includes("/git/blobs/")) {
      const sha = decodeURIComponent(
        request.path.slice(request.path.lastIndexOf("/") + 1)
      );
      seenBlobShas.push(sha);
      const content = blobs[sha];
      if (content === undefined) {
        throw new Error("unexpected blob " + sha);
      }
      return {
        status: 200,
        body: {
          sha,
          encoding: "base64",
          content: content.toString("base64")
        }
      };
    }
    throw new Error("unexpected request " + request.path);
  };
}
