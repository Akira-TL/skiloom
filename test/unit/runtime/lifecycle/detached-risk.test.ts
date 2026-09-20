import assert from "node:assert/strict";
import test from "node:test";

import {
  compareCandidateGraphs,
  type ResolverCandidateGraph
} from "../../../../src/domain/resolver/index.js";
import type {
  LifecycleCandidatePlan
} from "../../../../src/runtime/orchestration/lifecycle-candidate.js";
import type {
  LifecycleCandidateProjection
} from "../../../../src/runtime/orchestration/lifecycle/projection/plan.js";
import {
  detachedContentChangeRisks
} from "../../../../src/runtime/orchestration/lifecycle/projection/risk.js";
import type {
  RegistryTargetState
} from "../../../../src/runtime/registry/index.js";

const DIGEST = "sha256:" + "a".repeat(64);

test("detached risk detects source-only change even when Package digest is identical", () => {
  const previous = graph("a".repeat(40));
  const candidate = graph("b".repeat(40));
  const current = state(previous);
  const plan: LifecycleCandidatePlan = {
    directRequirements: [],
    candidate,
    comparison: compareCandidateGraphs({
      previous,
      candidate,
      directRequirements: []
    }),
    noChange: false
  };
  const projections: ReadonlyArray<LifecycleCandidateProjection> = [
    {
      packageCoordinate: "acme/app/app",
      activationName: "app",
      ownership: "detached"
    }
  ];

  const risks = detachedContentChangeRisks(
    current,
    plan,
    projections
  );

  assert.equal(risks.length, 1);
  const risk = risks[0]!;
  assert.equal(risk.previousPackage.contentDigest, DIGEST);
  assert.equal(risk.candidatePackage.contentDigest, DIGEST);
  assert.equal(
    risk.previousSource?.sourceKind === "github-release"
      ? risk.previousSource.exactCommit
      : undefined,
    "a".repeat(40)
  );
  assert.equal(
    risk.candidateSource?.sourceKind === "github-release"
      ? risk.candidateSource.exactCommit
      : undefined,
    "b".repeat(40)
  );
});

test("detached risk stays empty when Package and source are unchanged", () => {
  const candidate = graph("a".repeat(40));
  const current = state(candidate);
  const plan: LifecycleCandidatePlan = {
    directRequirements: [],
    candidate,
    comparison: compareCandidateGraphs({
      previous: candidate,
      candidate,
      directRequirements: []
    }),
    noChange: true
  };

  assert.deepEqual(
    detachedContentChangeRisks(
      current,
      plan,
      [
        {
          packageCoordinate: "acme/app/app",
          activationName: "app",
          ownership: "detached"
        }
      ]
    ),
    []
  );
});

function graph(exactCommit: string): ResolverCandidateGraph {
  return {
    sourceBindings: [
      {
        repositoryCoordinate: "acme/app",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit,
        immutable: true
      }
    ],
    packages: [
      {
        packageCoordinate: "acme/app/app",
        packageRoot: ".",
        contentDigest: DIGEST
      }
    ],
    dependencyEdges: []
  };
}

function state(graphValue: ResolverCandidateGraph): RegistryTargetState {
  const source = graphValue.sourceBindings[0]!;
  return {
    targetId: "target-detached-risk",
    generation: 1,
    locations: [
      {
        path: "/tmp/target",
        observedGeneration: 1
      }
    ],
    directRequirements: [],
    resolvedSources: [source],
    resolvedPackages: [
      {
        packageCoordinate: "acme/app/app",
        repositoryCoordinate: "acme/app",
        packageRoot: ".",
        contentDigest: DIGEST
      }
    ],
    dependencyEdges: [],
    projections: [
      {
        packageCoordinate: "acme/app/app",
        activationName: "app",
        ownership: "detached",
        materialization: "copy",
        transformJson: null
      }
    ],
    detachedBaselines: [],
    dependencyObservations: []
  };
}
