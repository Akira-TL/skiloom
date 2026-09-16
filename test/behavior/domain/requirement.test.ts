import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  compareReleaseVersions,
  matchesReleaseRequirement,
  parseReleaseRequirement,
  parseReleaseVersion,
  type ReleaseRequirementErrorReason,
  type ReleaseVersionErrorReason
} from "../../../src/domain/requirement/index.js";

type Fixture = Readonly<{
  canonical: ReadonlyArray<Readonly<{
    input: string;
    expected: string;
  }>>;
  matches: ReadonlyArray<Readonly<{
    requirement: string;
    version: string;
    expected: boolean;
  }>>;
  precedence: ReadonlyArray<Readonly<{
    left: string;
    right: string;
    expected: -1 | 0 | 1;
  }>>;
  invalidRequirements: ReadonlyArray<Readonly<{
    input: string;
    reason: ReleaseRequirementErrorReason;
  }>>;
  invalidVersions: ReadonlyArray<Readonly<{
    input: string;
    reason: ReleaseVersionErrorReason;
  }>>;
}>;

async function readFixture(): Promise<Fixture> {
  const raw = await readFile(
    resolve("behavior-fixtures", "requirement", "cases.json"),
    "utf8"
  );
  return JSON.parse(raw) as Fixture;
}

test("Release Version Requirement canonicalization fixtures", async () => {
  const fixture = await readFixture();

  for (const example of fixture.canonical) {
    const result = parseReleaseRequirement(example.input);
    assert.equal(result.ok, true, example.input);
    if (result.ok) {
      assert.equal(result.value.canonical, example.expected, example.input);
    }
  }

  for (const example of fixture.invalidRequirements) {
    const result = parseReleaseRequirement(example.input);
    assert.equal(result.ok, false, example.input);
    if (!result.ok) {
      assert.deepEqual(result.error, {
        code: "InvalidReleaseRequirement",
        facts: {
          input: example.input,
          reason: example.reason
        }
      });
    }
  }
});

test("Release Version Requirement matching fixtures", async () => {
  const fixture = await readFixture();

  for (const example of fixture.matches) {
    const requirement = parseReleaseRequirement(example.requirement);
    assert.equal(requirement.ok, true, example.requirement);
    const version = parseReleaseVersion(example.version);
    assert.equal(version.ok, true, example.version);

    if (requirement.ok && version.ok) {
      assert.equal(
        matchesReleaseRequirement(requirement.value, version.value),
        example.expected,
        `${example.requirement} <> ${example.version}`
      );
    }
  }
});

test("SemVer precedence fixtures", async () => {
  const fixture = await readFixture();

  for (const example of fixture.precedence) {
    const left = parseReleaseVersion(example.left);
    const right = parseReleaseVersion(example.right);
    assert.equal(left.ok, true, example.left);
    assert.equal(right.ok, true, example.right);

    if (left.ok && right.ok) {
      assert.equal(
        compareReleaseVersions(left.value, right.value),
        example.expected,
        `${example.left} <> ${example.right}`
      );
    }
  }

  for (const example of fixture.invalidVersions) {
    const result = parseReleaseVersion(example.input);
    assert.equal(result.ok, false, example.input);
    if (!result.ok) {
      assert.deepEqual(result.error, {
        code: "InvalidReleaseVersion",
        facts: {
          input: example.input,
          reason: example.reason
        }
      });
    }
  }
});
