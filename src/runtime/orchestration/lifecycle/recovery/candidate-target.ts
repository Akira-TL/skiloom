import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../../../domain/errors/index.js";
import type {
  TargetRecoveryIntent
} from "../../../../domain/target/recovery.js";
import {
  preflightTargetOwnership,
  type TargetOwnedProjection,
  type TargetOwnershipPreflight,
  type TargetPathObservation
} from "../../../../domain/target/preflight.js";
import type {
  TargetPlan
} from "../../../../domain/target/index.js";
import type {
  SkiloomHomePaths
} from "../../../home.js";
import type {
  RegistryDetachedBaseline,
  RegistryTargetStateInput
} from "../../../registry/index.js";
import {
  packageStorePayloadPath
} from "../../../store.js";
import {
  buildManagedProjectionTree,
  managedProjectionMaterializationCandidates,
  verifyProjectionAtPath
} from "../../../target-projection/index.js";
import type {
  LifecycleCandidatePlan
} from "../../lifecycle-candidate.js";
import {
  projectionMaterialization,
  projectionTransformJson,
  registryDirectRequirement,
  registryResolvedSource,
  repositoryFromPackageCoordinate,
  type CandidatePackageSnapshot
} from "../apply.js";
import type {
  LifecycleCandidateProjection
} from "../projection/plan.js";

export type PreparedRecoveryTarget = Readonly<{
  desiredPlan: TargetPlan;
  projections: ReadonlyArray<LifecycleCandidateProjection>;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  preflight: TargetOwnershipPreflight;
  nextState: RegistryTargetStateInput;
}>;

export async function prepareRecoveryTarget(input: Readonly<{
  home: SkiloomHomePaths;
  targetRoot: string;
  targetId: string;
  markerIntent: TargetRecoveryIntent;
  candidatePlan: LifecycleCandidatePlan;
  desiredPlan: TargetPlan;
  snapshots: ReadonlyArray<CandidatePackageSnapshot>;
}>): Promise<Result<PreparedRecoveryTarget, ProductError>> {
  const snapshotByPackage = new Map(
    input.snapshots.map((entry) => [
      entry.packageCoordinate,
      entry.snapshot
    ])
  );
  const candidatePackages = new Set(
    input.candidatePlan.candidate.packages.map(
      (entry) => entry.packageCoordinate
    )
  );
  const detached = new Map(
    input.markerIntent.detached
      .filter((entry) =>
        candidatePackages.has(entry.packageCoordinate)
      )
      .map((entry) => [
        entry.packageCoordinate,
        entry
      ])
  );

  const currentProjections: TargetOwnedProjection[] = [];
  const observations: TargetPathObservation[] = [];
  const managedMaterializations = new Map<
    string,
    TargetOwnedProjection["materialization"]
  >();

  for (const projection of input.desiredPlan.projections) {
    const activationPath = join(
      input.targetRoot,
      projection.activationName
    );

    if (detached.has(projection.packageCoordinate)) {
      currentProjections.push({
        projection,
        ownership: "detached",
        materialization: "copy"
      });
      if (await pathExists(activationPath)) {
        observations.push({
          activationName: projection.activationName,
          kind: "existing"
        });
      }
      continue;
    }

    if (!(await pathExists(activationPath))) {
      continue;
    }
    const snapshot = snapshotByPackage.get(
      projection.packageCoordinate
    );
    if (snapshot === undefined) {
      return {
        ok: false,
        error: productError(
          "LifecycleCandidateSnapshotMismatch",
          {
            packageCoordinate:
              projection.packageCoordinate,
            reason: "missing-source-package"
          }
        )
      };
    }
    const tree = buildManagedProjectionTree(
      snapshot,
      projection
    );
    if (!tree.ok) {
      return tree;
    }
    const payloadPath = packageStorePayloadPath(
      input.home,
      projection.contentDigest
    );
    if (!payloadPath.ok) {
      return payloadPath;
    }

    let matched:
      | TargetOwnedProjection["materialization"]
      | undefined;
    for (
      const materialization of
        managedProjectionMaterializationCandidates(
          process.platform,
          projection.transform !== null
        )
    ) {
      const verified = await verifyProjectionAtPath({
        activationPath,
        activationName: projection.activationName,
        expectedMaterialization: materialization,
        expectedLinkTarget: payloadPath.value,
        tree: tree.value
      });
      if (verified.ok) {
        matched = materialization;
        break;
      }
    }

    if (matched === undefined) {
      observations.push({
        activationName: projection.activationName,
        kind: "existing"
      });
      continue;
    }

    managedMaterializations.set(
      projection.packageCoordinate,
      matched
    );
    currentProjections.push({
      projection,
      ownership: "managed",
      materialization: matched
    });
    observations.push({
      activationName: projection.activationName,
      kind: "managed",
      packageCoordinate: projection.packageCoordinate,
      contentDigest: projection.contentDigest,
      materialization: matched,
      expectedViewMatches: true
    });
  }

  const preflight = preflightTargetOwnership({
    desiredPlan: input.desiredPlan,
    currentProjections,
    observedPaths: observations
  });
  if (!preflight.ok) {
    return preflight;
  }

  const projections: LifecycleCandidateProjection[] =
    input.desiredPlan.projections.map((projection) => ({
      packageCoordinate: projection.packageCoordinate,
      activationName: projection.activationName,
      ownership: detached.has(
        projection.packageCoordinate
      )
        ? "detached"
        : "managed"
    }));

  return {
    ok: true,
    value: {
      desiredPlan: input.desiredPlan,
      projections,
      currentProjections,
      preflight: preflight.value,
      nextState: buildRecoveryRegistryState({
        targetId: input.targetId,
        targetRoot: input.targetRoot,
        candidatePlan: input.candidatePlan,
        desiredPlan: input.desiredPlan,
        detached,
        managedMaterializations
      })
    }
  };
}

function buildRecoveryRegistryState(input: Readonly<{
  targetId: string;
  targetRoot: string;
  candidatePlan: LifecycleCandidatePlan;
  desiredPlan: TargetPlan;
  detached: ReadonlyMap<
    string,
    TargetRecoveryIntent["detached"][number]
  >;
  managedMaterializations: ReadonlyMap<
    string,
    TargetOwnedProjection["materialization"]
  >;
}>): RegistryTargetStateInput {
  return {
    targetId: input.targetId,
    locations: [
      {
        path: input.targetRoot,
        observedGeneration: null
      }
    ],
    directRequirements:
      input.candidatePlan.directRequirements.map(
        registryDirectRequirement
      ),
    resolvedSources:
      input.candidatePlan.candidate.sourceBindings.map(
        registryResolvedSource
      ),
    resolvedPackages:
      input.candidatePlan.candidate.packages.map(
        (entry) => ({
          packageCoordinate: entry.packageCoordinate,
          repositoryCoordinate:
            repositoryFromPackageCoordinate(
              entry.packageCoordinate
            ),
          packageRoot: entry.packageRoot,
          contentDigest: entry.contentDigest
        })
      ),
    dependencyEdges:
      input.candidatePlan.candidate.dependencyEdges.map(
        (edge) => ({
          fromPackage: edge.sourcePackageCoordinate,
          toPackage: edge.targetPackageCoordinate
        })
      ),
    projections: input.desiredPlan.projections.map(
      (projection) => ({
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName,
        ownership: input.detached.has(
          projection.packageCoordinate
        )
          ? "detached" as const
          : "managed" as const,
        materialization: input.detached.has(
          projection.packageCoordinate
        )
          ? "copy" as const
          : input.managedMaterializations.get(
              projection.packageCoordinate
            ) ??
            projectionMaterialization(projection),
        transformJson:
          projectionTransformJson(projection)
      })
    ),
    detachedBaselines: [
      ...input.detached.values()
    ].map(registryDetachedBaseline),
    dependencyObservations: []
  };
}

function registryDetachedBaseline(
  baseline: TargetRecoveryIntent["detached"][number]
): RegistryDetachedBaseline {
  const repositoryCoordinate =
    repositoryFromPackageCoordinate(
      baseline.packageCoordinate
    );
  return baseline.sourceKind === "git"
    ? {
        packageCoordinate: baseline.packageCoordinate,
        repositoryCoordinate,
        sourceKind: "git",
        requestedRef: baseline.requestedRef,
        exactCommit: baseline.exactCommit,
        packageRoot: baseline.packageRoot,
        contentDigest: baseline.contentDigest
      }
    : {
        packageCoordinate: baseline.packageCoordinate,
        repositoryCoordinate,
        sourceKind: "github-release",
        version: baseline.version,
        actualTag: baseline.actualTag,
        exactCommit: baseline.exactCommit,
        packageRoot: baseline.packageRoot,
        contentDigest: baseline.contentDigest
      };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
