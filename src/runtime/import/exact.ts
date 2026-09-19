import { randomUUID } from "node:crypto";
import {
  lstat,
  readdir
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import {
  parseExactExportPackage,
  type ExactExportManifest,
  type ExactExportParseError,
  type ExactExportSource
} from "../../domain/export-package/index.js";
import {
  isCanonicalTargetId
} from "../../domain/public-format/common.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../home.js";
import type {
  MachineRegistry,
  RegistryTargetState
} from "../registry/index.js";
import type {
  PackageStoreError
} from "../store.js";
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
  prepareExactImport,
  type PrepareExactImportError
} from "./prepare.js";
import {
  activateStagedImportUserPayload,
  importUserPendingActions,
  planImportUserStaging,
  stageImportUserPayloads,
  type ImportUserActivationError,
  type ImportUserStagingError
} from "./recovery/user-staging.js";

export type ExactImportTargetUnavailable = ProductError<
  "ExactImportTargetUnavailable",
  Readonly<{
    path: string;
  }>
>;

export type ExactImportTargetNotEmpty = ProductError<
  "ExactImportTargetNotEmpty",
  Readonly<{
    path: string;
    entry: string;
  }>
>;

export type InvalidExactImportTargetIdentity = ProductError<
  "InvalidExactImportTargetIdentity",
  Readonly<{
    targetId: string;
  }>
>;

export type ExactImportTargetIdentityConflict = ProductError<
  "ExactImportTargetIdentityConflict",
  Readonly<{
    targetId: string;
  }>
>;

export type ExactImportSourceAcceptanceFailed = ProductError<
  "ExactImportSourceAcceptanceFailed",
  Readonly<Record<string, never>>
>;

export type ExactImportSourceAcceptanceFacts = Readonly<{
  mode: ExactExportManifest["mode"];
  requirements: ExactExportManifest["requirements"];
  sources: ReadonlyArray<ExactExportSource>;
}>;

export type ExactImportError =
  | ExactExportParseError
  | OperationLockLost
  | ExactImportTargetUnavailable
  | ExactImportTargetNotEmpty
  | InvalidExactImportTargetIdentity
  | ExactImportTargetIdentityConflict
  | ExactImportSourceAcceptanceFailed
  | PrepareExactImportError
  | PackageStoreError
  | TargetReconciliationError
  | ImportUserStagingError
  | ImportUserActivationError
  | LifecycleMarkerSyncFailed;

export type ExactImportResult =
  | Readonly<{
      status: "declined";
      manifest: ExactExportManifest;
    }>
  | Readonly<{
      status: "imported";
      manifest: ExactExportManifest;
      state: RegistryTargetState;
    }>;

export type ImportExactPackageInput = Readonly<{
  home: SkiloomHomePaths;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  bytes: Uint8Array;
  acceptSources: (
    facts: ExactImportSourceAcceptanceFacts
  ) => boolean | Promise<boolean>;
  createTargetId?: () => string;
  createOperationId?: () => string;
  syncMarker?: LifecycleMarkerSyncCallback;
}>;

export async function importExactPackage(
  input: ImportExactPackageInput
): Promise<Result<ExactImportResult, ExactImportError>> {
  const parsed = parseExactExportPackage(input.bytes);
  if (!parsed.ok) {
    return parsed;
  }

  const initiallyHeld = input.lock.checkHeld();
  if (!initiallyHeld.ok) {
    return initiallyHeld;
  }

  const targetRoot = resolve(input.targetRoot);
  const target = await inspectEmptyTarget(targetRoot);
  if (!target.ok) {
    return target;
  }

  const targetId = (input.createTargetId ?? randomUUID)();
  if (!isCanonicalTargetId(targetId)) {
    return {
      ok: false,
      error: productError(
        "InvalidExactImportTargetIdentity",
        { targetId }
      )
    };
  }

  const existing = input.registry.readTargetState(targetId);
  if (!existing.ok) {
    return existing;
  }
  if (existing.value !== undefined) {
    return {
      ok: false,
      error: productError(
        "ExactImportTargetIdentityConflict",
        { targetId }
      )
    };
  }

  const prepared = prepareExactImport({
    parsed: parsed.value,
    targetId,
    targetRoot
  });
  if (!prepared.ok) {
    return prepared;
  }

  let accepted: boolean;
  try {
    accepted = await input.acceptSources({
      mode: parsed.value.manifest.mode,
      requirements: parsed.value.manifest.requirements,
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
  if (!accepted) {
    return {
      ok: true,
      value: {
        status: "declined",
        manifest: parsed.value.manifest
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
      prepared.value.managedSnapshots
    );
  if (!published.ok) {
    return published;
  }

  const operationId =
    (input.createOperationId ?? randomUUID)();
  const plannedUser = planImportUserStaging(
    targetRoot,
    prepared.value.userPayloads
  );
  const reconciliation =
    await prepareTargetReconciliation({
      home: input.home,
      targetRoot,
      operationId,
      lock: input.lock,
      registry: input.registry,
      desiredPlan: prepared.value.plan,
      preflight: prepared.value.preflight,
      currentProjections:
        prepared.value.currentProjections,
      nextState: prepared.value.nextState,
      deferPendingCompletion: true,
      extraPendingActions:
        importUserPendingActions(plannedUser)
    });
  if (!reconciliation.ok) {
    return reconciliation;
  }

  const stagedUser = await stageImportUserPayloads({
    operationId,
    targetId,
    lock: input.lock,
    planned: plannedUser
  });
  if (!stagedUser.ok) {
    if (stagedUser.error.code !== "OperationLockLost") {
      const cleaned = await cleanupPendingTargetStaging({
        targetId,
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
    await reconciliation.value.commitAcceptedState();
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
    prepared.value.plan
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
    targetId,
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
      status: "imported",
      manifest: parsed.value.manifest,
      state: reconciled.value
    }
  };
}

async function inspectEmptyTarget(
  targetRoot: string
): Promise<
  Result<
    void,
    ExactImportTargetUnavailable | ExactImportTargetNotEmpty
  >
> {
  let stat;
  try {
    stat = await lstat(targetRoot);
  } catch {
    return {
      ok: false,
      error: productError(
        "ExactImportTargetUnavailable",
        { path: targetRoot }
      )
    };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return {
      ok: false,
      error: productError(
        "ExactImportTargetUnavailable",
        { path: targetRoot }
      )
    };
  }

  let entries;
  try {
    entries = await readdir(targetRoot, {
      encoding: "buffer"
    });
  } catch {
    return {
      ok: false,
      error: productError(
        "ExactImportTargetUnavailable",
        { path: targetRoot }
      )
    };
  }
  if (entries.length > 0) {
    entries.sort((left, right) =>
      Buffer.compare(
        Buffer.from(left),
        Buffer.from(right)
      )
    );
    return {
      ok: false,
      error: productError(
        "ExactImportTargetNotEmpty",
        {
          path: targetRoot,
          entry: Buffer.from(entries[0]!).toString("hex")
        }
      )
    };
  }
  return { ok: true, value: undefined };
}
