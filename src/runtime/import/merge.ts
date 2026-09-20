import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import {
  parseExactExportPackage,
  type ExactExportManifest,
  type ExactExportParseError
} from "../../domain/export-package/index.js";
import {
  preflightTargetOwnership,
  type TargetOwnershipPreflight,
  type TargetOwnershipPreflightError,
  type TargetPathObservation
} from "../../domain/target/preflight.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../native/skiloom-lock.js";
import {
  prepareManagedExactExport,
  type PrepareManagedExactExportError
} from "../export/managed.js";
import type { SkiloomHomePaths } from "../home.js";
import type {
  MachineRegistry,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../registry/index.js";
import type { PackageStoreError } from "../store.js";
import {
  scanUserPayloadTree
} from "../user-payload.js";
import {
  buildMarkerFacts,
  publishLifecycleCandidateSnapshots
} from "../orchestration/lifecycle/apply.js";
import {
  syncLifecycleMarker,
  type LifecycleMarkerSyncCallback,
  type LifecycleMarkerSyncFailed
} from "../orchestration/lifecycle/marker/index.js";
import {
  cleanupPendingTargetStaging,
  prepareTargetReconciliation,
  type TargetReconciliationError
} from "../orchestration/target-reconcile.js";
import {
  type ExactImportSourceAcceptanceFacts,
  type ExactImportSourceAcceptanceFailed
} from "./exact.js";
import {
  prepareExactImport,
  type PrepareExactImportError,
  type PreparedImportUserPayload
} from "./prepare.js";
import {
  activateStagedImportUserPayload,
  importUserPendingActions,
  planImportUserStaging,
  stageImportUserPayloads,
  type ImportUserActivationError,
  type ImportUserStagingError
} from "./recovery/user-staging.js";
import {
  prepareExactMergeFacts,
  type ExactMergeConflict,
  type PrepareExactMergeError,
  type PreparedExactMerge
} from "./merge-plan.js";

export type ExactMergeAuthorizationRequired = ProductError<
  "ExactMergeAuthorizationRequired",
  Readonly<{ targetId: string }>
>;

export type ExactMergeTargetObservationFailed = ProductError<
  "ExactMergeTargetObservationFailed",
  Readonly<{
    activationName: string;
  }>
>;

export type MergeExactPackageError =
  | ExactExportParseError
  | PrepareManagedExactExportError
  | PrepareExactImportError
  | PrepareExactMergeError
  | ExactMergeAuthorizationRequired
  | ExactImportSourceAcceptanceFailed
  | ExactMergeTargetObservationFailed
  | TargetOwnershipPreflightError
  | OperationLockLost
  | PackageStoreError
  | TargetReconciliationError
  | ImportUserStagingError
  | ImportUserActivationError
  | LifecycleMarkerSyncFailed;

export type MergeExactPackageResult =
  | Readonly<{
      status: "declined";
      manifest: ExactExportManifest;
      candidate: RegistryTargetStateInput;
      state: RegistryTargetState;
    }>
  | Readonly<{
      status: "merged";
      manifest: ExactExportManifest;
      candidate: RegistryTargetStateInput;
      state: RegistryTargetState;
    }>;

export type MergeExactPackageInput = Readonly<{
  home: SkiloomHomePaths;
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  bytes: Uint8Array;
  authorizeMerge: () => boolean | Promise<boolean>;
  acceptSources: (
    facts: ExactImportSourceAcceptanceFacts
  ) => boolean | Promise<boolean>;
  createOperationId?: () => string;
  syncMarker?: LifecycleMarkerSyncCallback;
}>;

type MergeFilesystemFacts = Readonly<{
  preflight: TargetOwnershipPreflight;
  userPayloadsToWrite:
    ReadonlyArray<PreparedImportUserPayload>;
}>;

export async function mergeExactPackage(
  input: MergeExactPackageInput
): Promise<
  Result<MergeExactPackageResult, MergeExactPackageError>
> {
  const parsed = parseExactExportPackage(input.bytes);
  if (!parsed.ok) {
    return parsed;
  }

  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const targetRoot = resolve(input.targetRoot);
  const current = await prepareManagedExactExport({
    home: input.home,
    targetId: input.targetId,
    targetRoot,
    lock: input.lock,
    registry: input.registry
  });
  if (!current.ok) {
    return current;
  }
  if (
    !current.value.state.locations.some(
      (location) =>
        resolve(location.path) === targetRoot
    )
  ) {
    return mergeConflict(
      "current-state",
      targetRoot
    );
  }

  const imported = prepareExactImport({
    parsed: parsed.value,
    targetId: input.targetId,
    targetRoot
  });
  if (!imported.ok) {
    return imported;
  }

  const merged = prepareExactMergeFacts({
    current: current.value.state,
    imported: imported.value,
    targetRoot
  });
  if (!merged.ok) {
    return merged;
  }

  const filesystem = await inspectMergeFilesystem(
    targetRoot,
    merged.value
  );
  if (!filesystem.ok) {
    return filesystem;
  }

  let authorized: boolean;
  try {
    authorized = await input.authorizeMerge();
  } catch {
    authorized = false;
  }
  if (!authorized) {
    return {
      ok: false,
      error: productError(
        "ExactMergeAuthorizationRequired",
        { targetId: input.targetId }
      )
    };
  }

  let sourcesAccepted: boolean;
  try {
    sourcesAccepted = await input.acceptSources({
      mode: parsed.value.manifest.mode,
      requirements:
        parsed.value.manifest.requirements,
      sources: parsed.value.manifest.sources
    });
  } catch {
    return {
      ok: false,
      error: productError(
        "ExactImportSourceAcceptanceFailed",
        {}
      )
    };
  }
  if (!sourcesAccepted) {
    return {
      ok: true,
      value: {
        status: "declined",
        manifest: parsed.value.manifest,
        candidate: merged.value.nextState,
        state: current.value.state
      }
    };
  }

  const heldAfterAcceptance = input.lock.checkHeld();
  if (!heldAfterAcceptance.ok) {
    return heldAfterAcceptance;
  }

  const published =
    await publishLifecycleCandidateSnapshots(
      input.home,
      input.lock,
      imported.value.managedSnapshots
    );
  if (!published.ok) {
    return published;
  }

  const operationId =
    (input.createOperationId ?? randomUUID)();
  const plannedUser = planImportUserStaging(
    targetRoot,
    filesystem.value.userPayloadsToWrite
  );
  const preparedReconciliation =
    await prepareTargetReconciliation({
      home: input.home,
      targetRoot,
      operationId,
      lock: input.lock,
      registry: input.registry,
      desiredPlan: merged.value.desiredPlan,
      preflight: filesystem.value.preflight,
      currentProjections:
        merged.value.currentOwned,
      nextState: merged.value.nextState,
      deferPendingCompletion: true,
      extraPendingActions:
        importUserPendingActions(plannedUser)
    });
  if (!preparedReconciliation.ok) {
    return preparedReconciliation;
  }

  const stagedUser = await stageImportUserPayloads({
    operationId,
    targetId: input.targetId,
    lock: input.lock,
    planned: plannedUser
  });
  if (!stagedUser.ok) {
    if (stagedUser.error.code !== "OperationLockLost") {
      const cleaned = await cleanupPendingTargetStaging({
        targetId: input.targetId,
        targetRoot,
        lock: input.lock,
        registry: input.registry
      });
      if (!cleaned.ok) {
        return cleaned;
      }
    }
    return stagedUser;
  }

  const committed =
    await preparedReconciliation.value
      .commitAcceptedState();
  if (!committed.ok) {
    return committed;
  }

  const reconciled =
    await committed.value.reconcileLiveTarget();
  if (!reconciled.ok) {
    return reconciled;
  }

  for (const staged of stagedUser.value) {
    const activated = await activateStagedImportUserPayload({
      targetRoot,
      stagingPath: staged.stagingPath,
      manifest: staged.manifest,
      lock: input.lock
    });
    if (!activated.ok) {
      return activated;
    }
  }

  const heldBeforeMarker = input.lock.checkHeld();
  if (!heldBeforeMarker.ok) {
    return heldBeforeMarker;
  }

  const marker = buildMarkerFacts(
    reconciled.value,
    merged.value.desiredPlan
  );
  const markerSynced = await syncLifecycleMarker({
    targetRoot,
    marker,
    ...(input.syncMarker === undefined
      ? {}
      : { override: input.syncMarker })
  });
  if (!markerSynced.ok) {
    return markerSynced;
  }

  const cleaned = await cleanupPendingTargetStaging({
    targetId: input.targetId,
    targetRoot,
    lock: input.lock,
    registry: input.registry
  });
  if (!cleaned.ok) {
    return cleaned;
  }

  return {
    ok: true,
    value: {
      status: "merged",
      manifest: parsed.value.manifest,
      candidate: merged.value.nextState,
      state: reconciled.value
    }
  };
}

async function inspectMergeFilesystem(
  targetRoot: string,
  merged: PreparedExactMerge
): Promise<
  Result<
    MergeFilesystemFacts,
    | ExactMergeConflict
    | ExactMergeTargetObservationFailed
    | TargetOwnershipPreflightError
  >
> {
  const currentProjectionByPackage = new Map(
    merged.currentState.projections.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  const observed: TargetPathObservation[] = [];
  const observedActivations = new Set<string>();

  for (const owned of merged.currentOwned) {
    if (
      merged.syntheticDetachedPackages.has(
        owned.projection.packageCoordinate
      )
    ) {
      continue;
    }

    const currentProjection =
      currentProjectionByPackage.get(
        owned.projection.packageCoordinate
      );
    if (currentProjection === undefined) {
      continue;
    }

    if (owned.ownership === "managed") {
      observed.push({
        activationName:
          owned.projection.activationName,
        kind: "managed",
        packageCoordinate:
          owned.projection.packageCoordinate,
        contentDigest:
          owned.projection.contentDigest,
        materialization:
          owned.materialization,
        expectedViewMatches: true
      });
      observedActivations.add(
        owned.projection.activationName
      );
      continue;
    }

    const exists = await safePathExists(
      join(
        targetRoot,
        owned.projection.activationName
      ),
      owned.projection.activationName
    );
    if (!exists.ok) {
      return exists;
    }
    if (exists.value) {
      observed.push({
        activationName:
          owned.projection.activationName,
        kind: "existing"
      });
      observedActivations.add(
        owned.projection.activationName
      );
    }
  }

  const importedDetachedByPackage = new Map(
    merged.imported.manifest.detached.map(
      (entry) => [entry.packageCoordinate, entry]
    )
  );
  for (const [
    packageCoordinate,
    detached
  ] of importedDetachedByPackage) {
    const currentProjection =
      currentProjectionByPackage.get(
        packageCoordinate
      );
    if (currentProjection === undefined) {
      continue;
    }
    if (currentProjection.ownership !== "detached") {
      return mergeConflict(
        "ownership",
        packageCoordinate
      );
    }

    const scanned = await scanUserPayloadTree(
      join(targetRoot, detached.activationName)
    );
    if (
      !scanned.ok ||
      scanned.value.contentDigest !==
        detached.userContentDigest
    ) {
      return mergeConflict(
        "detached-user-content",
        packageCoordinate
      );
    }
  }

  const projectionActivations = new Set(
    merged.nextState.projections.map(
      (entry) => entry.activationName
    )
  );
  const userPayloadsToWrite:
    PreparedImportUserPayload[] = [];

  for (const payload of merged.imported.userPayloads) {
    if (
      payload.kind === "detached" &&
      payload.packageCoordinate !== null &&
      currentProjectionByPackage.has(
        payload.packageCoordinate
      )
    ) {
      continue;
    }

    if (
      payload.kind === "user-skill" &&
      projectionActivations.has(
        payload.activationName
      )
    ) {
      return mergeConflict(
        "user-owned-path",
        payload.activationName
      );
    }

    const exists = await safePathExists(
      join(targetRoot, payload.activationName),
      payload.activationName
    );
    if (!exists.ok) {
      return exists;
    }
    if (exists.value) {
      return mergeConflict(
        "user-owned-path",
        payload.activationName
      );
    }
    userPayloadsToWrite.push(payload);
  }

  for (const projection of merged.desiredPlan.projections) {
    if (
      observedActivations.has(
        projection.activationName
      ) ||
      merged.syntheticDetachedPackages.has(
        projection.packageCoordinate
      )
    ) {
      continue;
    }

    const exists = await safePathExists(
      join(targetRoot, projection.activationName),
      projection.activationName
    );
    if (!exists.ok) {
      return exists;
    }
    if (exists.value) {
      observed.push({
        activationName:
          projection.activationName,
        kind: "existing"
      });
      observedActivations.add(
        projection.activationName
      );
    }
  }

  const preflight = preflightTargetOwnership({
    desiredPlan: merged.desiredPlan,
    currentProjections: merged.currentOwned,
    observedPaths: observed
  });
  if (!preflight.ok) {
    return preflight;
  }

  return {
    ok: true,
    value: {
      preflight: preflight.value,
      userPayloadsToWrite
    }
  };
}

async function safePathExists(
  path: string,
  activationName: string
): Promise<
  Result<boolean, ExactMergeTargetObservationFailed>
> {
  try {
    await lstat(path);
    return { ok: true, value: true };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { ok: true, value: false };
    }
    return {
      ok: false,
      error: productError(
        "ExactMergeTargetObservationFailed",
        { activationName }
      )
    };
  }
}

function mergeConflict(
  reason:
    | "current-state"
    | "ownership"
    | "detached-user-content"
    | "user-owned-path",
  subject: string
): Result<never, ExactMergeConflict> {
  return {
    ok: false,
    error: productError("ExactMergeConflict", {
      reason,
      subject
    })
  };
}
