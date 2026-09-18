import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";
import type {
  TargetDependencyRoute,
  TargetPlan,
  TargetProjection,
  TargetProjectionTransform
} from "./index.js";

export type TargetMaterializationMode = "symlink" | "junction" | "copy";

export type TargetOwnedProjection = Readonly<{
  projection: TargetProjection;
  ownership: "managed" | "detached";
  materialization: TargetMaterializationMode;
}>;

export type TargetPathObservation =
  | Readonly<{
      activationName: string;
      kind: "existing";
    }>
  | Readonly<{
      activationName: string;
      kind: "managed";
      packageCoordinate: string;
      contentDigest: string;
      materialization: TargetMaterializationMode;
      expectedViewMatches: boolean;
    }>;

export type TargetOwnershipClassification =
  | "missing-managed"
  | "pristine-managed"
  | "detached-user-owned"
  | "broken-detached";

export type TargetOwnershipActionKind =
  | "materialize"
  | "keep"
  | "replace"
  | "remove"
  | "drop-missing"
  | "preserve-user"
  | "preserve-broken-binding";

export type TargetOwnershipAction = Readonly<{
  activationName: string;
  classification: TargetOwnershipClassification;
  action: TargetOwnershipActionKind;
  currentPackageCoordinate: string | null;
  desiredPackageCoordinate: string | null;
}>;

export type TargetOwnershipPreflight = Readonly<{
  actions: ReadonlyArray<TargetOwnershipAction>;
}>;

export type ForeignTargetPathConflict = ProductError<
  "ForeignTargetPathConflict",
  Readonly<{
    activationName: string;
    desiredPackageCoordinate: string;
  }>
>;

export type ModifiedManagedProjectionReason =
  | "replaced-or-unknown"
  | "package-mismatch"
  | "content-digest-mismatch"
  | "materialization-mismatch"
  | "view-modified";

export type ModifiedManagedProjection = ProductError<
  "ModifiedManagedProjection",
  Readonly<{
    activationName: string;
    packageCoordinate: string;
    reason: ModifiedManagedProjectionReason;
  }>
>;

export type InvalidTargetPreflightInput = ProductError<
  "InvalidTargetPreflightInput",
  Readonly<{
    reason:
      | "duplicate-current-activation"
      | "duplicate-current-package"
      | "duplicate-desired-activation"
      | "duplicate-desired-package"
      | "duplicate-observation";
    subject: string;
  }>
>;

export type TargetOwnershipPreflightError =
  | ForeignTargetPathConflict
  | ModifiedManagedProjection
  | InvalidTargetPreflightInput;

export type TargetOwnershipPreflightInput = Readonly<{
  desiredPlan: TargetPlan;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  observedPaths: ReadonlyArray<TargetPathObservation>;
}>;

export type TargetGenerationFacts = Readonly<{
  registryGeneration: number;
  targetPathPresent: boolean;
  markerGeneration: number | null;
  projectionsVerifiedExact: boolean;
}>;

export type TargetGenerationStatus =
  | "current"
  | "stale-behind"
  | "ahead-anomaly"
  | "missing-marker-repairable"
  | "missing-marker-reconcile-required"
  | "dormant";

export type TargetGenerationDecision = Readonly<{
  status: TargetGenerationStatus;
  registryGeneration: number;
  markerGeneration: number | null;
}>;

type PreflightConflict = Readonly<{
  activationName: string;
  error: ForeignTargetPathConflict | ModifiedManagedProjection;
}>;

export function preflightTargetOwnership(
  input: TargetOwnershipPreflightInput
): Result<TargetOwnershipPreflight, TargetOwnershipPreflightError> {
  const desired = prepareDesired(input.desiredPlan.projections);
  if (!desired.ok) {
    return desired;
  }
  const current = prepareCurrent(input.currentProjections);
  if (!current.ok) {
    return current;
  }
  const observed = prepareObserved(input.observedPaths);
  if (!observed.ok) {
    return observed;
  }

  const actions: TargetOwnershipAction[] = [];
  const conflicts: PreflightConflict[] = [];
  const consumedDesiredActivations = new Set<string>();
  const detachedPackageCoordinates = new Set<string>();

  for (const owned of current.value.ordered) {
    const activationName = owned.projection.activationName;
    const observation = observed.value.get(activationName);

    if (owned.ownership === "detached") {
      detachedPackageCoordinates.add(owned.projection.packageCoordinate);
      const desiredForPackage = desired.value.byPackage.get(
        owned.projection.packageCoordinate
      );
      const remainsAtBoundPath =
        desiredForPackage === undefined ||
        desiredForPackage.activationName === activationName;
      if (desiredForPackage !== undefined && remainsAtBoundPath) {
        consumedDesiredActivations.add(desiredForPackage.activationName);
      }

      actions.push({
        activationName,
        classification:
          observation !== undefined && remainsAtBoundPath
            ? "detached-user-owned"
            : "broken-detached",
        action:
          observation !== undefined && remainsAtBoundPath
            ? "preserve-user"
            : "preserve-broken-binding",
        currentPackageCoordinate: owned.projection.packageCoordinate,
        desiredPackageCoordinate: desiredForPackage?.packageCoordinate ?? null
      });
      continue;
    }

    const desiredAtActivation = desired.value.byActivation.get(activationName);
    if (desiredAtActivation !== undefined) {
      consumedDesiredActivations.add(activationName);
    }

    if (observation === undefined) {
      actions.push({
        activationName,
        classification: "missing-managed",
        action: desiredAtActivation === undefined ? "drop-missing" : "materialize",
        currentPackageCoordinate: owned.projection.packageCoordinate,
        desiredPackageCoordinate: desiredAtActivation?.packageCoordinate ?? null
      });
      continue;
    }

    const mismatchReason = managedMismatchReason(owned, observation);
    if (mismatchReason !== undefined) {
      conflicts.push({
        activationName,
        error: productError("ModifiedManagedProjection", {
          activationName,
          packageCoordinate: owned.projection.packageCoordinate,
          reason: mismatchReason
        })
      });
      continue;
    }

    actions.push({
      activationName,
      classification: "pristine-managed",
      action:
        desiredAtActivation === undefined
          ? "remove"
          : projectionIdentityEqual(owned.projection, desiredAtActivation)
            ? "keep"
            : "replace",
      currentPackageCoordinate: owned.projection.packageCoordinate,
      desiredPackageCoordinate: desiredAtActivation?.packageCoordinate ?? null
    });
  }

  for (const projection of desired.value.ordered) {
    if (
      consumedDesiredActivations.has(projection.activationName) ||
      detachedPackageCoordinates.has(projection.packageCoordinate)
    ) {
      continue;
    }

    const currentAtActivation = current.value.byActivation.get(
      projection.activationName
    );
    if (currentAtActivation !== undefined) {
      if (currentAtActivation.ownership === "detached") {
        conflicts.push({
          activationName: projection.activationName,
          error: productError("ForeignTargetPathConflict", {
            activationName: projection.activationName,
            desiredPackageCoordinate: projection.packageCoordinate
          })
        });
      }
      continue;
    }

    const observation = observed.value.get(projection.activationName);
    if (observation !== undefined) {
      conflicts.push({
        activationName: projection.activationName,
        error: productError("ForeignTargetPathConflict", {
          activationName: projection.activationName,
          desiredPackageCoordinate: projection.packageCoordinate
        })
      });
      continue;
    }

    actions.push({
      activationName: projection.activationName,
      classification: "missing-managed",
      action: "materialize",
      currentPackageCoordinate: null,
      desiredPackageCoordinate: projection.packageCoordinate
    });
  }

  if (conflicts.length > 0) {
    conflicts.sort(compareConflicts);
    return { ok: false, error: conflicts[0]!.error };
  }

  actions.sort(compareActions);
  return { ok: true, value: { actions } };
}

export function classifyTargetGeneration(
  facts: TargetGenerationFacts
): TargetGenerationDecision {
  const base = {
    registryGeneration: facts.registryGeneration,
    markerGeneration: facts.markerGeneration
  };

  if (!facts.targetPathPresent) {
    return { status: "dormant", ...base };
  }
  if (facts.markerGeneration === null) {
    return {
      status: facts.projectionsVerifiedExact
        ? "missing-marker-repairable"
        : "missing-marker-reconcile-required",
      ...base
    };
  }
  if (facts.markerGeneration < facts.registryGeneration) {
    return { status: "stale-behind", ...base };
  }
  if (facts.markerGeneration > facts.registryGeneration) {
    return { status: "ahead-anomaly", ...base };
  }
  return { status: "current", ...base };
}

function prepareDesired(
  projections: ReadonlyArray<TargetProjection>
): Result<
  Readonly<{
    ordered: ReadonlyArray<TargetProjection>;
    byActivation: ReadonlyMap<string, TargetProjection>;
    byPackage: ReadonlyMap<string, TargetProjection>;
  }>,
  InvalidTargetPreflightInput
> {
  const ordered = [...projections].sort(compareProjections);
  const byActivation = new Map<string, TargetProjection>();
  const byPackage = new Map<string, TargetProjection>();
  for (const projection of ordered) {
    if (byActivation.has(projection.activationName)) {
      return invalidInput("duplicate-desired-activation", projection.activationName);
    }
    if (byPackage.has(projection.packageCoordinate)) {
      return invalidInput("duplicate-desired-package", projection.packageCoordinate);
    }
    byActivation.set(projection.activationName, projection);
    byPackage.set(projection.packageCoordinate, projection);
  }
  return { ok: true, value: { ordered, byActivation, byPackage } };
}

function prepareCurrent(
  projections: ReadonlyArray<TargetOwnedProjection>
): Result<
  Readonly<{
    ordered: ReadonlyArray<TargetOwnedProjection>;
    byActivation: ReadonlyMap<string, TargetOwnedProjection>;
  }>,
  InvalidTargetPreflightInput
> {
  const ordered = [...projections].sort((left, right) =>
    compareProjections(left.projection, right.projection)
  );
  const byActivation = new Map<string, TargetOwnedProjection>();
  const byPackage = new Set<string>();
  for (const projection of ordered) {
    const activationName = projection.projection.activationName;
    const packageCoordinate = projection.projection.packageCoordinate;
    if (byActivation.has(activationName)) {
      return invalidInput("duplicate-current-activation", activationName);
    }
    if (byPackage.has(packageCoordinate)) {
      return invalidInput("duplicate-current-package", packageCoordinate);
    }
    byActivation.set(activationName, projection);
    byPackage.add(packageCoordinate);
  }
  return { ok: true, value: { ordered, byActivation } };
}

function prepareObserved(
  observations: ReadonlyArray<TargetPathObservation>
): Result<ReadonlyMap<string, TargetPathObservation>, InvalidTargetPreflightInput> {
  const ordered = [...observations].sort((left, right) =>
    compareUtf8(left.activationName, right.activationName)
  );
  const result = new Map<string, TargetPathObservation>();
  for (const observation of ordered) {
    if (result.has(observation.activationName)) {
      return invalidInput("duplicate-observation", observation.activationName);
    }
    result.set(observation.activationName, observation);
  }
  return { ok: true, value: result };
}

function managedMismatchReason(
  current: TargetOwnedProjection,
  observation: TargetPathObservation
): ModifiedManagedProjectionReason | undefined {
  if (observation.kind !== "managed") {
    return "replaced-or-unknown";
  }
  if (observation.packageCoordinate !== current.projection.packageCoordinate) {
    return "package-mismatch";
  }
  if (observation.contentDigest !== current.projection.contentDigest) {
    return "content-digest-mismatch";
  }
  if (observation.materialization !== current.materialization) {
    return "materialization-mismatch";
  }
  if (!observation.expectedViewMatches) {
    return "view-modified";
  }
  return undefined;
}

function projectionIdentityEqual(
  left: TargetProjection,
  right: TargetProjection
): boolean {
  return (
    left.packageCoordinate === right.packageCoordinate &&
    left.packageRoot === right.packageRoot &&
    left.contentDigest === right.contentDigest &&
    left.activationName === right.activationName &&
    left.projectionKind === right.projectionKind &&
    transformKey(left.transform) === transformKey(right.transform)
  );
}

function transformKey(transform: TargetProjectionTransform | null): string {
  if (transform === null) {
    return "";
  }
  const routes = [...transform.dependencyRoutes].sort(compareRoutes);
  return JSON.stringify({
    rename: transform.rename,
    dependencyRoutes: routes
  });
}

function invalidInput(
  reason: InvalidTargetPreflightInput["facts"]["reason"],
  subject: string
): Result<never, InvalidTargetPreflightInput> {
  return {
    ok: false,
    error: productError("InvalidTargetPreflightInput", { reason, subject })
  };
}

function compareProjections(left: TargetProjection, right: TargetProjection): number {
  const activation = compareUtf8(left.activationName, right.activationName);
  return activation !== 0
    ? activation
    : compareUtf8(left.packageCoordinate, right.packageCoordinate);
}

function compareRoutes(left: TargetDependencyRoute, right: TargetDependencyRoute): number {
  const dependency = compareUtf8(
    left.dependencyPackageCoordinate,
    right.dependencyPackageCoordinate
  );
  if (dependency !== 0) {
    return dependency;
  }
  const from = compareUtf8(left.fromActivationName, right.fromActivationName);
  return from !== 0 ? from : compareUtf8(left.toActivationName, right.toActivationName);
}

function compareActions(left: TargetOwnershipAction, right: TargetOwnershipAction): number {
  const activation = compareUtf8(left.activationName, right.activationName);
  if (activation !== 0) {
    return activation;
  }
  return compareUtf8(
    left.currentPackageCoordinate ?? left.desiredPackageCoordinate ?? "",
    right.currentPackageCoordinate ?? right.desiredPackageCoordinate ?? ""
  );
}

function compareConflicts(left: PreflightConflict, right: PreflightConflict): number {
  const activation = compareUtf8(left.activationName, right.activationName);
  return activation !== 0 ? activation : compareUtf8(left.error.code, right.error.code);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
