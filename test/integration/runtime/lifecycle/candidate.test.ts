import assert from "node:assert/strict";
import test from "node:test";

import {
  computeLifecycleCandidate
} from "../../../../src/runtime/orchestration/lifecycle-candidate.js";
import {
  createGitHubRepositoryFetchTransport
} from "../../../../src/runtime/source/github/index.js";
import {
  commit,
  digest,
  gitPackageRequirement,
  gitRepository,
  registryState,
  release,
  releasePackageRequirement,
  releaseRepository,
  releaseRepositoryRequirement,
  reverseRepositoryFixture,
  skillPackage,
  sourceFixture,
  waitForAbort
} from "./github-source-fixture.js";

test("Package direct requirement expands live exact sources through a transitive repository", async () => {
  const fixture = sourceFixture([
    releaseRepository("acme/app", [
      release("v2.0.0", "2", [
        skillPackage(
          ".",
          "app",
          "Application.",
          {
            "acme/lib/lib": "^1.0.0"
          }
        )
      ]),
      release("v1.0.0", "1", [
        skillPackage(".", "app", "Old application.")
      ])
    ]),
    releaseRepository("acme/lib", [
      release("v1.5.0", "3", [
        skillPackage(".", "lib", "Library.")
      ])
    ])
  ]);

  const result = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app")
    ],
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.value.noChange, false);
  assert.deepEqual(result.value.candidate.sourceBindings, [
    {
      repositoryCoordinate: "acme/app",
      sourceKind: "github-release",
      version: "2.0.0",
      actualTag: "v2.0.0",
      exactCommit: commit("2"),
      immutable: true
    },
    {
      repositoryCoordinate: "acme/lib",
      sourceKind: "github-release",
      version: "1.5.0",
      actualTag: "v1.5.0",
      exactCommit: commit("3"),
      immutable: true
    }
  ]);
  assert.deepEqual(
    result.value.candidate.packages.map((entry) => entry.packageCoordinate),
    ["acme/app/app", "acme/lib/lib"]
  );
  assert.deepEqual(result.value.candidate.dependencyEdges, [
    {
      sourcePackageCoordinate: "acme/app/app",
      targetPackageCoordinate: "acme/lib/lib"
    }
  ]);
  assert.deepEqual(
    result.value.comparison.sourceDeltas.map((delta) => [
      delta.kind,
      delta.repositoryCoordinate
    ]),
    [
      ["repository-added", "acme/app"],
      ["repository-added", "acme/lib"]
    ]
  );
  assert.deepEqual(result.value.comparison.repositoryOrigins, [
    {
      repositoryCoordinate: "acme/app",
      kind: "direct",
      directRequirementCoordinate: "acme/app/app"
    },
    {
      repositoryCoordinate: "acme/lib",
      kind: "transitive",
      directRequirementCoordinate: "acme/app/app",
      packagePath: ["acme/app/app", "acme/lib/lib"]
    }
  ]);
});

test("repository-wide requirement rediscovers every Package from the selected exact snapshot", async () => {
  const fixture = sourceFixture([
    releaseRepository("acme/suite", [
      release("v1.0.0", "4", [
        skillPackage("skills/alpha", "alpha", "Alpha."),
        skillPackage("skills/beta", "beta", "Beta.")
      ], `schema = 1

[discovery]
include = ["skills/*"]
`)
    ])
  ]);

  const result = await computeLifecycleCandidate({
    directRequirements: [
      releaseRepositoryRequirement("acme/suite", "^1.0.0")
    ],
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.value.candidate.packages.map((entry) => entry.packageCoordinate),
      ["acme/suite/alpha", "acme/suite/beta"]
    );
    assert.deepEqual(result.value.candidate.dependencyEdges, []);
  }
});

test("explicit Git direct source never falls back to Release and transitive repositories remain Release sources", async () => {
  const fixture = sourceFixture([
    gitRepository("acme/git-app", "main", "5", [
      skillPackage(
        ".",
        "git-app",
        "Git application.",
        {
          "acme/lib/lib": "^1.0.0"
        }
      )
    ]),
    releaseRepository("acme/lib", [
      release("v1.2.0", "6", [
        skillPackage(".", "lib", "Library.")
      ])
    ])
  ]);

  const result = await computeLifecycleCandidate({
    directRequirements: [
      gitPackageRequirement("acme/git-app/git-app", "main")
    ],
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.value.candidate.sourceBindings, [
    {
      repositoryCoordinate: "acme/git-app",
      sourceKind: "git",
      requestedRef: "main",
      exactCommit: commit("5")
    },
    {
      repositoryCoordinate: "acme/lib",
      sourceKind: "github-release",
      version: "1.2.0",
      actualTag: "v1.2.0",
      exactCommit: commit("6"),
      immutable: true
    }
  ]);
  assert.equal(
    fixture.seenPaths.some((path) =>
      path === "/repos/acme/git-app/releases"
    ),
    false
  );
});

test("current accepted state is comparison-only and cannot pin update candidate ordering", async () => {
  const fixture = sourceFixture([
    releaseRepository("acme/app", [
      release("v1.0.0", "1", [
        skillPackage(".", "app", "Old application.")
      ]),
      release("v2.0.0", "2", [
        skillPackage(".", "app", "New application.")
      ])
    ], undefined, true)
  ]);

  const currentState = registryState({
    directRequirements: [
      {
        kind: "package",
        coordinate: "acme/app/app",
        sourceKind: "github-release",
        versionRequirement: null
      }
    ],
    sources: [
      {
        repositoryCoordinate: "acme/app",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit: commit("1"),
        immutable: true
      }
    ],
    packages: [
      {
        packageCoordinate: "acme/app/app",
        repositoryCoordinate: "acme/app",
        packageRoot: ".",
        contentDigest: digest("old")
      }
    ]
  });

  const result = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app")
    ],
    currentState,
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(
    result.value.candidate.sourceBindings[0]?.sourceKind,
    "github-release"
  );
  assert.equal(
    result.value.candidate.sourceBindings[0]?.sourceKind === "github-release"
      ? result.value.candidate.sourceBindings[0].version
      : undefined,
    "2.0.0"
  );
  assert.equal(result.value.noChange, false);
  assert.deepEqual(
    result.value.comparison.sourceDeltas.map((delta) => delta.kind),
    ["release-commit-changed", "release-tag-changed", "release-version-changed"]
  );
});

test("nullable accepted immutable provenance is preserved instead of being fabricated as false", async () => {
  const fixture = sourceFixture([
    releaseRepository("acme/app", [
      release("v1.0.0", "e", [
        skillPackage(".", "app", "Application.")
      ])
    ])
  ]);

  const initial = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app", "^1.0.0")
    ],
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });
  assert.equal(initial.ok, true);
  if (!initial.ok) {
    return;
  }

  const candidatePackage = initial.value.candidate.packages[0]!;
  const currentState = registryState({
    directRequirements: [
      {
        kind: "package",
        coordinate: "acme/app/app",
        sourceKind: "github-release",
        versionRequirement: "^1.0.0"
      }
    ],
    sources: [
      {
        repositoryCoordinate: "acme/app",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit: commit("e"),
        immutable: null
      }
    ],
    packages: [
      {
        packageCoordinate: candidatePackage.packageCoordinate,
        repositoryCoordinate: "acme/app",
        packageRoot: candidatePackage.packageRoot,
        contentDigest: candidatePackage.contentDigest
      }
    ]
  });

  const result = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app", "^1.0.0")
    ],
    currentState,
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.noChange, false);
    assert.deepEqual(result.value.comparison.sourceDeltas, [
      {
        kind: "immutable-signal-changed",
        repositoryCoordinate: "acme/app",
        previousImmutable: null,
        candidateImmutable: true,
        advisory: true
      }
    ]);
  }
});

test("identical accepted direct requirements and exact graph are a semantic no-change", async () => {
  const fixture = sourceFixture([
    releaseRepository("acme/app", [
      release("v1.0.0", "7", [
        skillPackage(".", "app", "Application.")
      ])
    ])
  ]);

  const initial = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app", "^1.0.0")
    ],
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });
  assert.equal(initial.ok, true);
  if (!initial.ok) {
    return;
  }

  const candidatePackage = initial.value.candidate.packages[0]!;
  const currentState = registryState({
    directRequirements: [
      {
        kind: "package",
        coordinate: "acme/app/app",
        sourceKind: "github-release",
        versionRequirement: "^1.0.0"
      }
    ],
    sources: [
      {
        repositoryCoordinate: "acme/app",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit: commit("7"),
        immutable: true
      }
    ],
    packages: [
      {
        packageCoordinate: candidatePackage.packageCoordinate,
        repositoryCoordinate: "acme/app",
        packageRoot: candidatePackage.packageRoot,
        contentDigest: candidatePackage.contentDigest
      }
    ]
  });

  const second = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app", "^1.0.0")
    ],
    currentState,
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });

  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.value.noChange, true);
    assert.deepEqual(second.value.comparison.sourceDeltas, []);
    assert.deepEqual(second.value.comparison.packageDeltas, []);
    assert.deepEqual(second.value.comparison.dependencyEdgeDeltas, []);
  }
});

test("fake GitHub ordering cannot change lifecycle candidate or comparison", async () => {
  const repositories = [
    releaseRepository("acme/app", [
      release("v2.0.0", "8", [
        skillPackage(
          ".",
          "app",
          "Application.",
          { "acme/lib/lib": "^1.0.0" }
        )
      ]),
      release("v1.0.0", "9", [
        skillPackage(".", "app", "Old application.")
      ])
    ]),
    releaseRepository("acme/lib", [
      release("v1.0.0", "a", [
        skillPackage(".", "lib", "Library.")
      ])
    ])
  ];
  const forwardFixture = sourceFixture(repositories);
  const reverseFixture = sourceFixture(
    [...repositories].reverse().map(reverseRepositoryFixture)
  );

  const inputRequirements = [
    releasePackageRequirement("acme/app/app")
  ];
  const forward = await computeLifecycleCandidate({
    directRequirements: inputRequirements,
    repositoryTransport: forwardFixture.repositoryTransport,
    transport: forwardFixture.transport
  });
  const reversed = await computeLifecycleCandidate({
    directRequirements: [...inputRequirements].reverse(),
    repositoryTransport: reverseFixture.repositoryTransport,
    transport: reverseFixture.transport
  });

  assert.deepEqual(reversed, forward);
});

test("inaccessible speculative higher Release does not block a lower viable candidate", async () => {
  const fixture = sourceFixture([
    releaseRepository("acme/app", [
      release("v2.0.0", "b", [
        skillPackage(
          ".",
          "app",
          "New application.",
          { "acme/private/private": "^1.0.0" }
        )
      ]),
      release("v1.0.0", "c", [
        skillPackage(".", "app", "Fallback application.")
      ])
    ])
  ]);

  const result = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app")
    ],
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.candidate.sourceBindings, [
      {
        repositoryCoordinate: "acme/app",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit: commit("c"),
        immutable: true
      }
    ]);
  }
});

test("mixed branch failures preserve aggregate Resolver diagnostics instead of collapsing to one speculative source error", async () => {
  const fixture = sourceFixture([
    releaseRepository("acme/app", [
      release("v2.0.0", "f", [
        skillPackage(
          ".",
          "app",
          "Private dependency candidate.",
          { "acme/private/private": "^1.0.0" }
        )
      ]),
      release("v1.0.0", "1", [
        skillPackage(
          ".",
          "app",
          "Unsatisfied public dependency candidate.",
          { "acme/lib/lib": "^2.0.0" }
        )
      ])
    ]),
    releaseRepository("acme/lib", [
      release("v1.0.0", "2", [
        skillPackage(".", "lib", "Library.")
      ])
    ])
  ]);

  const result = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app")
    ],
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "UnresolvableDependencyGraph");
    if (result.error.code === "UnresolvableDependencyGraph") {
      assert.equal(result.error.facts.repositoryCoordinate, "acme/app");
      assert.deepEqual(
        result.error.facts.attempts.map((attempt) => ({
          version: attempt.version,
          rootFailureCode: attempt.rootFailureCode,
          subjectCoordinate: attempt.subjectCoordinate
        })),
        [
          {
            version: "2.0.0",
            rootFailureCode: "UnsatisfiableReleaseRequirements",
            subjectCoordinate: "acme/private"
          },
          {
            version: "1.0.0",
            rootFailureCode: "UnsatisfiableReleaseRequirements",
            subjectCoordinate: "acme/lib"
          }
        ]
      );
    }
  }
});

test("required transitive source access failure propagates after Resolver exhausts viable branches", async () => {
  const fixture = sourceFixture([
    releaseRepository("acme/app", [
      release("v2.0.0", "d", [
        skillPackage(
          ".",
          "app",
          "Application.",
          { "acme/private/private": "^1.0.0" }
        )
      ])
    ])
  ]);

  const result = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app")
    ],
    repositoryTransport: fixture.repositoryTransport,
    transport: fixture.transport
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "SourceAccessUnavailable",
      facts: {
        repositoryCoordinate: "acme/private",
        status: 404
      }
    }
  });
});

test("caller cancellation propagates through lifecycle source planning without retries or writes", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/app/app")
    ],
    signal: controller.signal,
    repositoryTransport: createGitHubRepositoryFetchTransport({
      maxAttempts: 1,
      fetchImpl: async (_input, init) => {
        attempts += 1;
        return waitForAbort(init?.signal);
      }
    }),
    transport: async () => {
      throw new Error("JSON source transport must not run");
    }
  });

  controller.abort();
  const result = await pending;

  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubTransportAborted",
      facts: {
        repositoryCoordinate: "acme/app",
        operation: "verify-repository",
        reason: "cancelled"
      }
    }
  });
});

test("required direct source access failures remain structured planning failures", async () => {
  const result = await computeLifecycleCandidate({
    directRequirements: [
      releasePackageRequirement("acme/private/private")
    ],
    repositoryTransport: async () => ({
      status: 404,
      body: { message: "not found or private" }
    }),
    transport: async () => {
      throw new Error("source transport must not run after identity failure");
    }
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "SourceAccessUnavailable",
      facts: {
        repositoryCoordinate: "acme/private",
        status: 404
      }
    }
  });
});
