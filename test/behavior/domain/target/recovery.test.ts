import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  decideTargetRecovery,
  type TargetRecoveryDecisionInput,
  type TargetRecoveryDecisionResult
} from "../../../../src/domain/target/recovery.js";

type FixtureCase = Readonly<{
  id: string;
  input: TargetRecoveryDecisionInput;
  expected: TargetRecoveryDecisionResult;
}>;

type Fixture = Readonly<{
  fixtureVersion: 1;
  cases: ReadonlyArray<FixtureCase>;
}>;

test("Target recovery decisions are deterministic over parsed facts", async () => {
  const fixture = await readFixture();

  for (const example of fixture.cases) {
    const result = decideTargetRecovery(example.input);
    assert.deepEqual(result, example.expected, example.id);

    const reversed = decideTargetRecovery(
      reverseMarkerCollections(example.input)
    );
    assert.deepEqual(
      reversed,
      result,
      `${example.id}: reversed marker collections`
    );
  }
});

function reverseMarkerCollections(
  input: TargetRecoveryDecisionInput
): TargetRecoveryDecisionInput {
  if (input.marker === null) {
    return input;
  }
  return {
    ...input,
    marker: {
      ...input.marker,
      requirements: [...input.marker.requirements].reverse(),
      projectionOverrides: [
        ...input.marker.projectionOverrides
      ].reverse(),
      detached: [...input.marker.detached].reverse()
    }
  };
}

async function readFixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      resolve("behavior-fixtures", "target", "recovery.json"),
      "utf8"
    )
  ) as Fixture;
}
