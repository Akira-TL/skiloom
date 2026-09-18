import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseTargetStateMarker,
  writeTargetStateMarker,
  type TargetStateMarkerParseError
} from "../../../../src/domain/target/state-marker.js";
import type {
  TargetRecoveryMarkerFacts
} from "../../../../src/domain/target/recovery.js";

type ValidCase = Readonly<{
  id: string;
  source: string;
  expected: TargetRecoveryMarkerFacts;
  canonical: string;
}>;

type InvalidCase = Readonly<{
  id: string;
  source: string;
  code: TargetStateMarkerParseError["code"];
  reason?: string;
  path?: string;
  format?: string;
}>;

type Fixture = Readonly<{
  fixtureVersion: 1;
  valid: ReadonlyArray<ValidCase>;
  invalid: ReadonlyArray<InvalidCase>;
}>;

test("SKILOOM-STATE-V1 behavior fixtures parse strictly and write canonically", async () => {
  const fixture = await readFixture();

  for (const example of fixture.valid) {
    const parsed = parseTargetStateMarker(example.source);
    assert.deepEqual(parsed, {
      ok: true,
      value: example.expected
    }, example.id);
    assert.equal(
      writeTargetStateMarker(example.expected),
      example.canonical,
      `${example.id}: canonical writer`
    );
    assert.deepEqual(
      parseTargetStateMarker(example.canonical),
      parsed,
      `${example.id}: canonical round trip`
    );
  }

  for (const example of fixture.invalid) {
    const result = parseTargetStateMarker(example.source);
    assert.equal(result.ok, false, example.id);
    if (result.ok) {
      continue;
    }
    assert.equal(result.error.code, example.code, example.id);
    if (result.error.code === "InvalidTargetState") {
      assert.equal(result.error.facts.reason, example.reason, example.id);
      assert.equal(result.error.facts.path, example.path, example.id);
    } else {
      assert.equal(result.error.facts.format, example.format, example.id);
    }
  }
});

async function readFixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      resolve(
        "behavior-fixtures",
        "target",
        "state-marker-v1.json"
      ),
      "utf8"
    )
  ) as Fixture;
}
