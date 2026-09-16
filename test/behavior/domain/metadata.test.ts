import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parsePackageMetadata } from "../../../src/domain/package/index.js";
import { parseRepositoryMetadata } from "../../../src/domain/discovery/index.js";

type StructuredError = Readonly<{
  code: string;
  facts: Readonly<Record<string, unknown>>;
}>;

type Fixture<T> = Readonly<{
  valid: ReadonlyArray<Readonly<{
    source: string | null;
    expected: T;
  }>>;
  invalid: ReadonlyArray<Readonly<{
    source: string;
    error: StructuredError;
  }>>;
}>;

async function readFixture<T>(name: string): Promise<Fixture<T>> {
  const raw = await readFile(
    resolve("behavior-fixtures", name, "cases.json"),
    "utf8"
  );
  return JSON.parse(raw) as Fixture<T>;
}

test("skiloom-package.toml strict schema behavior fixtures", async () => {
  const fixture = await readFixture<Readonly<{
    dependencies: Readonly<Record<string, string>>;
    software: Readonly<Record<string, string>>;
  }>>("package-metadata");

  for (const example of fixture.valid) {
    const result = parsePackageMetadata(example.source ?? undefined);
    assert.equal(result.ok, true, example.source ?? "absent");
    if (result.ok) {
      assert.deepEqual(result.value, example.expected);
    }
  }

  for (const example of fixture.invalid) {
    const result = parsePackageMetadata(example.source);
    assert.equal(result.ok, false, example.source);
    if (!result.ok) {
      assert.deepEqual(result.error, example.error);
    }
  }
});

test("skiloom-repo.toml strict schema behavior fixtures", async () => {
  const fixture = await readFixture<Readonly<{
    include: ReadonlyArray<string>;
    exclude: ReadonlyArray<string>;
  }>>("repository-metadata");

  for (const example of fixture.valid) {
    const result = parseRepositoryMetadata(example.source ?? undefined);
    assert.equal(result.ok, true, example.source ?? "absent");
    if (result.ok) {
      assert.deepEqual(result.value, example.expected);
    }
  }

  for (const example of fixture.invalid) {
    const result = parseRepositoryMetadata(example.source);
    assert.equal(result.ok, false, example.source);
    if (!result.ok) {
      assert.deepEqual(result.error, example.error);
    }
  }
});
