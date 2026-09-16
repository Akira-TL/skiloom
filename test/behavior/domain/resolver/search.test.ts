import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  parsePackageCoordinate,
  parseRepositoryCoordinate,
  type PackageCoordinate,
  type RepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  resolveTargetGraph,
  type DirectInstallRequirement,
  type FixedReleaseRepositorySource,
  type ResolverCandidateGraph,
  type ResolverGitBinding,
  type ResolverPackageFact,
  type ResolverRepositorySnapshot,
  type ResolverSearchError
} from "../../../../src/domain/resolver/index.js";

type DirectFixture = Readonly<{
  kind: "package" | "repository";
  coordinate: string;
  source: "github-release" | "git";
  version?: string;
  ref?: string;
}>;

type DependencyFixture = Readonly<{
  target: string;
  requirement: string;
}>;

type PackageFixture = Readonly<{
  coordinate: string;
  packageRoot: string;
  contentDigest: string;
  dependencies: ReadonlyArray<DependencyFixture>;
}>;

type SnapshotFixture = Readonly<{
  packages: ReadonlyArray<PackageFixture>;
}>;

type ReleaseFixture = Readonly<{
  tag: string;
  commit: string;
  immutable: boolean;
  draft?: boolean;
  snapshot: SnapshotFixture;
}>;

type ReleaseSourceFixture = Readonly<{
  repository: string;
  releases: ReadonlyArray<ReleaseFixture>;
}>;

type GitBindingFixture = Readonly<{
  repository: string;
  requestedRef: string;
  exactCommit: string;
  snapshot: SnapshotFixture;
}>;

type SearchFixtureBase = Readonly<{
  id: string;
  directRequirements: ReadonlyArray<DirectFixture>;
  releaseSources: ReadonlyArray<ReleaseSourceFixture>;
  gitBindings?: ReadonlyArray<GitBindingFixture>;
}>;

type SuccessFixture = SearchFixtureBase & Readonly<{
  expected: ResolverCandidateGraph;
}>;

type ErrorFixture = SearchFixtureBase & Readonly<{
  expectedError: ResolverSearchError;
}>;

type Fixture = Readonly<{
  fixtureVersion: 1;
  success: ReadonlyArray<SuccessFixture>;
  errors: ReadonlyArray<ErrorFixture>;
}>;

test("whole-Target resolver uses canonical highest-first backtracking", async () => {
  const fixture = await readFixture();

  for (const example of fixture.success) {
    const input = buildSearchInput(example);
    const result = resolveTargetGraph(input);
    assert.equal(result.ok, true, example.id);
    if (result.ok) {
      assert.deepEqual(result.value, example.expected, example.id);
      assert.equal(
        result.value.sourceBindings.every((binding, index, bindings) =>
          index === 0 || bindings[index - 1]!.repositoryCoordinate < binding.repositoryCoordinate
        ),
        true,
        `${example.id}: source bindings are canonical ordered`
      );
    }

    const reversed = resolveTargetGraph(reverseSearchInput(input));
    assert.deepEqual(reversed, result, `${example.id}: reversed fixed facts`);
  }
});

test("whole-Target resolver failures expose deterministic structured facts", async () => {
  const fixture = await readFixture();

  for (const example of fixture.errors) {
    const input = buildSearchInput(example);
    const result = resolveTargetGraph(input);
    assert.equal(result.ok, false, example.id);
    if (!result.ok) {
      assert.deepEqual(result.error, example.expectedError, example.id);
    }

    const reversed = resolveTargetGraph(reverseSearchInput(input));
    assert.deepEqual(reversed, result, `${example.id}: reversed fixed facts`);
  }
});

function buildSearchInput(example: SearchFixtureBase): Readonly<{
  directRequirements: ReadonlyArray<DirectInstallRequirement>;
  releaseSources: ReadonlyArray<FixedReleaseRepositorySource>;
  gitBindings: ReadonlyArray<ResolverGitBinding>;
}> {
  return {
    directRequirements: example.directRequirements.map(parseDirectRequirement),
    releaseSources: example.releaseSources.map(parseReleaseSource),
    gitBindings: (example.gitBindings ?? []).map(parseGitBinding)
  };
}

function parseDirectRequirement(fixture: DirectFixture): DirectInstallRequirement {
  const coordinate = fixture.kind === "package"
    ? packageCoordinate(fixture.coordinate)
    : repositoryCoordinate(fixture.coordinate);

  if (fixture.source === "git") {
    assert.equal(typeof fixture.ref, "string", `${fixture.coordinate}: git ref`);
    return {
      kind: fixture.kind,
      coordinate: coordinate as PackageCoordinate & RepositoryCoordinate,
      sourceKind: "git",
      requestedRef: fixture.ref ?? ""
    } as DirectInstallRequirement;
  }

  return {
    kind: fixture.kind,
    coordinate: coordinate as PackageCoordinate & RepositoryCoordinate,
    sourceKind: "github-release",
    ...(fixture.version === undefined ? {} : { versionRequirement: fixture.version })
  } as DirectInstallRequirement;
}

function parseReleaseSource(fixture: ReleaseSourceFixture): FixedReleaseRepositorySource {
  return {
    repository: repositoryCoordinate(fixture.repository),
    releases: fixture.releases.map((release) => ({
      actualTag: release.tag,
      draft: release.draft ?? false,
      exactCommit: release.commit,
      immutable: release.immutable,
      snapshot: parseSnapshot(release.snapshot)
    }))
  };
}

function parseGitBinding(fixture: GitBindingFixture): ResolverGitBinding {
  return {
    repository: repositoryCoordinate(fixture.repository),
    sourceKind: "git",
    requestedRef: fixture.requestedRef,
    exactCommit: fixture.exactCommit,
    snapshot: parseSnapshot(fixture.snapshot)
  };
}

function parseSnapshot(fixture: SnapshotFixture): ResolverRepositorySnapshot {
  return {
    packages: fixture.packages.map((packageFixture): ResolverPackageFact => ({
      coordinate: packageCoordinate(packageFixture.coordinate),
      packageRoot: packageFixture.packageRoot,
      contentDigest: packageFixture.contentDigest,
      dependencies: packageFixture.dependencies.map((dependency) => ({
        target: packageCoordinate(dependency.target),
        requirement: dependency.requirement
      }))
    }))
  };
}

function repositoryCoordinate(input: string): RepositoryCoordinate {
  const parsed = parseRepositoryCoordinate(input);
  assert.equal(parsed.ok, true, input);
  if (!parsed.ok) {
    throw new Error(`invalid repository coordinate fixture: ${input}`);
  }
  return parsed.value;
}

function packageCoordinate(input: string): PackageCoordinate {
  const parsed = parsePackageCoordinate(input);
  assert.equal(parsed.ok, true, input);
  if (!parsed.ok) {
    throw new Error(`invalid package coordinate fixture: ${input}`);
  }
  return parsed.value;
}

function reverseSearchInput(input: Readonly<{
  directRequirements: ReadonlyArray<DirectInstallRequirement>;
  releaseSources: ReadonlyArray<FixedReleaseRepositorySource>;
  gitBindings: ReadonlyArray<ResolverGitBinding>;
}>): Readonly<{
  directRequirements: ReadonlyArray<DirectInstallRequirement>;
  releaseSources: ReadonlyArray<FixedReleaseRepositorySource>;
  gitBindings: ReadonlyArray<ResolverGitBinding>;
}> {
  return {
    directRequirements: [...input.directRequirements].reverse(),
    releaseSources: [...input.releaseSources].reverse().map((source) => ({
      repository: source.repository,
      releases: [...source.releases].reverse().map((release) => ({
        ...release,
        snapshot: {
          packages: [...release.snapshot.packages].reverse().map((packageFact) => ({
            ...packageFact,
            dependencies: [...packageFact.dependencies].reverse()
          }))
        }
      }))
    })),
    gitBindings: [...input.gitBindings].reverse().map((binding) => ({
      ...binding,
      snapshot: {
        packages: [...binding.snapshot.packages].reverse().map((packageFact) => ({
          ...packageFact,
          dependencies: [...packageFact.dependencies].reverse()
        }))
      }
    }))
  };
}

async function readFixture(): Promise<Fixture> {
  const raw = await readFile(
    resolve("behavior-fixtures", "resolver", "search.json"),
    "utf8"
  );
  return JSON.parse(raw) as Fixture;
}
