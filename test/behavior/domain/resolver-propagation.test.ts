import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../../../src/domain/coordinate/index.js";
import { parseReleaseVersion } from "../../../src/domain/requirement/index.js";
import {
  propagateResolverState,
  type BoundRepositorySource,
  type DirectInstallRequirement,
  type ResolverPackageFact,
  type ResolverPropagationError,
  type ResolverPropagationResult
} from "../../../src/domain/resolver/index.js";

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

type DirectRequirementFixture = Readonly<{
  kind: "package" | "repository";
  coordinate: string;
  source: "github-release" | "git";
  version?: string;
  ref?: string;
}>;

type ReleaseBindingFixture = Readonly<{
  repository: string;
  source: "github-release";
  version: string;
  actualTag: string;
  exactCommit: string;
  immutable: boolean;
  packages: ReadonlyArray<PackageFixture>;
}>;

type GitBindingFixture = Readonly<{
  repository: string;
  source: "git";
  ref: string;
  exactCommit: string;
  packages: ReadonlyArray<PackageFixture>;
}>;

type BindingFixture = ReleaseBindingFixture | GitBindingFixture;

type SuccessFixture = Readonly<{
  name: string;
  directRequirements: ReadonlyArray<DirectRequirementFixture>;
  bindings: ReadonlyArray<BindingFixture>;
  expected: ResolverPropagationResult;
}>;

type ErrorFixture = Readonly<{
  name: string;
  directRequirements: ReadonlyArray<DirectRequirementFixture>;
  bindings: ReadonlyArray<BindingFixture>;
  expectedError: ResolverPropagationError;
}>;

type Fixture = Readonly<{
  cases: ReadonlyArray<SuccessFixture>;
  errors: ReadonlyArray<ErrorFixture>;
}>;

test("resolver initialization and propagation behavior fixtures", async () => {
  const fixture = await readFixture();

  for (const example of fixture.cases) {
    const input = buildInput(example.directRequirements, example.bindings);
    const result = propagateResolverState(input);
    assert.equal(result.ok, true, example.name);
    if (result.ok) {
      assert.deepEqual(result.value, example.expected, example.name);
    }

    const reversedInput = buildInput(
      [...example.directRequirements].reverse(),
      reverseBindings(example.bindings)
    );
    assert.deepEqual(
      propagateResolverState(reversedInput),
      result,
      `${example.name}: reversed enumeration order`
    );
  }
});

test("resolver propagation failures expose stable structured facts", async () => {
  const fixture = await readFixture();

  for (const example of fixture.errors) {
    const input = buildInput(example.directRequirements, example.bindings);
    const result = propagateResolverState(input);
    assert.equal(result.ok, false, example.name);
    if (!result.ok) {
      assert.deepEqual(result.error, example.expectedError, example.name);
    }

    const reversedInput = buildInput(
      [...example.directRequirements].reverse(),
      reverseBindings(example.bindings)
    );
    assert.deepEqual(
      propagateResolverState(reversedInput),
      result,
      `${example.name}: reversed enumeration order`
    );
  }
});

function buildInput(
  directFixtures: ReadonlyArray<DirectRequirementFixture>,
  bindingFixtures: ReadonlyArray<BindingFixture>
): Readonly<{
  directRequirements: ReadonlyArray<DirectInstallRequirement>;
  bindings: ReadonlyArray<BoundRepositorySource>;
}> {
  return {
    directRequirements: directFixtures.map(parseDirectRequirement),
    bindings: bindingFixtures.map(parseBinding)
  };
}

function parseDirectRequirement(
  fixture: DirectRequirementFixture
): DirectInstallRequirement {
  if (fixture.kind === "package") {
    const coordinate = parsePackageCoordinate(fixture.coordinate);
    assert.equal(coordinate.ok, true, fixture.coordinate);
    if (!coordinate.ok) {
      throw new Error(`invalid package coordinate fixture: ${fixture.coordinate}`);
    }

    if (fixture.source === "git") {
      assert.equal(typeof fixture.ref, "string", fixture.coordinate);
      return {
        kind: "package",
        coordinate: coordinate.value,
        sourceKind: "git",
        requestedRef: fixture.ref ?? ""
      };
    }

    return {
      kind: "package",
      coordinate: coordinate.value,
      sourceKind: "github-release",
      ...(fixture.version === undefined
        ? {}
        : { versionRequirement: fixture.version })
    };
  }

  const coordinate = parseRepositoryCoordinate(fixture.coordinate);
  assert.equal(coordinate.ok, true, fixture.coordinate);
  if (!coordinate.ok) {
    throw new Error(`invalid repository coordinate fixture: ${fixture.coordinate}`);
  }

  if (fixture.source === "git") {
    assert.equal(typeof fixture.ref, "string", fixture.coordinate);
    return {
      kind: "repository",
      coordinate: coordinate.value,
      sourceKind: "git",
      requestedRef: fixture.ref ?? ""
    };
  }

  return {
    kind: "repository",
    coordinate: coordinate.value,
    sourceKind: "github-release",
    ...(fixture.version === undefined
      ? {}
      : { versionRequirement: fixture.version })
  };
}

function parseBinding(fixture: BindingFixture): BoundRepositorySource {
  const repository = parseRepositoryCoordinate(fixture.repository);
  assert.equal(repository.ok, true, fixture.repository);
  if (!repository.ok) {
    throw new Error(`invalid repository coordinate fixture: ${fixture.repository}`);
  }

  const snapshot = {
    packages: fixture.packages.map(parsePackageFact)
  };

  if (fixture.source === "git") {
    return {
      repository: repository.value,
      sourceKind: "git",
      requestedRef: fixture.ref,
      exactCommit: fixture.exactCommit,
      snapshot
    };
  }

  const version = parseReleaseVersion(fixture.version);
  assert.equal(version.ok, true, fixture.version);
  if (!version.ok) {
    throw new Error(`invalid Release version fixture: ${fixture.version}`);
  }

  return {
    repository: repository.value,
    sourceKind: "github-release",
    version: version.value,
    actualTag: fixture.actualTag,
    exactCommit: fixture.exactCommit,
    immutable: fixture.immutable,
    snapshot
  };
}

function parsePackageFact(fixture: PackageFixture): ResolverPackageFact {
  const coordinate = parsePackageCoordinate(fixture.coordinate);
  assert.equal(coordinate.ok, true, fixture.coordinate);
  if (!coordinate.ok) {
    throw new Error(`invalid package coordinate fixture: ${fixture.coordinate}`);
  }

  return {
    coordinate: coordinate.value,
    packageRoot: fixture.packageRoot,
    contentDigest: fixture.contentDigest,
    dependencies: fixture.dependencies.map((dependency) => {
      const target = parsePackageCoordinate(dependency.target);
      assert.equal(target.ok, true, dependency.target);
      if (!target.ok) {
        throw new Error(`invalid dependency coordinate fixture: ${dependency.target}`);
      }
      return {
        target: target.value,
        requirement: dependency.requirement
      };
    })
  };
}

function reverseBindings(
  fixtures: ReadonlyArray<BindingFixture>
): ReadonlyArray<BindingFixture> {
  return [...fixtures].reverse().map((binding) => ({
    ...binding,
    packages: [...binding.packages].reverse().map((packageFact) => ({
      ...packageFact,
      dependencies: [...packageFact.dependencies].reverse()
    }))
  }));
}

async function readFixture(): Promise<Fixture> {
  const raw = await readFile(
    resolve("behavior-fixtures", "resolver", "propagation.json"),
    "utf8"
  );
  return JSON.parse(raw) as Fixture;
}
