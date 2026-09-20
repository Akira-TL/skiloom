import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  matchesHostSoftwareRequirement,
  parseHostSoftwareRequirement
} from "../../../../src/domain/host-observation/index.js";

type Fixture = Readonly<{
  valid: ReadonlyArray<Readonly<{
    requirement: string;
    version: string;
    expected: boolean;
  }>>;
  invalidRequirements: ReadonlyArray<string>;
  invalidVersions: ReadonlyArray<string>;
}>;

test("Host Observation v0 numeric requirement fixtures", async () => {
  const fixture = JSON.parse(
    await readFile(
      resolve("behavior-fixtures/host-observation/cases.json"),
      "utf8"
    )
  ) as Fixture;

  for (const example of fixture.valid) {
    const parsed = parseHostSoftwareRequirement(example.requirement);
    assert.equal(parsed.ok, true, example.requirement);
    if (!parsed.ok) {
      continue;
    }
    const matched = matchesHostSoftwareRequirement(
      parsed.value,
      example.version
    );
    assert.equal(matched.ok, true, example.version);
    if (matched.ok) {
      assert.equal(
        matched.value,
        example.expected,
        example.requirement + " vs " + example.version
      );
    }
  }

  for (const source of fixture.invalidRequirements) {
    const parsed = parseHostSoftwareRequirement(source);
    assert.equal(parsed.ok, false, source);
    if (!parsed.ok) {
      assert.equal(
        parsed.error.code,
        "InvalidHostSoftwareRequirement"
      );
    }
  }

  const any = parseHostSoftwareRequirement("*");
  assert.equal(any.ok, true);
  if (!any.ok) {
    return;
  }
  for (const version of fixture.invalidVersions) {
    const matched = matchesHostSoftwareRequirement(any.value, version);
    assert.equal(matched.ok, false, version);
    if (!matched.ok) {
      assert.equal(
        matched.error.code,
        "InvalidHostSoftwareVersion"
      );
    }
  }
});
