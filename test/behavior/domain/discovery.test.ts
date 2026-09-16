import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  discoverRepositorySkills,
  type DiscoveredSkillPackage,
  type RepositoryFileFact
} from "../../../src/domain/discovery/index.js";

type StructuredError = Readonly<{
  code: string;
  facts: Readonly<Record<string, unknown>>;
}>;

type DiscoveryCase = Readonly<{
  name: string;
  repositoryRootBasename: string;
  repositoryMetadata: string | null;
  files: ReadonlyArray<RepositoryFileFact>;
}>;

type Fixture = Readonly<{
  valid: ReadonlyArray<
    DiscoveryCase &
      Readonly<{
        expected: ReadonlyArray<DiscoveredSkillPackage>;
      }>
  >;
  invalid: ReadonlyArray<
    DiscoveryCase &
      Readonly<{
        error: StructuredError;
      }>
  >;
}>;

test("repository Skill discovery behavior fixtures", async () => {
  const raw = await readFile(
    resolve("behavior-fixtures", "discovery", "cases.json"),
    "utf8"
  );
  const fixture = JSON.parse(raw) as Fixture;

  for (const example of fixture.valid) {
    const input = {
      repositoryRootBasename: example.repositoryRootBasename,
      repositoryMetadata: example.repositoryMetadata ?? undefined,
      files: example.files
    };
    const result = discoverRepositorySkills(input);
    assert.equal(result.ok, true, example.name);
    if (result.ok) {
      assert.deepEqual(result.value, example.expected, example.name);
    }

    const reversedResult = discoverRepositorySkills({
      ...input,
      files: [...example.files].reverse()
    });
    assert.deepEqual(reversedResult, result, `${example.name}: input order`);
  }

  for (const example of fixture.invalid) {
    const result = discoverRepositorySkills({
      repositoryRootBasename: example.repositoryRootBasename,
      repositoryMetadata: example.repositoryMetadata ?? undefined,
      files: example.files
    });
    assert.equal(result.ok, false, example.name);
    if (!result.ok) {
      assert.deepEqual(result.error, example.error, example.name);
    }
  }
});
