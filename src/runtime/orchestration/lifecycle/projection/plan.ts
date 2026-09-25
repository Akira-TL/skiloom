import {
  parsePackageCoordinate
} from "../../../../domain/coordinate/index.js";
import type {
  ResolverCandidateGraph
} from "../../../../domain/resolver/index.js";
import type {
  TargetPlan,
  TargetProjectionRename
} from "../../../../domain/target/index.js";
import type {
  RegistryProjection,
  RegistryTargetState
} from "../../../registry/index.js";
import type {
  LifecycleCandidatePlan
} from "../../lifecycle-candidate.js";

export type LifecycleCandidateProjection = Readonly<{
  packageCoordinate: string;
  activationName: string;
  ownership: "managed" | "detached";
}>;

export function requestedRenames(
  state: RegistryTargetState,
  candidate: ResolverCandidateGraph,
  requested: TargetProjectionRename | undefined
): ReadonlyArray<TargetProjectionRename> {
  const preserved = preservedRenames(state, candidate);
  if (requested === undefined) {
    return preserved;
  }
  return [
    ...preserved.filter(
      (rename) =>
        rename.packageCoordinate !== requested.packageCoordinate
    ),
    requested
  ];
}

export function applyRequestedRenameChange(
  plan: LifecycleCandidatePlan,
  state: RegistryTargetState,
  requested: TargetProjectionRename | undefined
): LifecycleCandidatePlan {
  if (requested === undefined || !plan.noChange) {
    return plan;
  }
  const current = state.projections.find(
    (projection) =>
      projection.packageCoordinate === requested.packageCoordinate
  );
  return current?.activationName === requested.activationName
    ? plan
    : { ...plan, noChange: false };
}

export function projectionRenames(
  projections: ReadonlyArray<RegistryProjection>
): ReadonlyArray<TargetProjectionRename> {
  return projections.flatMap((projection) => {
    const coordinate = parsePackageCoordinate(
      projection.packageCoordinate
    );
    if (
      !coordinate.ok ||
      coordinate.value.packageName === projection.activationName
    ) {
      return [];
    }
    return [
      {
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName
      }
    ];
  });
}

export function freshLifecycleCandidateProjections(
  targetPlan: TargetPlan
): ReadonlyArray<LifecycleCandidateProjection> {
  return targetPlan.projections.map((projection) => ({
    packageCoordinate: projection.packageCoordinate,
    activationName: projection.activationName,
    ownership: "managed" as const
  }));
}

export function lifecycleCandidateProjections(
  current: RegistryTargetState,
  targetPlan: TargetPlan
): ReadonlyArray<LifecycleCandidateProjection> {
  const currentOwnership = new Map(
    current.projections.map((projection) => [
      projection.packageCoordinate,
      projection.ownership
    ])
  );
  return targetPlan.projections.map((projection) => ({
    packageCoordinate: projection.packageCoordinate,
    activationName: projection.activationName,
    ownership:
      currentOwnership.get(projection.packageCoordinate) === "detached"
        ? "detached"
        : "managed"
  }));
}

export function preserveAcceptedProjectionAbsence(
  state: RegistryTargetState,
  plan: TargetPlan
): TargetPlan {
  const acceptedPackages = new Set(
    state.resolvedPackages.map(
      (entry) => entry.packageCoordinate
    )
  );
  const projectedPackages = new Set(
    state.projections.map(
      (projection) => projection.packageCoordinate
    )
  );
  const forgottenPackages = new Set(
    [...acceptedPackages].filter(
      (packageCoordinate) =>
        !projectedPackages.has(packageCoordinate)
    )
  );

  return {
    ...plan,
    projections: plan.projections.filter(
      (projection) =>
        !forgottenPackages.has(
          projection.packageCoordinate
        )
    )
  };
}

function preservedRenames(
  state: RegistryTargetState,
  candidate: ResolverCandidateGraph
): ReadonlyArray<TargetProjectionRename> {
  const candidatePackages = new Set(
    candidate.packages.map((entry) => entry.packageCoordinate)
  );
  return projectionRenames(
    state.projections.filter((projection) =>
      candidatePackages.has(projection.packageCoordinate)
    )
  );
}
