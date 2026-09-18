import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  decideNonInteractiveLifecycleAcceptance,
  type LifecycleAcceptanceDecision,
  type LifecycleAcceptanceMode
} from "../../../../src/domain/lifecycle/index.js";
import type {
  CandidateComparison
} from "../../../../src/domain/resolver/index.js";

type AcceptanceFixture = Readonly<{
  id: string;
  noChange: boolean;
  mode: LifecycleAcceptanceMode;
  ordinaryApproval: boolean;
  releaseRetargetApproval: boolean;
  releaseRetargetRepositories: ReadonlyArray<string>;
  expected: LifecycleAcceptanceDecision;
}>;

type Fixture = Readonly<{
  fixtureVersion: 1;
  cases: ReadonlyArray<AcceptanceFixture>;
}>;

test("non-interactive lifecycle acceptance behavior fixtures", async () => {
  const fixture = await readFixture();

  for (const example of fixture.cases) {
    const result = decideNonInteractiveLifecycleAcceptance({
      noChange: example.noChange,
      comparison: comparison(example.releaseRetargetRepositories),
      authorization: {
        mode: example.mode,
        ordinaryApproval: example.ordinaryApproval,
        releaseRetargetApproval:
          example.releaseRetargetApproval
      }
    });
    assert.deepEqual(result, example.expected, example.id);

    const reversed = decideNonInteractiveLifecycleAcceptance({
      noChange: example.noChange,
      comparison: comparison(
        [...example.releaseRetargetRepositories].reverse()
      ),
      authorization: {
        mode: example.mode,
        ordinaryApproval: example.ordinaryApproval,
        releaseRetargetApproval:
          example.releaseRetargetApproval
      }
    });
    assert.deepEqual(
      reversed,
      result,
      `${example.id}: source delta order`
    );
  }
});

function comparison(
  retargetRepositories: ReadonlyArray<string>
): CandidateComparison {
  return {
    previousRepositories: [],
    candidateRepositories: [],
    sourceDeltas: retargetRepositories.map(
      (repositoryCoordinate, index) => ({
        kind: "release-retarget" as const,
        repositoryCoordinate,
        actualTag: "v1.0.0",
        previousCommit: `old-${index}`,
        candidateCommit: `new-${index}`,
        risk: "high" as const
      })
    ),
    repositoryOrigins: [],
    packageDeltas: [],
    dependencyEdgeDeltas: []
  };
}

async function readFixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      resolve(
        "behavior-fixtures/lifecycle/acceptance.json"
      ),
      "utf8"
    )
  ) as Fixture;
}
