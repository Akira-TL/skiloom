import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  parsePackageCoordinate,
  parseRepositoryCoordinate,
  type CoordinateErrorReason
} from "../../../src/domain/coordinate/index.js";

type RepositoryFixture = Readonly<{
  valid: ReadonlyArray<Readonly<{
    input: string;
    canonical: string;
    owner: string;
    repo: string;
  }>>;
  invalid: ReadonlyArray<Readonly<{
    input: string;
    reason: CoordinateErrorReason;
  }>>;
}>;

type PackageFixture = Readonly<{
  valid: ReadonlyArray<Readonly<{
    input: string;
    canonical: string;
    packageName: string;
  }>>;
  invalid: ReadonlyArray<Readonly<{
    input: string;
    reason: CoordinateErrorReason;
  }>>;
}>;

test("repository coordinate behavior fixtures", async () => {
  const fixture = await readFixture<RepositoryFixture>("repository.json");

  for (const example of fixture.valid) {
    const result = parseRepositoryCoordinate(example.input);
    assert.equal(result.ok, true, example.input);
    if (result.ok) {
      assert.deepEqual(result.value, {
        owner: example.owner,
        repo: example.repo,
        canonical: example.canonical
      });
    }
  }

  for (const example of fixture.invalid) {
    const result = parseRepositoryCoordinate(example.input);
    assert.equal(result.ok, false, example.input);
    if (!result.ok) {
      assert.deepEqual(result.error, {
        code: "InvalidRepositoryCoordinate",
        facts: {
          input: example.input,
          reason: example.reason
        }
      });
    }
  }
});

test("package coordinate behavior fixtures", async () => {
  const fixture = await readFixture<PackageFixture>("package.json");

  for (const example of fixture.valid) {
    const result = parsePackageCoordinate(example.input);
    assert.equal(result.ok, true, example.input);
    if (result.ok) {
      assert.equal(result.value.canonical, example.canonical);
      assert.equal(result.value.packageName, example.packageName);
      assert.equal(
        result.value.repository.canonical,
        example.canonical.split("/").slice(0, 2).join("/")
      );
    }
  }

  for (const example of fixture.invalid) {
    const result = parsePackageCoordinate(example.input);
    assert.equal(result.ok, false, example.input);
    if (!result.ok) {
      assert.deepEqual(result.error, {
        code: "InvalidPackageCoordinate",
        facts: {
          input: example.input,
          reason: example.reason
        }
      });
    }
  }
});

async function readFixture<T>(name: string): Promise<T> {
  const raw = await readFile(
    resolve("behavior-fixtures", "coordinate", name),
    "utf8"
  );
  return JSON.parse(raw) as T;
}
