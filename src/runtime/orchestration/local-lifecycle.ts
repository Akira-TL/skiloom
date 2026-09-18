import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import type { PackageSnapshot } from "../../domain/snapshot/index.js";
import type {
  RegistryResolvedPackage,
  RegistryResolvedSource,
  RegistryTargetState
} from "../registry/index.js";
import {
  repairPackageStoreEntry,
  type PackageStoreError
} from "../store.js";
import {
  recoverInterruptedDetach,
  type DetachRecoveryError
} from "./detach-recovery.js";
import {
  reconcileAcceptedTargetState,
  type ReconcileAcceptedTargetStateInput,
  type TargetReconciliationError
} from "./target-reconcile.js";
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

export type LocalLifecycleError =
  | TargetReconciliationError
  | PackageStoreError
  | InvalidExactRepairInput
  | DetachRecoveryError;

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

export async function syncAcceptedTargetState(
  input: SyncAcceptedTargetStateInput
): Promise<Result<RegistryTargetState, LocalLifecycleError>> {
  const recovered = await recoverInterruptedDetach(input);
  if (!recovered.ok) {
    return recovered;
  }
  return reconcileAcceptedTargetState(input);
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
