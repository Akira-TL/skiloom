import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  resolveTargetGraph,
  type DirectInstallRequirement
} from "../../../../src/domain/resolver/index.js";
import {
  acquireGitHubGitBinding,
  acquireGitHubReleaseRepositorySource,
  type GitHubJsonTransport,
  type GitHubRepositoryTransport
} from "../../../../src/runtime/source/github/index.js";
import {
  resolveSkiloomHomePaths
} from "../../../../src/runtime/home.js";

test("live Release facts are re-discovered, re-hashed, and fed into the existing whole-target resolver", async () => {
  const repository = repositoryCoordinate("Akira-TL/Skills");
  const exactCommit = "1".repeat(40);
  const fixture = repositoryFixture({
    exactCommit,
    files: {
      "skiloom-repo.toml": `schema = 1

[discovery]
include = ["skills/*"]
`,
      "skills/app/SKILL.md": skill("app", "Application Skill."),
      "skills/app/skiloom-package.toml": `schema = 1

[dependencies]
"akira-tl/skills/lib" = "^1.0.0"
`,
      "skills/app/run.sh": "#!/bin/sh\necho app\n",
      "skills/lib/SKILL.md": skill("lib", "Library Skill.")
    },
    executablePaths: new Set(["skills/app/run.sh"])
  });

  const source = await acquireGitHubReleaseRepositorySource({
    repository,
    repositoryTransport: verifiedRepositoryTransport("Akira-TL/Skills"),
    transport: releaseAndSnapshotTransport({
      actualTag: "v1.0.0",
      exactCommit,
      fixture
    })
  });

  assert.equal(source.ok, true);
  if (!source.ok) {
    return;
  }

  assert.equal(source.value.releases.length, 1);
  const release = source.value.releases[0]!;
  assert.equal(release.actualTag, "v1.0.0");
  assert.equal(release.exactCommit, exactCommit);
  assert.deepEqual(
    release.snapshot.packages.map((packageFact) => ({
      coordinate: packageFact.coordinate.canonical,
      packageRoot: packageFact.packageRoot,
      dependencyCoordinates: packageFact.dependencies.map(
        (dependency) => dependency.target.canonical
      )
    })),
    [
      {
        coordinate: "akira-tl/skills/app",
        packageRoot: "skills/app",
        dependencyCoordinates: ["akira-tl/skills/lib"]
      },
      {
        coordinate: "akira-tl/skills/lib",
        packageRoot: "skills/lib",
        dependencyCoordinates: []
      }
    ]
  );
  assert.equal(
    release.snapshot.packages.every((packageFact) =>
      /^sha256:[0-9a-f]{64}$/u.test(packageFact.contentDigest)
    ),
    true
  );

  const directRequirements: ReadonlyArray<DirectInstallRequirement> = [
    {
      kind: "repository",
      coordinate: repository,
      sourceKind: "github-release",
      versionRequirement: "^1.0.0"
    }
  ];
  const resolved = resolveTargetGraph({
    directRequirements,
    releaseSources: [source.value],
    gitBindings: []
  });

  assert.equal(resolved.ok, true);
  if (!resolved.ok) {
    return;
  }
  assert.deepEqual(
    resolved.value.packages.map((packageFact) => packageFact.packageCoordinate),
    ["akira-tl/skills/app", "akira-tl/skills/lib"]
  );
  assert.deepEqual(resolved.value.dependencyEdges, [
    {
      sourcePackageCoordinate: "akira-tl/skills/app",
      targetPackageCoordinate: "akira-tl/skills/lib"
    }
  ]);
  assert.deepEqual(resolved.value.sourceBindings, [
    {
      repositoryCoordinate: "akira-tl/skills",
      sourceKind: "github-release",
      version: "1.0.0",
      actualTag: "v1.0.0",
      exactCommit,
      immutable: true
    }
  ]);
});

test("explicit Git source is acquired as an exact snapshot without Release fallback", async () => {
  const repository = repositoryCoordinate("Akira-TL/Git-Skill");
  const exactCommit = "2".repeat(40);
  const seenPaths: string[] = [];
  const fixture = repositoryFixture({
    exactCommit,
    files: {
      "SKILL.md": skill("git-skill", "Explicit Git Skill.")
    }
  });

  const binding = await acquireGitHubGitBinding({
    repository,
    requestedRef: "refs/heads/main",
    repositoryTransport: verifiedRepositoryTransport("Akira-TL/Git-Skill"),
    transport: gitAndSnapshotTransport({
      requestedRef: "refs/heads/main",
      exactCommit,
      fixture,
      seenPaths
    })
  });

  assert.equal(binding.ok, true);
  if (!binding.ok) {
    return;
  }
  assert.equal(seenPaths.some((path) => path.includes("/releases")), false);
  assert.equal(binding.value.requestedRef, "refs/heads/main");
  assert.equal(binding.value.exactCommit, exactCommit);
  assert.deepEqual(
    binding.value.snapshot.packages.map((packageFact) => ({
      coordinate: packageFact.coordinate.canonical,
      packageRoot: packageFact.packageRoot
    })),
    [
      {
        coordinate: "akira-tl/git-skill/git-skill",
        packageRoot: "."
      }
    ]
  );

  const directRequirements: ReadonlyArray<DirectInstallRequirement> = [
    {
      kind: "package",
      coordinate: packageCoordinate("akira-tl/git-skill/git-skill"),
      sourceKind: "git",
      requestedRef: "refs/heads/main"
    }
  ];
  const resolved = resolveTargetGraph({
    directRequirements,
    releaseSources: [],
    gitBindings: [binding.value]
  });

  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.deepEqual(resolved.value.sourceBindings, [
      {
        repositoryCoordinate: "akira-tl/git-skill",
        sourceKind: "git",
        requestedRef: "refs/heads/main",
        exactCommit
      }
    ]);
  }
});

test("explicit Git transport failure may fall back to REST without changing source kind", async () => {
  const repository = repositoryCoordinate("Akira-TL/Git-Skill");
  const exactCommit = "9".repeat(40);
  const seenPaths: string[] = [];
  const fixture = repositoryFixture({
    exactCommit,
    files: {
      "SKILL.md": skill("git-skill", "REST compatibility fallback.")
    }
  });
  const binding = await acquireGitHubGitBinding({
    repository,
    requestedRef: "main",
    gitTransport: async () => ({
      ok: false,
      error: {
        code: "GitHubSystemGitUnavailable",
        facts: {
          repositoryCoordinate: "akira-tl/git-skill",
          operation: "fetch",
          reason: "access-unavailable"
        }
      }
    }),
    repositoryTransport: verifiedRepositoryTransport("Akira-TL/Git-Skill"),
    transport: gitAndSnapshotTransport({
      requestedRef: "main",
      exactCommit,
      fixture,
      seenPaths
    })
  });

  assert.equal(binding.ok, true);
  if (!binding.ok) {
    return;
  }
  assert.equal(binding.value.sourceKind, "git");
  assert.equal(binding.value.requestedRef, "main");
  assert.equal(binding.value.exactCommit, exactCommit);
  assert.equal(seenPaths.some((path) => path.includes("/releases")), false);
});

test("exact-source cache reuses only canonical repository plus exact commit and refetches corruption", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "skiloom-source-cache-"));
  const repository = repositoryCoordinate("Akira-TL/Cached-Skill");
  const exactCommit = "4".repeat(40);
  const sourceCachePath = resolveSkiloomHomePaths(
    join(cacheRoot, "home")
  ).sourceCachePath;
  const secret = "github_pat_cache_must_not_persist";
  const fixture = repositoryFixture({
    exactCommit,
    files: {
      "SKILL.md": skill("cached-skill", "Cached exact source.")
    }
  });

  try {
    const firstPaths: string[] = [];
    const first = await acquireGitHubGitBinding({
      repository,
      requestedRef: "main",
      credential: secret,
      sourceCachePath,
      repositoryTransport: verifiedRepositoryTransport("Akira-TL/Cached-Skill"),
      transport: gitAndSnapshotTransport({
        requestedRef: "main",
        exactCommit,
        fixture,
        seenPaths: firstPaths
      })
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.equal(
      firstPaths.some((path) => path.includes("/git/trees/")),
      true,
      "cold acquisition must fetch exact tree"
    );

    const cacheFiles = (await readdir(sourceCachePath, { recursive: true }))
      .filter((path) => path.endsWith(".json"));
    assert.equal(cacheFiles.length, 1);
    const cachePath = join(sourceCachePath, cacheFiles[0]!);
    const cacheText = await readFile(cachePath, "utf8");
    assert.equal(cacheText.includes(secret), false);
    assert.equal(cacheText.includes('"contentDigest"'), false);
    assert.equal(cachePath.includes("main"), false);

    const secondPaths: string[] = [];
    const second = await acquireGitHubGitBinding({
      repository,
      requestedRef: "stable",
      credential: secret,
      sourceCachePath,
      repositoryTransport: verifiedRepositoryTransport("Akira-TL/Cached-Skill"),
      transport: gitAndSnapshotTransport({
        requestedRef: "stable",
        exactCommit,
        fixture,
        seenPaths: secondPaths
      })
    });
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.deepEqual(second.value.snapshot, first.value.snapshot);
    assert.equal(
      secondPaths.some((path) => path.includes("/git/")),
      false,
      "mutable ref still resolves, but exact tree/blob acquisition must hit cache"
    );

    const corruptCache = JSON.parse(cacheText) as {
      integrity: string;
    };
    corruptCache.integrity = `sha256:${"0".repeat(64)}`;
    await writeFile(cachePath, JSON.stringify(corruptCache), "utf8");
    const recoveryPaths: string[] = [];
    const recovered = await acquireGitHubGitBinding({
      repository,
      requestedRef: "main",
      sourceCachePath,
      repositoryTransport: verifiedRepositoryTransport("Akira-TL/Cached-Skill"),
      transport: gitAndSnapshotTransport({
        requestedRef: "main",
        exactCommit,
        fixture,
        seenPaths: recoveryPaths
      })
    });
    assert.equal(recovered.ok, true);
    if (recovered.ok) {
      assert.deepEqual(recovered.value.snapshot, first.value.snapshot);
    }
    assert.equal(
      recoveryPaths.some((path) => path.includes("/git/trees/")),
      true,
      "corrupt cache must be discarded and refetched"
    );
    const recoveredCache = await readFile(cachePath, "utf8");
    assert.doesNotThrow(() => JSON.parse(recoveredCache));
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("source composition rejects invalid UTF-8 in machine-readable repository metadata", async () => {
  const repository = repositoryCoordinate("Akira-TL/Skills");
  const exactCommit = "3".repeat(40);
  const fixture = repositoryFixture({
    exactCommit,
    files: {
      "SKILL.md": skill("skills", "Root Skill.")
    },
    rawFiles: {
      "skiloom-repo.toml": Uint8Array.from([0xff, 0xfe])
    }
  });

  const source = await acquireGitHubGitBinding({
    repository,
    requestedRef: "main",
    repositoryTransport: verifiedRepositoryTransport("Akira-TL/Skills"),
    transport: gitAndSnapshotTransport({
      requestedRef: "main",
      exactCommit,
      fixture
    })
  });

  assert.deepEqual(source, {
    ok: false,
    error: {
      code: "InvalidGitHubSourceTextEncoding",
      facts: {
        repositoryCoordinate: "akira-tl/skills",
        path: "skiloom-repo.toml"
      }
    }
  });
});

function skill(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---
`;
}

function repositoryCoordinate(input: string) {
  const result = parseRepositoryCoordinate(input);
  if (!result.ok) {
    throw new Error(result.error.code);
  }
  return result.value;
}

function packageCoordinate(input: string) {
  const result = parsePackageCoordinate(input);
  if (!result.ok) {
    throw new Error(result.error.code);
  }
  return result.value;
}

type RepositoryFixture = Readonly<{
  exactCommit: string;
  treeSha: string;
  tree: ReadonlyArray<Readonly<{
    path: string;
    mode: "100644" | "100755";
    type: "blob";
    sha: string;
  }>>;
  blobs: Readonly<Record<string, Uint8Array>>;
}>;

function repositoryFixture(input: Readonly<{
  exactCommit: string;
  files: Readonly<Record<string, string>>;
  rawFiles?: Readonly<Record<string, Uint8Array>>;
  executablePaths?: ReadonlySet<string>;
}>): RepositoryFixture {
  const combined = [
    ...Object.entries(input.files).map(([path, content]) => [
      path,
      new TextEncoder().encode(content)
    ] as const),
    ...Object.entries(input.rawFiles ?? {})
  ].sort(([left], [right]) => left.localeCompare(right));

  const blobs: Record<string, Uint8Array> = {};
  const tree = combined.map(([path, content], index) => {
    const sha = (index + 10).toString(16).padStart(40, "0");
    blobs[sha] = Uint8Array.from(content);
    return {
      path,
      mode: input.executablePaths?.has(path) === true ? "100755" as const : "100644" as const,
      type: "blob" as const,
      sha
    };
  });

  return {
    exactCommit: input.exactCommit,
    treeSha: "f".repeat(40),
    tree,
    blobs
  };
}

function verifiedRepositoryTransport(
  fullName: string
): GitHubRepositoryTransport {
  return async () => ({
    status: 200,
    body: { full_name: fullName }
  });
}

function releaseAndSnapshotTransport(input: Readonly<{
  actualTag: string;
  exactCommit: string;
  fixture: RepositoryFixture;
}>): GitHubJsonTransport {
  return async (request) => {
    if (request.path.endsWith("/releases")) {
      return {
        status: 200,
        body:
          request.query?.page === "1"
            ? [
                {
                  tag_name: input.actualTag,
                  draft: false,
                  immutable: true,
                  target_commitish: "ignored"
                }
              ]
            : []
      };
    }
    if (request.path.endsWith("/commits/" + encodeURIComponent(input.actualTag))) {
      return { status: 200, body: { sha: input.exactCommit } };
    }
    return snapshotResponse(input.fixture, request.path);
  };
}

function gitAndSnapshotTransport(input: Readonly<{
  requestedRef: string;
  exactCommit: string;
  fixture: RepositoryFixture;
  seenPaths?: string[];
}>): GitHubJsonTransport {
  return async (request) => {
    input.seenPaths?.push(request.path);
    if (
      request.path.endsWith(
        "/commits/" + encodeURIComponent(input.requestedRef)
      )
    ) {
      return { status: 200, body: { sha: input.exactCommit } };
    }
    return snapshotResponse(input.fixture, request.path);
  };
}

function snapshotResponse(
  fixture: RepositoryFixture,
  path: string
): Readonly<{ status: number; body: unknown }> {
  if (path.endsWith("/git/commits/" + fixture.exactCommit)) {
    return {
      status: 200,
      body: {
        sha: fixture.exactCommit,
        tree: { sha: fixture.treeSha }
      }
    };
  }
  if (path.endsWith("/git/trees/" + fixture.treeSha)) {
    return {
      status: 200,
      body: {
        sha: fixture.treeSha,
        truncated: false,
        tree: fixture.tree
      }
    };
  }

  const sha = path.slice(path.lastIndexOf("/") + 1);
  const blob = fixture.blobs[sha];
  if (path.includes("/git/blobs/") && blob !== undefined) {
    return {
      status: 200,
      body: {
        sha,
        encoding: "base64",
        content: Buffer.from(blob).toString("base64")
      }
    };
  }

  throw new Error("unexpected GitHub fixture path: " + path);
}
