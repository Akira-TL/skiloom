import { randomUUID } from "node:crypto";
import {
  join,
  resolve
} from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import type { PackageSnapshot } from "../../domain/snapshot/index.js";
import type {
  TargetOwnedProjection
} from "../../domain/target/preflight.js";
import type {
  OperationLockSession
} from "../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../home.js";
import type {
  MachineRegistry,
  RegistryDetachedBaseline,
  RegistryResolvedPackage,
  RegistryResolvedSource,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../registry/index.js";
import {
  repairPackageStoreEntry,
  type PackageStoreError
} from "../store.js";
import {
  reconcileAcceptedTargetState,
  type ReconcileAcceptedTargetStateInput,
  type TargetReconciliationError
} from "./target-reconcile.js";
import {
  prepareManagedProjection,
  verifyManagedProjection
} from "../target-projection/index.js";
import { sameAcceptedState } from "./target-reconcile-state.js";

export type InvalidExactRepairInputReason =
  | "accepted-state-mismatch"
  | "duplicate-package"
  | "package-mismatch"
  | "source-mismatch"
  | "snapshot-digest-mismatch";

export type InvalidExactRepairInput = ProductError<
  "InvalidExactRepairInput",
  Readonly<{
    packageCoordinate: string;
    reason: InvalidExactRepairInputReason;
  }>
>;

export type InvalidLocalLifecycleInputReason =
  | "accepted-state-mismatch"
  | "target-location-mismatch"
  | "package-not-found"
  | "projection-not-found"
  | "projection-not-managed"
  | "projection-mismatch"
  | "detached-baseline-exists";

export type InvalidLocalLifecycleInput = ProductError<
  "InvalidLocalLifecycleInput",
  Readonly<{
    packageCoordinate: string;
    reason: InvalidLocalLifecycleInputReason;
  }>
>;

export type LocalLifecycleError =
  | TargetReconciliationError
  | PackageStoreError
  | InvalidExactRepairInput
  | InvalidLocalLifecycleInput;

export type SyncAcceptedTargetStateInput =
  ReconcileAcceptedTargetStateInput;

export type ExactPackageRepairInput = Readonly<{
  package: RegistryResolvedPackage;
  source: RegistryResolvedSource;
  snapshot: PackageSnapshot;
}>;

export type RepairAcceptedTargetStateInput =
  SyncAcceptedTargetStateInput &
  Readonly<{
    repairs: ReadonlyArray<ExactPackageRepairInput>;
  }>;

export type DetachTargetProjectionInput = Readonly<{
  home: SkiloomHomePaths;
  targetRoot: string;
  operationId: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  acceptedState: RegistryTargetStateInput;
  packageCoordinate: string;
  current: TargetOwnedProjection;
}>;

export async function syncAcceptedTargetState(
  input: SyncAcceptedTargetStateInput
): Promise<Result<RegistryTargetState, LocalLifecycleError>> {
  return reconcileAcceptedTargetState(input);
}

export async function detachTargetProjection(
  input: DetachTargetProjectionInput
): Promise<Result<RegistryTargetState, LocalLifecycleError>> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const accepted = input.registry.readTargetState(
    input.acceptedState.targetId
  );
  if (!accepted.ok) {
    return accepted;
  }
  if (
    accepted.value === undefined ||
    !sameAcceptedState(accepted.value, input.acceptedState)
  ) {
    return invalidLocal(
      input.packageCoordinate,
      "accepted-state-mismatch"
    );
  }
  if (
    !input.acceptedState.locations.some(
      (location) => resolve(location.path) === resolve(input.targetRoot)
    )
  ) {
    return invalidLocal(
      input.packageCoordinate,
      "target-location-mismatch"
    );
  }

  const packageFact = input.acceptedState.resolvedPackages.find(
    (candidate) =>
      candidate.packageCoordinate === input.packageCoordinate
  );
  if (packageFact === undefined) {
    return invalidLocal(input.packageCoordinate, "package-not-found");
  }
  const projection = input.acceptedState.projections.find(
    (candidate) =>
      candidate.packageCoordinate === input.packageCoordinate
  );
  if (projection === undefined) {
    return invalidLocal(input.packageCoordinate, "projection-not-found");
  }
  if (
    projection.ownership !== "managed" ||
    input.current.ownership !== "managed"
  ) {
    return invalidLocal(
      input.packageCoordinate,
      "projection-not-managed"
    );
  }
  if (
    !managedProjectionMatchesAccepted(
      input.current,
      packageFact,
      projection
    )
  ) {
    return invalidLocal(input.packageCoordinate, "projection-mismatch");
  }
  if (
    input.acceptedState.detachedBaselines.some(
      (baseline) =>
        baseline.packageCoordinate === input.packageCoordinate
    )
  ) {
    return invalidLocal(
      input.packageCoordinate,
      "detached-baseline-exists"
    );
  }

  const verified = await verifyManagedProjection({
    home: input.home,
    targetRoot: input.targetRoot,
    expected: {
      projection: input.current.projection,
      materialization: input.current.materialization
    }
  });
  if (!verified.ok) {
    return verified;
  }

  const baseline = buildDetachedBaseline(
    input.acceptedState,
    packageFact
  );
  if (!baseline.ok) {
    return baseline;
  }
  const nextState: RegistryTargetStateInput = {
    ...input.acceptedState,
    projections: input.acceptedState.projections.map((candidate) =>
      candidate.packageCoordinate === input.packageCoordinate
        ? {
            ...candidate,
            ownership: "detached",
            materialization: "copy"
          }
        : candidate
    ),
    detachedBaselines: [
      ...input.acceptedState.detachedBaselines,
      baseline.value
    ]
  };

  if (input.current.materialization === "copy") {
    return input.registry.replaceTargetState(nextState);
  }

  const cleanupPath = join(
    input.targetRoot,
    `.skiloom-stage-${input.current.projection.activationName}-${randomUUID()}`
  );
  const pending = input.registry.beginPendingOperation(
    input.acceptedState.targetId,
    {
      operationId: input.operationId,
      actions: [
        {
          stagingPath: cleanupPath,
          activationName: input.current.projection.activationName
        }
      ]
    }
  );
  if (!pending.ok) {
    return pending;
  }

  const prepared = await prepareManagedProjection({
    home: input.home,
    targetRoot: input.targetRoot,
    projection: input.current.projection,
    materialization: "copy",
    current: {
      projection: input.current.projection,
      materialization: input.current.materialization
    },
    cleanupPath
  });
  if (!prepared.ok) {
    const stillHeld = input.lock.checkHeld();
    if (stillHeld.ok) {
      input.registry.completePendingOperation(input.operationId);
    }
    return prepared;
  }

  const committed = input.registry.replaceTargetState(
    nextState,
    input.operationId
  );
  if (!committed.ok) {
    const stillHeld = input.lock.checkHeld();
    if (stillHeld.ok) {
      await prepared.value.discard();
      input.registry.completePendingOperation(input.operationId);
    }
    return committed;
  }

  const stillHeld = input.lock.checkHeld();
  if (!stillHeld.ok) {
    return stillHeld;
  }
  const activated = await prepared.value.activate();
  if (!activated.ok) {
    return activated;
  }

  const cleanupHeld = input.lock.checkHeld();
  if (!cleanupHeld.ok) {
    return cleanupHeld;
  }
  await prepared.value.discard();
  const completed = input.registry.completePendingOperation(
    input.operationId
  );
  if (!completed.ok) {
    return completed;
  }
  return committed;
}

export async function repairAcceptedTargetState(
  input: RepairAcceptedTargetStateInput
): Promise<Result<RegistryTargetState, LocalLifecycleError>> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const accepted = input.registry.readTargetState(
    input.acceptedState.targetId
  );
  if (!accepted.ok) {
    return accepted;
  }
  if (
    accepted.value === undefined ||
    !sameAcceptedState(accepted.value, input.acceptedState)
  ) {
    return invalidRepair(
      "",
      "accepted-state-mismatch"
    );
  }

  const validated = validateRepairs(input);
  if (!validated.ok) {
    return validated;
  }

  for (const repair of validated.value) {
    const stillHeld = input.lock.checkHeld();
    if (!stillHeld.ok) {
      return stillHeld;
    }

    const repaired = await repairPackageStoreEntry(
      input.home,
      repair.package.contentDigest,
      repair.snapshot
    );
    if (!repaired.ok) {
      return repaired;
    }
  }

  return syncAcceptedTargetState(input);
}

function managedProjectionMatchesAccepted(
  current: TargetOwnedProjection,
  packageFact: RegistryResolvedPackage,
  projection: RegistryTargetStateInput["projections"][number]
): boolean {
  return (
    current.projection.packageCoordinate === packageFact.packageCoordinate &&
    current.projection.packageRoot === packageFact.packageRoot &&
    current.projection.contentDigest === packageFact.contentDigest &&
    current.projection.activationName === projection.activationName &&
    current.materialization === projection.materialization &&
    transformJson(current.projection.transform) === projection.transformJson
  );
}

function buildDetachedBaseline(
  state: RegistryTargetStateInput,
  packageFact: RegistryResolvedPackage
): Result<RegistryDetachedBaseline, InvalidLocalLifecycleInput> {
  const source = state.resolvedSources.find(
    (candidate) =>
      candidate.repositoryCoordinate === packageFact.repositoryCoordinate
  );
  if (source === undefined) {
    return invalidLocal(
      packageFact.packageCoordinate,
      "package-not-found"
    );
  }

  if (source.sourceKind === "github-release") {
    return {
      ok: true,
      value: {
        packageCoordinate: packageFact.packageCoordinate,
        repositoryCoordinate: source.repositoryCoordinate,
        sourceKind: source.sourceKind,
        version: source.version,
        actualTag: source.actualTag,
        exactCommit: source.exactCommit,
        packageRoot: packageFact.packageRoot,
        contentDigest: packageFact.contentDigest
      }
    };
  }

  return {
    ok: true,
    value: {
      packageCoordinate: packageFact.packageCoordinate,
      repositoryCoordinate: source.repositoryCoordinate,
      sourceKind: source.sourceKind,
      requestedRef: source.requestedRef,
      exactCommit: source.exactCommit,
      packageRoot: packageFact.packageRoot,
      contentDigest: packageFact.contentDigest
    }
  };
}

function transformJson(
  transform: TargetOwnedProjection["projection"]["transform"]
): string | null {
  if (transform === null) {
    return null;
  }
  return JSON.stringify({
    rename: transform.rename,
    dependencyRoutes: transform.dependencyRoutes
  });
}

function invalidLocal(
  packageCoordinate: string,
  reason: InvalidLocalLifecycleInputReason
): Result<never, InvalidLocalLifecycleInput> {
  return {
    ok: false,
    error: productError("InvalidLocalLifecycleInput", {
      packageCoordinate,
      reason
    })
  };
}

function validateRepairs(
  input: RepairAcceptedTargetStateInput
): Result<ReadonlyArray<ExactPackageRepairInput>, InvalidExactRepairInput> {
  const packages = new Map(
    input.acceptedState.resolvedPackages.map((packageFact) => [
      packageFact.packageCoordinate,
      packageFact
    ])
  );
  const sources = new Map(
    input.acceptedState.resolvedSources.map((source) => [
      source.repositoryCoordinate,
      source
    ])
  );
  const seen = new Set<string>();
  const ordered = [...input.repairs].sort((left, right) =>
    compareStrings(
      left.package.packageCoordinate,
      right.package.packageCoordinate
    )
  );

  for (const repair of ordered) {
    const coordinate = repair.package.packageCoordinate;
    if (seen.has(coordinate)) {
      return invalidRepair(coordinate, "duplicate-package");
    }
    seen.add(coordinate);

    const acceptedPackage = packages.get(coordinate);
    if (
      acceptedPackage === undefined ||
      !sameResolvedPackage(acceptedPackage, repair.package)
    ) {
      return invalidRepair(coordinate, "package-mismatch");
    }

    const acceptedSource = sources.get(
      acceptedPackage.repositoryCoordinate
    );
    if (
      acceptedSource === undefined ||
      !sameResolvedSource(acceptedSource, repair.source)
    ) {
      return invalidRepair(coordinate, "source-mismatch");
    }

    if (repair.snapshot.contentDigest !== acceptedPackage.contentDigest) {
      return invalidRepair(
        coordinate,
        "snapshot-digest-mismatch"
      );
    }
  }

  return { ok: true, value: ordered };
}

function sameResolvedPackage(
  left: RegistryResolvedPackage,
  right: RegistryResolvedPackage
): boolean {
  return (
    left.packageCoordinate === right.packageCoordinate &&
    left.repositoryCoordinate === right.repositoryCoordinate &&
    left.packageRoot === right.packageRoot &&
    left.contentDigest === right.contentDigest
  );
}

function sameResolvedSource(
  left: RegistryResolvedSource,
  right: RegistryResolvedSource
): boolean {
  if (
    left.repositoryCoordinate !== right.repositoryCoordinate ||
    left.sourceKind !== right.sourceKind ||
    left.exactCommit !== right.exactCommit
  ) {
    return false;
  }

  if (
    left.sourceKind === "github-release" &&
    right.sourceKind === "github-release"
  ) {
    return (
      left.version === right.version &&
      left.actualTag === right.actualTag &&
      left.immutable === right.immutable
    );
  }

  return (
    left.sourceKind === "git" &&
    right.sourceKind === "git" &&
    left.requestedRef === right.requestedRef
  );
}

function invalidRepair(
  packageCoordinate: string,
  reason: InvalidExactRepairInputReason
): Result<never, InvalidExactRepairInput> {
  return {
    ok: false,
    error: productError("InvalidExactRepairInput", {
      packageCoordinate,
      reason
    })
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
