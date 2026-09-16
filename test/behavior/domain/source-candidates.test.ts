import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parseRepositoryCoordinate } from "../../../src/domain/coordinate/index.js";
import {
  parseReleaseRequirement,
  type ReleaseRequirement
} from "../../../src/domain/requirement/index.js";
import {
  buildReleaseCandidateGroups,
  type FixedReleaseFact
} from "../../../src/domain/resolver/index.js";

type SnapshotFixture = Readonly<{ id: string }>;

type ReleaseFixture = Readonly<{
  actualTag: string;
  draft: boolean;
  exactCommit: string;
  immutable: boolean;
  snapshot: SnapshotFixture;
}>;

type CandidateExpectation = Readonly<{
  precedence: string;
  candidates: ReadonlyArray<Readonly<{
    version: string;
    actualTag: string;
    exactCommit: string;
    immutable: boolean;
    snapshotId: string;
  }>>;
}>;

type SuccessFixture = Readonly<{
  name: string;
  repository: string;
  requirements: ReadonlyArray<string>;
  releases: ReadonlyArray<ReleaseFixture>;
  expected: ReadonlyArray<CandidateExpectation>;
}>;

type ErrorFixture = Readonly<{
  name: string;
  repository: string;
  requirements: ReadonlyArray<string>;
  releases: ReadonlyArray<ReleaseFixture>;
  expectedError: Readonly<{
    code: "AmbiguousReleaseVersion";
    facts: Readonly<{
      repositoryCoordinate: string;
      normalizedVersion: string;
      actualTags: ReadonlyArray<string>;
    }>;
  }>;
}>;

type Fixture = Readonly<{
  cases: ReadonlyArray<SuccessFixture>;
  errors: ReadonlyArray<ErrorFixture>;
}>;

test("fixed Release source facts normalize into deterministic candidate groups", async () => {
  const fixture = await readFixture();

  for (const example of fixture.cases) {
    const repository = parseRepositoryCoordinate(example.repository);
    assert.equal(repository.ok, true, `${example.name}: repository`);
    if (!repository.ok) {
      continue;
    }

    const requirements = parseRequirements(example.requirements, example.name);
    const releases = example.releases satisfies ReadonlyArray<FixedReleaseFact<SnapshotFixture>>;

    const result = buildReleaseCandidateGroups({
      repository: repository.value,
      requirements,
      releases
    });
    assert.equal(result.ok, true, example.name);
    if (result.ok) {
      assert.deepEqual(projectGroups(result.value), example.expected, example.name);
      for (const group of result.value) {
        assert.equal(
          group.repositoryCoordinate,
          repository.value.canonical,
          `${example.name}: group repository coordinate`
        );
        for (const candidate of group.candidates) {
          assert.equal(
            candidate.repositoryCoordinate,
            repository.value.canonical,
            `${example.name}: candidate repository coordinate`
          );
        }
      }
    }

    const reversed = buildReleaseCandidateGroups({
      repository: repository.value,
      requirements: [...requirements].reverse(),
      releases: [...releases].reverse()
    });
    assert.deepEqual(reversed, result, `${example.name}: reversed input order`);
  }
});

test("duplicate normalized Release versions fail with stable facts", async () => {
  const fixture = await readFixture();

  for (const example of fixture.errors) {
    const repository = parseRepositoryCoordinate(example.repository);
    assert.equal(repository.ok, true, `${example.name}: repository`);
    if (!repository.ok) {
      continue;
    }

    const requirements = parseRequirements(example.requirements, example.name);
    const releases = example.releases satisfies ReadonlyArray<FixedReleaseFact<SnapshotFixture>>;

    const result = buildReleaseCandidateGroups({
      repository: repository.value,
      requirements,
      releases
    });
    assert.equal(result.ok, false, example.name);
    if (!result.ok) {
      assert.deepEqual(result.error, example.expectedError, example.name);
    }

    const reversed = buildReleaseCandidateGroups({
      repository: repository.value,
      requirements: [...requirements].reverse(),
      releases: [...releases].reverse()
    });
    assert.deepEqual(reversed, result, `${example.name}: reversed input order`);
  }
});

function parseRequirements(
  inputs: ReadonlyArray<string>,
  caseName: string
): ReadonlyArray<ReleaseRequirement> {
  return inputs.map((input) => {
    const parsed = parseReleaseRequirement(input);
    assert.equal(parsed.ok, true, `${caseName}: ${input}`);
    if (!parsed.ok) {
      throw new Error(`invalid fixture requirement: ${input}`);
    }
    return parsed.value;
  });
}

function projectGroups<Snapshot extends SnapshotFixture>(
  groups: ReadonlyArray<Readonly<{
    precedence: string;
    candidates: ReadonlyArray<Readonly<{
      version: Readonly<{ canonical: string }>;
      actualTag: string;
      exactCommit: string;
      immutable: boolean;
      snapshot: Snapshot;
    }>>;
  }>>
): ReadonlyArray<CandidateExpectation> {
  return groups.map((group) => ({
    precedence: group.precedence,
    candidates: group.candidates.map((candidate) => ({
      version: candidate.version.canonical,
      actualTag: candidate.actualTag,
      exactCommit: candidate.exactCommit,
      immutable: candidate.immutable,
      snapshotId: candidate.snapshot.id
    }))
  }));
}

async function readFixture(): Promise<Fixture> {
  const raw = await readFile(
    resolve("behavior-fixtures", "resolver", "source-candidates.json"),
    "utf8"
  );
  return JSON.parse(raw) as Fixture;
}
