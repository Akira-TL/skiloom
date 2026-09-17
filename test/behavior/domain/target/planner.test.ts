import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  planTargetProjections,
  type TargetPackageFact,
  type TargetPlan,
  type TargetPlanError,
  type TargetPlannerInput,
  type TargetProjectionRename
} from "../../../../src/domain/target/index.js";

type PlannerCaseBase = Readonly<{
  id: string;
  packages: ReadonlyArray<TargetPackageFact>;
  dependencyEdges: TargetPlannerInput["dependencyEdges"];
  directRoots: ReadonlyArray<string>;
  renames: ReadonlyArray<TargetProjectionRename>;
}>;

type SuccessCase = PlannerCaseBase & Readonly<{
  expected: TargetPlan;
}>;

type ErrorCase = PlannerCaseBase & Readonly<{
  expectedError: TargetPlanError;
}>;

type Fixture = Readonly<{
  fixtureVersion: 1;
  success: ReadonlyArray<SuccessCase>;
  errors: ReadonlyArray<ErrorCase>;
}>;

test("Target planner emits deterministic projections, transforms, and reachability", async () => {
  const fixture = await readFixture();

  for (const example of fixture.success) {
    const input = plannerInput(example);
    const result = planTargetProjections(input);
    assert.equal(result.ok, true, example.id);
    if (result.ok) {
      assert.deepEqual(result.value, example.expected, example.id);
    }

    const reversed = planTargetProjections(reverseInput(input));
    assert.deepEqual(reversed, result, `${example.id}: reversed input order`);
  }
});

test("Target planner rejects invalid or conflicting activation names with stable facts", async () => {
  const fixture = await readFixture();

  for (const example of fixture.errors) {
    const input = plannerInput(example);
    const result = planTargetProjections(input);
    assert.equal(result.ok, false, example.id);
    if (!result.ok) {
      assert.deepEqual(result.error, example.expectedError, example.id);
    }

    const reversed = planTargetProjections(reverseInput(input));
    assert.deepEqual(reversed, result, `${example.id}: reversed input order`);
  }
});

function plannerInput(example: PlannerCaseBase): TargetPlannerInput {
  return {
    packages: example.packages,
    dependencyEdges: example.dependencyEdges,
    directRoots: example.directRoots,
    renames: example.renames
  };
}

function reverseInput(input: TargetPlannerInput): TargetPlannerInput {
  return {
    packages: [...input.packages].reverse(),
    dependencyEdges: [...input.dependencyEdges].reverse(),
    directRoots: [...input.directRoots].reverse(),
    renames: [...input.renames].reverse()
  };
}

async function readFixture(): Promise<Fixture> {
  const raw = await readFile(
    resolve("behavior-fixtures", "target", "planner.json"),
    "utf8"
  );
  return JSON.parse(raw) as Fixture;
}
