import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  classifyTargetGeneration,
  preflightTargetOwnership,
  type TargetGenerationDecision,
  type TargetGenerationFacts,
  type TargetOwnedProjection,
  type TargetOwnershipPreflight,
  type TargetOwnershipPreflightError,
  type TargetPathObservation,
  type TargetPlan
} from "../../../../src/domain/target/index.js";

type OwnershipCaseBase = Readonly<{
  id: string;
  desiredPlan: TargetPlan;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  observedPaths: ReadonlyArray<TargetPathObservation>;
}>;

type OwnershipSuccessCase = OwnershipCaseBase & Readonly<{
  expected: TargetOwnershipPreflight;
}>;

type OwnershipErrorCase = OwnershipCaseBase & Readonly<{
  expectedError: TargetOwnershipPreflightError;
}>;

type GenerationCase = Readonly<{
  id: string;
  input: TargetGenerationFacts;
  expected: TargetGenerationDecision;
}>;

type Fixture = Readonly<{
  fixtureVersion: 1;
  ownershipSuccess: ReadonlyArray<OwnershipSuccessCase>;
  ownershipErrors: ReadonlyArray<OwnershipErrorCase>;
  generation: ReadonlyArray<GenerationCase>;
}>;

test("Target ownership preflight emits canonical safe actions without filesystem mutation", async () => {
  const fixture = await readFixture();

  for (const example of fixture.ownershipSuccess) {
    const input = ownershipInput(example);
    const result = preflightTargetOwnership(input);
    assert.equal(result.ok, true, example.id);
    if (result.ok) {
      assert.deepEqual(result.value, example.expected, example.id);
    }

    const reversed = preflightTargetOwnership(reverseOwnershipInput(input));
    assert.deepEqual(reversed, result, `${example.id}: reversed observed/current/desired facts`);
  }
});

test("Target ownership preflight fails closed for foreign or modified managed paths", async () => {
  const fixture = await readFixture();

  for (const example of fixture.ownershipErrors) {
    const input = ownershipInput(example);
    const result = preflightTargetOwnership(input);
    assert.equal(result.ok, false, example.id);
    if (!result.ok) {
      assert.deepEqual(result.error, example.expectedError, example.id);
    }

    const reversed = preflightTargetOwnership(reverseOwnershipInput(input));
    assert.deepEqual(reversed, result, `${example.id}: reversed observed/current/desired facts`);
  }
});

test("Target generation facts classify current stale ahead repairable and dormant copies", async () => {
  const fixture = await readFixture();

  for (const example of fixture.generation) {
    assert.deepEqual(classifyTargetGeneration(example.input), example.expected, example.id);
  }
});

function ownershipInput(example: OwnershipCaseBase): Readonly<{
  desiredPlan: TargetPlan;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  observedPaths: ReadonlyArray<TargetPathObservation>;
}> {
  return {
    desiredPlan: example.desiredPlan,
    currentProjections: example.currentProjections,
    observedPaths: example.observedPaths
  };
}

function reverseOwnershipInput(input: Readonly<{
  desiredPlan: TargetPlan;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  observedPaths: ReadonlyArray<TargetPathObservation>;
}>): Readonly<{
  desiredPlan: TargetPlan;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  observedPaths: ReadonlyArray<TargetPathObservation>;
}> {
  return {
    desiredPlan: {
      projections: [...input.desiredPlan.projections].reverse(),
      reachablePackages: [...input.desiredPlan.reachablePackages].reverse(),
      unreachableManagedPackages: [...input.desiredPlan.unreachableManagedPackages].reverse()
    },
    currentProjections: [...input.currentProjections].reverse(),
    observedPaths: [...input.observedPaths].reverse()
  };
}

async function readFixture(): Promise<Fixture> {
  const raw = await readFile(
    resolve("behavior-fixtures", "target", "preflight.json"),
    "utf8"
  );
  return JSON.parse(raw) as Fixture;
}
