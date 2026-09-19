import {
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import type { ResolverCandidateGraph } from "../../domain/resolver/index.js";
import type {
  TargetPlan,
  TargetPlanError,
  TargetProjectionRename
} from "../../domain/target/index.js";
import type { TargetOwnedProjection } from "../../domain/target/preflight.js";
import type {
  RegistryDependencyEdge,
  RegistryDetachedBaseline,
  RegistryDirectRequirement,
  RegistryProjection,
  RegistryResolvedPackage,
  RegistryResolvedSource,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../registry/index.js";
import {
  planLifecycleTarget,
  projectionMaterialization,
  projectionTransformJson
} from "../orchestration/lifecycle/apply.js";
import {
  registryRequirementsToDomain
} from "../orchestration/lifecycle/requirements.js";
import {
  acceptedTargetPlan
} from "../orchestration/lifecycle/recovery/target.js";
import type {
  InterruptedLifecycleRecoveryConflict
} from "../orchestration/lifecycle/recovery/index.js";
import type { PreparedExactImport } from "./prepare.js";
import {
  compareUtf8,
  compatibleSource,
  conflict,
  detachedBaselineKey,
  edgeKey,
  edgeSetKey,
  outgoingEdges,
  requirementIdentity,
  requirementKey,
  requirementSortKey
} from "./merge/helpers.js";

export type ExactMergeConflictReason =
  | "current-state"
  | "direct-requirement"
  | "repository-source"
  | "package-coordinate"
  | "dependency-graph"
  | "projection"
  | "ownership"
  | "detached-baseline"
  | "detached-user-content"
  | "user-owned-path";

export type ExactMergeConflict = ProductError<
  "ExactMergeConflict",
  Readonly<{
    reason: ExactMergeConflictReason;
    subject: string;
  }>
>;

export type PrepareExactMergeError =
  | ExactMergeConflict
  | TargetPlanError
  | InterruptedLifecycleRecoveryConflict;

export type PreparedExactMerge = Readonly<{
  currentState: RegistryTargetState;
  imported: PreparedExactImport;
  desiredPlan: TargetPlan;
  currentOwned: ReadonlyArray<TargetOwnedProjection>;
  syntheticDetachedPackages: ReadonlySet<string>;
  nextState: RegistryTargetStateInput;
}>;

export function prepareExactMergeFacts(
  input: Readonly<{
    current: RegistryTargetState;
    imported: PreparedExactImport;
    targetRoot: string;
  }>
): Result<PreparedExactMerge, PrepareExactMergeError> {
  const currentPlan = acceptedTargetPlan(input.current);
  if (!currentPlan.ok) {
    return currentPlan;
  }
  const currentOwned = ownedProjections(
    input.current,
    currentPlan.value
  );
  if (!currentOwned.ok) {
    return currentOwned;
  }

  const requirements = mergeRequirements(
    input.current.directRequirements,
    input.imported.nextState.directRequirements
  );
  if (!requirements.ok) {
    return requirements;
  }
  const sources = mergeSources(
    input.current.resolvedSources,
    input.imported.nextState.resolvedSources
  );
  if (!sources.ok) {
    return sources;
  }
  const packages = mergePackages(
    input.current.resolvedPackages,
    input.imported.nextState.resolvedPackages
  );
  if (!packages.ok) {
    return packages;
  }
  const edges = mergeEdges(
    input.current.dependencyEdges,
    input.imported.nextState.dependencyEdges,
    new Set(
      input.current.resolvedPackages.map(
        (entry) => entry.packageCoordinate
      )
    ),
    new Set(
      input.imported.nextState.resolvedPackages.map(
        (entry) => entry.packageCoordinate
      )
    )
  );
  if (!edges.ok) {
    return edges;
  }
  const projectionFacts = mergeProjectionFacts(
    input.current.projections,
    input.imported.nextState.projections
  );
  if (!projectionFacts.ok) {
    return projectionFacts;
  }
  const baselines = mergeDetachedBaselines(
    input.current,
    input.imported
  );
  if (!baselines.ok) {
    return baselines;
  }

  const requirementsDomain = registryRequirementsToDomain(
    input.current.targetId,
    requirements.value
  );
  if (!requirementsDomain.ok) {
    return conflict("current-state", input.current.targetId);
  }

  const desiredPlan = planLifecycleTarget(
    requirementsDomain.value,
    registryGraph(packages.value, edges.value),
    projectionRenames(projectionFacts.value)
  );
  if (!desiredPlan.ok) {
    return desiredPlan;
  }
  if (
    !sameProjectionFacts(
      desiredPlan.value,
      projectionFacts.value
    )
  ) {
    return conflict("projection", "planned-projections");
  }

  const currentPackages = new Set(
    input.current.resolvedPackages.map(
      (entry) => entry.packageCoordinate
    )
  );
  const importedDetached = new Set(
    input.imported.manifest.detached.map(
      (entry) => entry.packageCoordinate
    )
  );
  const syntheticDetachedPackages = new Set(
    [...importedDetached].filter(
      (coordinate) => !currentPackages.has(coordinate)
    )
  );

  const desiredByPackage = new Map(
    desiredPlan.value.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  const mergedCurrentOwned = [...currentOwned.value];
  for (const packageCoordinate of [
    ...syntheticDetachedPackages
  ].sort(compareUtf8)) {
    const projection = desiredByPackage.get(packageCoordinate);
    if (projection === undefined) {
      return conflict("projection", packageCoordinate);
    }
    mergedCurrentOwned.push({
      projection,
      ownership: "detached",
      materialization: "copy"
    });
  }
  mergedCurrentOwned.sort((left, right) =>
    compareUtf8(
      left.projection.activationName,
      right.projection.activationName
    )
  );

  const currentProjectionByPackage = new Map(
    input.current.projections.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  const importedProjectionByPackage = new Map(
    input.imported.nextState.projections.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );

  const nextProjections: RegistryProjection[] =
    desiredPlan.value.projections.map((projection) => {
      const current =
        currentProjectionByPackage.get(
          projection.packageCoordinate
        );
      if (current?.ownership === "detached") {
        return current;
      }

      const imported =
        importedProjectionByPackage.get(
          projection.packageCoordinate
        );
      if (
        current === undefined &&
        imported?.ownership === "detached"
      ) {
        return {
          packageCoordinate: projection.packageCoordinate,
          activationName: projection.activationName,
          ownership: "detached",
          materialization: "copy",
          transformJson:
            projectionTransformJson(projection)
        };
      }

      return {
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName,
        ownership: "managed",
        materialization:
          current !== undefined &&
          projection.transform === null
            ? current.materialization
            : projectionMaterialization(projection),
        transformJson:
          projectionTransformJson(projection)
      };
    });

  const candidatePackages = new Map(
    packages.value.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );

  return {
    ok: true,
    value: {
      currentState: input.current,
      imported: input.imported,
      desiredPlan: desiredPlan.value,
      currentOwned: mergedCurrentOwned,
      syntheticDetachedPackages,
      nextState: {
        targetId: input.current.targetId,
        locations: input.current.locations.map((location) => ({
          ...location,
          path:
            location.path === input.targetRoot
              ? input.targetRoot
              : location.path
        })),
        directRequirements: requirements.value,
        resolvedSources: sources.value,
        resolvedPackages: packages.value,
        dependencyEdges: edges.value,
        projections: nextProjections,
        detachedBaselines: baselines.value,
        dependencyObservations:
          input.current.dependencyObservations.filter(
            (observation) =>
              candidatePackages.get(
                observation.packageCoordinate
              )?.contentDigest ===
              observation.packageContentDigest
          )
      }
    }
  };
}

function mergeRequirements(
  current: ReadonlyArray<RegistryDirectRequirement>,
  imported: ReadonlyArray<RegistryDirectRequirement>
): Result<
  ReadonlyArray<RegistryDirectRequirement>,
  ExactMergeConflict
> {
  const map = new Map<string, RegistryDirectRequirement>();

  for (const requirement of [...current, ...imported]) {
    const key = requirementKey(requirement);
    const previous = map.get(key);
    if (
      previous !== undefined &&
      requirementIdentity(previous) !==
        requirementIdentity(requirement)
    ) {
      return conflict("direct-requirement", key);
    }
    map.set(key, requirement);
  }

  return {
    ok: true,
    value: [...map.values()].sort((left, right) =>
      compareUtf8(
        requirementSortKey(left),
        requirementSortKey(right)
      )
    )
  };
}

function mergeSources(
  current: ReadonlyArray<RegistryResolvedSource>,
  imported: ReadonlyArray<RegistryResolvedSource>
): Result<
  ReadonlyArray<RegistryResolvedSource>,
  ExactMergeConflict
> {
  const map = new Map<string, RegistryResolvedSource>();

  for (const source of [...current, ...imported]) {
    const previous = map.get(source.repositoryCoordinate);
    if (
      previous !== undefined &&
      !compatibleSource(previous, source)
    ) {
      return conflict(
        "repository-source",
        source.repositoryCoordinate
      );
    }
    if (previous === undefined) {
      map.set(source.repositoryCoordinate, source);
      continue;
    }
    if (
      previous.sourceKind === "github-release" &&
      source.sourceKind === "github-release"
    ) {
      map.set(source.repositoryCoordinate, {
        ...previous,
        immutable:
          previous.immutable ?? source.immutable
      });
    }
  }

  return {
    ok: true,
    value: [...map.values()].sort((left, right) =>
      compareUtf8(
        left.repositoryCoordinate,
        right.repositoryCoordinate
      )
    )
  };
}

function mergePackages(
  current: ReadonlyArray<RegistryResolvedPackage>,
  imported: ReadonlyArray<RegistryResolvedPackage>
): Result<
  ReadonlyArray<RegistryResolvedPackage>,
  ExactMergeConflict
> {
  const map = new Map<string, RegistryResolvedPackage>();

  for (const packageFact of [...current, ...imported]) {
    const previous = map.get(packageFact.packageCoordinate);
    if (
      previous !== undefined &&
      (
        previous.repositoryCoordinate !==
          packageFact.repositoryCoordinate ||
        previous.packageRoot !== packageFact.packageRoot ||
        previous.contentDigest !== packageFact.contentDigest
      )
    ) {
      return conflict(
        "package-coordinate",
        packageFact.packageCoordinate
      );
    }
    map.set(packageFact.packageCoordinate, packageFact);
  }

  return {
    ok: true,
    value: [...map.values()].sort((left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
    )
  };
}

function mergeEdges(
  current: ReadonlyArray<RegistryDependencyEdge>,
  imported: ReadonlyArray<RegistryDependencyEdge>,
  currentPackages: ReadonlySet<string>,
  importedPackages: ReadonlySet<string>
): Result<
  ReadonlyArray<RegistryDependencyEdge>,
  ExactMergeConflict
> {
  const shared = [...currentPackages].filter(
    (coordinate) => importedPackages.has(coordinate)
  );
  const currentOutgoing = outgoingEdges(current);
  const importedOutgoing = outgoingEdges(imported);

  for (const coordinate of shared.sort(compareUtf8)) {
    if (
      edgeSetKey(currentOutgoing.get(coordinate) ?? []) !==
      edgeSetKey(importedOutgoing.get(coordinate) ?? [])
    ) {
      return conflict("dependency-graph", coordinate);
    }
  }

  const map = new Map<string, RegistryDependencyEdge>();
  for (const edge of [...current, ...imported]) {
    map.set(edgeKey(edge), edge);
  }

  return {
    ok: true,
    value: [...map.values()].sort((left, right) =>
      compareUtf8(edgeKey(left), edgeKey(right))
    )
  };
}

function mergeProjectionFacts(
  current: ReadonlyArray<RegistryProjection>,
  imported: ReadonlyArray<RegistryProjection>
): Result<
  ReadonlyArray<RegistryProjection>,
  ExactMergeConflict
> {
  const byPackage = new Map<string, RegistryProjection>();
  const activationToPackage = new Map<string, string>();

  for (const projection of [...current, ...imported]) {
    const previous = byPackage.get(
      projection.packageCoordinate
    );
    if (
      previous !== undefined &&
      previous.activationName !==
        projection.activationName
    ) {
      return conflict(
        "projection",
        projection.packageCoordinate
      );
    }

    const activationOwner =
      activationToPackage.get(
        projection.activationName
      );
    if (
      activationOwner !== undefined &&
      activationOwner !==
        projection.packageCoordinate
    ) {
      return conflict(
        "projection",
        projection.activationName
      );
    }
    activationToPackage.set(
      projection.activationName,
      projection.packageCoordinate
    );

    if (previous !== undefined) {
      if (
        previous.ownership === "managed" &&
        projection.ownership === "detached"
      ) {
        return conflict(
          "ownership",
          projection.packageCoordinate
        );
      }
      continue;
    }
    byPackage.set(
      projection.packageCoordinate,
      projection
    );
  }

  return {
    ok: true,
    value: [...byPackage.values()].sort((left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
    )
  };
}

function mergeDetachedBaselines(
  current: RegistryTargetState,
  imported: PreparedExactImport
): Result<
  ReadonlyArray<RegistryDetachedBaseline>,
  ExactMergeConflict
> {
  const currentByPackage = new Map(
    current.detachedBaselines.map((baseline) => [
      baseline.packageCoordinate,
      baseline
    ])
  );

  for (const projection of current.projections) {
    if (
      projection.ownership === "detached" &&
      !currentByPackage.has(projection.packageCoordinate)
    ) {
      return conflict(
        "current-state",
        projection.packageCoordinate
      );
    }
  }

  const map = new Map(currentByPackage);
  for (const baseline of imported.nextState.detachedBaselines) {
    const currentBaseline = map.get(
      baseline.packageCoordinate
    );
    if (
      currentBaseline !== undefined &&
      detachedBaselineKey(currentBaseline) !==
        detachedBaselineKey(baseline)
    ) {
      return conflict(
        "detached-baseline",
        baseline.packageCoordinate
      );
    }
    map.set(baseline.packageCoordinate, baseline);
  }

  return {
    ok: true,
    value: [...map.values()].sort((left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
    )
  };
}

function ownedProjections(
  state: RegistryTargetState,
  plan: TargetPlan
): Result<
  ReadonlyArray<TargetOwnedProjection>,
  ExactMergeConflict
> {
  const planByPackage = new Map(
    plan.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  const result: TargetOwnedProjection[] = [];

  for (const registryProjection of state.projections) {
    const projection = planByPackage.get(
      registryProjection.packageCoordinate
    );
    if (
      projection === undefined ||
      projection.activationName !==
        registryProjection.activationName ||
      projectionTransformJson(projection) !==
        registryProjection.transformJson
    ) {
      return conflict(
        "current-state",
        registryProjection.packageCoordinate
      );
    }
    result.push({
      projection,
      ownership: registryProjection.ownership,
      materialization:
        registryProjection.materialization
    });
  }

  if (result.length !== plan.projections.length) {
    return conflict("current-state", state.targetId);
  }

  return {
    ok: true,
    value: result.sort((left, right) =>
      compareUtf8(
        left.projection.activationName,
        right.projection.activationName
      )
    )
  };
}

function registryGraph(
  packages: ReadonlyArray<RegistryResolvedPackage>,
  edges: ReadonlyArray<RegistryDependencyEdge>
): ResolverCandidateGraph {
  return {
    sourceBindings: [],
    packages: packages.map((entry) => ({
      packageCoordinate: entry.packageCoordinate,
      packageRoot: entry.packageRoot,
      contentDigest: entry.contentDigest
    })),
    dependencyEdges: edges.map((entry) => ({
      sourcePackageCoordinate: entry.fromPackage,
      targetPackageCoordinate: entry.toPackage
    }))
  };
}

function projectionRenames(
  projections: ReadonlyArray<RegistryProjection>
): ReadonlyArray<TargetProjectionRename> {
  return projections.flatMap((projection) => {
    const packageName =
      projection.packageCoordinate.split("/")[2];
    return packageName === undefined ||
      packageName === projection.activationName
      ? []
      : [
          {
            packageCoordinate:
              projection.packageCoordinate,
            activationName:
              projection.activationName
          }
        ];
  });
}

function sameProjectionFacts(
  plan: TargetPlan,
  projections: ReadonlyArray<RegistryProjection>
): boolean {
  const planned = plan.projections
    .map(
      (projection) =>
        projection.packageCoordinate +
        "\u0000" +
        projection.activationName
    )
    .sort(compareUtf8);
  const recorded = projections
    .map(
      (projection) =>
        projection.packageCoordinate +
        "\u0000" +
        projection.activationName
    )
    .sort(compareUtf8);

  return (
    planned.length === recorded.length &&
    planned.every(
      (entry, index) => entry === recorded[index]
    )
  );
}
