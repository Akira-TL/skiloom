import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  acceptedTargetPlan
} from "../../../../src/runtime/orchestration/lifecycle/recovery/target.js";
import type {
  RegistryTargetState
} from "../../../../src/runtime/registry/index.js";

type Fixture = Readonly<{
  state: Omit<RegistryTargetState, "generation">;
}>;

test("accepted Target plan preserves intentional projection absence while keeping graph reachability", async () => {
  const fixture = await readFixture();
  const state: RegistryTargetState = {
    ...fixture.state,
    generation: 3,
    projections: [],
    detachedBaselines: []
  };

  const plan = acceptedTargetPlan(state);

  assert.equal(plan.ok, true);
  if (!plan.ok) {
    return;
  }
  assert.deepEqual(plan.value.projections, []);
  assert.deepEqual(
    plan.value.reachablePackages,
    state.resolvedPackages
      .map((entry) => entry.packageCoordinate)
      .sort()
  );
});

test("accepted Target plan still rejects mismatched accepted projection facts", async () => {
  const fixture = await readFixture();
  const original = fixture.state.projections[0]!;
  const state: RegistryTargetState = {
    ...fixture.state,
    generation: 2,
    projections: [
      {
        ...original,
        activationName: original.activationName + "-wrong"
      },
      ...fixture.state.projections.slice(1)
    ]
  };

  const plan = acceptedTargetPlan(state);

  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.equal(
      plan.error.code,
      "InterruptedLifecycleRecoveryConflict"
    );
    assert.equal(
      plan.error.facts.reason,
      "accepted-projection-mismatch"
    );
  }
});

async function readFixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      "behavior-fixtures/registry/current-state.json",
      "utf8"
    )
  ) as Fixture;
}
