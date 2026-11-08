import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { productError, type ProductError, type Result } from "../../../domain/errors/index.js";
import type { TargetPlan, TargetProjection } from "../../../domain/target/index.js";
import type { OperationLockSession } from "../../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../../home.js";
import type {
  MachineRegistry,
  RegistryDetachedBaseline,
  RegistryResolvedSource,
  RegistryTargetState
} from "../../registry/index.js";
import {
  managedProjectionMaterializationCandidates,
  verifyManagedProjection
} from "../../target-projection/index.js";
import { buildMarkerFacts } from "../lifecycle/apply.js";
import { syncLifecycleMarker } from "../lifecycle/marker/index.js";
import { acceptedTargetPlan } from "../lifecycle/recovery/target.js";
import { recoverInterruptedLifecycle } from "../lifecycle/recovery/index.js";
import {
  cleanupPendingTargetStaging,
  prepareTargetReconciliation
} from "../target-reconcile.js";
import type { LocalProjectionOperationResult } from "./operations.js";

export type RestoreAcceptedProjectionInput = Readonly<{
  home: SkiloomHomePaths;
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  packageCoordinate: string;
  createOperationId?: () => string;
}>;

export type InvalidProjectionRestore = ProductError<
  "InvalidProjectionRestore",
  Readonly<{
    packageCoordinate: string;
    reason:
      | "target-not-found"
      | "target-location-mismatch"
      | "projection-not-found"
      | "baseline-missing"
      | "baseline-mismatch"
      | "unrelated-pending-operation";
  }>
>;

export async function restoreAcceptedProjection(
  input: RestoreAcceptedProjectionInput
): Promise<Result<LocalProjectionOperationResult, ProductError>> {
  const held = input.lock.checkHeld();
  if (!held.ok) return held;
  const read = input.registry.readTargetState(input.targetId);
  if (!read.ok) return read;
  const state = read.value;
  if (state === undefined) return invalid(input, "target-not-found");
  if (!state.locations.some((entry) => resolve(entry.path) === resolve(input.targetRoot))) {
    return invalid(input, "target-location-mismatch");
  }
  const recovered = await recoverPendingProjectionRestore(input);
  if (!recovered.ok) return recovered;
  if (recovered.value) return restoreAcceptedProjection(input);
  const projection = state.projections.find((entry) => entry.packageCoordinate === input.packageCoordinate);
  if (projection === undefined) return invalid(input, "projection-not-found");
  const plan = acceptedTargetPlan(state);
  if (!plan.ok) return plan;
  const desired = plan.value.projections.find((entry) => entry.packageCoordinate === input.packageCoordinate);
  if (desired === undefined) return invalid(input, "projection-not-found");

  if (projection.ownership === "managed") {
    const verified = await verifyManagedProjection({
      home: input.home,
      targetRoot: input.targetRoot,
      expected: { projection: desired, materialization: projection.materialization }
    });
    return verified.ok ? { ok: true, value: { status: "no-op", state } } : verified;
  }

  const baseline = state.detachedBaselines.find((entry) => entry.packageCoordinate === input.packageCoordinate);
  const packageFact = state.resolvedPackages.find((entry) => entry.packageCoordinate === input.packageCoordinate);
  const source = state.resolvedSources.find((entry) => entry.repositoryCoordinate === baseline?.repositoryCoordinate);
  if (baseline === undefined || packageFact === undefined || source === undefined) {
    return invalid(input, "baseline-missing");
  }
  if (
    baseline.packageRoot !== packageFact.packageRoot ||
    baseline.contentDigest !== packageFact.contentDigest ||
    baseline.repositoryCoordinate !== packageFact.repositoryCoordinate ||
    !sameSource(baseline, source) ||
    projection.transformJson !== (desired.transform === null ? null : JSON.stringify(desired.transform))
  ) return invalid(input, "baseline-mismatch");

  return applyRestoration(input, state, plan.value, desired);
}

async function applyRestoration(
  input: RestoreAcceptedProjectionInput,
  state: RegistryTargetState,
  plan: TargetPlan,
  desired: TargetProjection
): Promise<Result<LocalProjectionOperationResult, ProductError>> {
  const selected = (coordinate: string) => coordinate === input.packageCoordinate;
  // Only this explicit operation may reclaim a proven, unchanged detached copy.
  const current = { projection: desired, materialization: "copy" as const };
  const verified = await verifyManagedProjection({
    home: input.home, targetRoot: input.targetRoot, expected: current
  });
  if (!verified.ok) return verified;
  const materialization = managedProjectionMaterializationCandidates(
    process.platform, desired.transform !== null
  )[0]!;
  const nextState = {
    ...state,
    projections: state.projections.map((entry) => selected(entry.packageCoordinate)
      ? { ...entry, ownership: "managed" as const, materialization }
      : entry),
    detachedBaselines: state.detachedBaselines.filter((entry) => !selected(entry.packageCoordinate))
  };
  const prepared = await prepareTargetReconciliation({
    home: input.home,
    targetRoot: input.targetRoot,
    operationId: (input.createOperationId ?? randomUUID)(),
    lock: input.lock,
    registry: input.registry,
    desiredPlan: plan,
    currentProjections: state.projections.flatMap((entry) => {
      const view = plan.projections.find((item) => item.packageCoordinate === entry.packageCoordinate);
      return view === undefined ? [] : [{
        projection: view,
        ownership: selected(entry.packageCoordinate) ? "managed" as const : entry.ownership,
        materialization: entry.materialization
      }];
    }),
    preflight: {
      actions: state.projections.map((entry) => ({
        activationName: entry.activationName,
        classification: entry.ownership === "managed" || selected(entry.packageCoordinate)
          ? "pristine-managed" as const : "detached-user-owned" as const,
        action: selected(entry.packageCoordinate) ? "replace" as const
          : entry.ownership === "managed" ? "keep" as const : "preserve-user" as const,
        currentPackageCoordinate: entry.packageCoordinate,
        desiredPackageCoordinate: entry.packageCoordinate
      }))
    },
    nextState,
    deferPendingCompletion: true
  });
  if (!prepared.ok) return prepared;
  const committed = await prepared.value.commitAcceptedState();
  if (!committed.ok) return committed;
  const reconciled = await committed.value.reconcileLiveTarget();
  if (!reconciled.ok) return reconciled;
  const marker = await syncLifecycleMarker({
    targetRoot: input.targetRoot, marker: buildMarkerFacts(reconciled.value, plan)
  });
  if (!marker.ok) return marker;
  const cleaned = await cleanupPendingTargetStaging({
    targetId: input.targetId, targetRoot: input.targetRoot, lock: input.lock, registry: input.registry
  });
  return cleaned.ok ? { ok: true, value: { status: "restored", state: reconciled.value } } : cleaned;
}

export async function recoverPendingProjectionRestore(
  input: RestoreAcceptedProjectionInput
): Promise<Result<boolean, ProductError>> {
  const read = input.registry.readPendingOperations();
  if (!read.ok) return read;
  const pending = read.value.filter((entry) => entry.targetId === input.targetId);
  if (pending.length === 0) return { ok: true, value: false };
  const state = input.registry.readTargetState(input.targetId);
  if (!state.ok) return state;
  const projection = state.value?.projections.find((entry) => entry.packageCoordinate === input.packageCoordinate);
  if (
    pending.length !== 1 || projection === undefined ||
    pending[0]!.actions.length !== 1 ||
    pending[0]!.actions[0]!.activationName !== projection.activationName
  ) return invalid(input, "unrelated-pending-operation");
  const recovered = await recoverInterruptedLifecycle(input);
  return recovered.ok ? { ok: true, value: true } : recovered;
}

function sameSource(baseline: RegistryDetachedBaseline, source: RegistryResolvedSource): boolean {
  if (baseline.exactCommit !== source.exactCommit || baseline.sourceKind !== source.sourceKind) return false;
  if (baseline.sourceKind === "github-release" && source.sourceKind === "github-release") {
    return baseline.version === source.version && baseline.actualTag === source.actualTag;
  }
  return baseline.sourceKind === "git" && source.sourceKind === "git" && baseline.requestedRef === source.requestedRef;
}

function invalid(
  input: RestoreAcceptedProjectionInput,
  reason: InvalidProjectionRestore["facts"]["reason"]
): Result<never, InvalidProjectionRestore> {
  return {
    ok: false,
    error: productError("InvalidProjectionRestore", {
      packageCoordinate: input.packageCoordinate,
      reason
    })
  };
}
