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
import type {
  TargetOwnedProjection,
  TargetOwnershipPreflight
} from "../../domain/target/preflight.js";
import type {
  TargetPlan,
  TargetProjection
} from "../../domain/target/index.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../home.js";
import type {
  MachineRegistry,
  RegistryForkLocationTransfer,
  RegistryPendingLockedError,
  RegistryPendingOperationInput,
  RegistryPendingProjectionAction,
  RegistryReplaceLockedError,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../registry/index.js";
import { verifyPackageStoreEntry } from "../store.js";
import {
  removePendingStagingPath,
  sameAcceptedState
} from "./target-reconcile-state.js";
import {
  writeTargetReconciliationRecoveryManifest,
  type InvalidTargetReconciliationRecoveryManifest
} from "./target-reconcile/recovery.js";
import { commitReconciliationRegistryState } from "./target-reconcile/commit.js";
import {
  cleanupPendingTargetStaging,
  validatePendingStagingActions
} from "./target-reconcile/pending.js";
import {
  prepareManagedProjection,
  removeManagedProjection,
  type ManagedProjectionRuntimeError,
  type PreparedManagedProjection
} from "../target-projection/index.js";

export type InvalidTargetReconciliationInput = ProductError<
  "InvalidTargetReconciliationInput",
  Readonly<{
    reason:
      | "empty-operation-id"
      | "target-location-mismatch"
      | "missing-desired-projection"
      | "missing-current-projection"
      | "missing-registry-package"
      | "missing-registry-projection"
      | "registry-projection-mismatch"
      | "unsupported-preflight-action"
      | "unsafe-pending-staging-path"
      | "accepted-state-mismatch";
    subject: string;
  }>
>;

export type TargetReconciliationError =
  | InvalidTargetReconciliationInput
  | ManagedProjectionRuntimeError
  | RegistryPendingLockedError
  | RegistryReplaceLockedError
  | OperationLockLost
  | InvalidTargetReconciliationRecoveryManifest;

export {
  cleanupPendingTargetStaging,
  type CleanupPendingTargetStagingInput
} from "./target-reconcile/pending.js";

export type ReconcileAcceptedTargetStateInput = Readonly<{
  home: SkiloomHomePaths;
  targetRoot: string;
  operationId: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  desiredPlan: TargetPlan;
  preflight: TargetOwnershipPreflight;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  acceptedState: RegistryTargetStateInput;
}>;

export type PrepareTargetReconciliationInput = Readonly<{
  home: SkiloomHomePaths;
  targetRoot: string;
  operationId: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  desiredPlan: TargetPlan;
  preflight: TargetOwnershipPreflight;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  nextState: RegistryTargetStateInput;
  forkLocationTransfer?: RegistryForkLocationTransfer;
  deferPendingCompletion?: boolean;
  extraPendingActions?: ReadonlyArray<RegistryPendingProjectionAction>;
}>;

export type PreparedTargetReconciliation = Readonly<{
  operationId: string;
  commitAcceptedState(): Promise<
    Result<CommittedTargetReconciliation, TargetReconciliationError>
  >;
}>;

export type CommittedTargetReconciliation = Readonly<{
  state: RegistryTargetState;
  reconcileLiveTarget(): Promise<
    Result<RegistryTargetState, TargetReconciliationError>
  >;
}>;

type StagedProjection = Readonly<{
  activationName: string;
  cleanupPath: string;
  prepared: PreparedManagedProjection;
}>;

type StageRequest = Readonly<{
  activationName: string;
  cleanupPath: string;
  projection: TargetProjection;
  materialization: "symlink" | "junction" | "copy";
  current: TargetOwnedProjection | undefined;
}>;

type RemovalRequest = Readonly<{
  activationName: string;
  cleanupPath: string;
  current: TargetOwnedProjection;
}>;

type ReconciliationRequests = Readonly<{
  stages: ReadonlyArray<StageRequest>;
  removals: ReadonlyArray<RemovalRequest>;
}>;

type PendingStarter = (
  targetId: string,
  pending: RegistryPendingOperationInput
) => ReturnType<MachineRegistry["beginPendingOperation"]>;

type PreparedReconciliationStaging = Readonly<{
  staged: ReadonlyArray<StagedProjection>;
  recoveryContainers: ReadonlyArray<string>;
  hasPending: boolean;
}>;

export async function reconcileAcceptedTargetState(
  input: ReconcileAcceptedTargetStateInput
): Promise<Result<RegistryTargetState, TargetReconciliationError>> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const accepted = input.registry.readTargetState(input.acceptedState.targetId);
  if (!accepted.ok) {
    return accepted;
  }
  if (
    accepted.value === undefined ||
    !sameAcceptedState(accepted.value, input.acceptedState)
  ) {
    return invalidInput(
      "accepted-state-mismatch",
      input.acceptedState.targetId
    );
  }

  const cleaned = await cleanupPendingTargetStaging({
    targetId: input.acceptedState.targetId,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry
  });
  if (!cleaned.ok) {
    return cleaned;
  }

  const orchestrationInput: PrepareTargetReconciliationInput = {
    home: input.home,
    targetRoot: input.targetRoot,
    operationId: input.operationId,
    lock: input.lock,
    registry: input.registry,
    desiredPlan: input.desiredPlan,
    preflight: input.preflight,
    currentProjections: input.currentProjections,
    nextState: input.acceptedState
  };

  const requests = validateAndBuildReconciliationRequests(orchestrationInput);
  if (!requests.ok) {
    return requests;
  }

  const staging = await prepareReconciliationStaging(
    orchestrationInput,
    requests.value,
    (targetId, pending) =>
      input.registry.beginPendingReconciliation(targetId, pending),
    "when-actions"
  );
  if (!staging.ok) {
    return staging;
  }

  return committedHandle(
    orchestrationInput,
    accepted.value,
    staging.value.staged,
    requests.value.removals,
    staging.value.recoveryContainers,
    staging.value.hasPending
  ).reconcileLiveTarget();
}

export async function prepareTargetReconciliation(
  input: PrepareTargetReconciliationInput
): Promise<Result<PreparedTargetReconciliation, TargetReconciliationError>> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const requests = validateAndBuildReconciliationRequests(input);
  if (!requests.ok) {
    return requests;
  }

  const staging = await prepareReconciliationStaging(
    input,
    requests.value,
    (targetId, pending) =>
      input.registry.beginPendingOperation(targetId, pending),
    "always"
  );
  if (!staging.ok) {
    return staging;
  }

  let committed = false;
  return {
    ok: true,
    value: {
      operationId: input.operationId,
      async commitAcceptedState() {
        if (committed) {
          throw new Error("target reconciliation accepted state already committed");
        }

        const stillHeld = input.lock.checkHeld();
        if (!stillHeld.ok) {
          return stillHeld;
        }

        const replaced = commitReconciliationRegistryState(
          input.registry,
          input.nextState,
          input.forkLocationTransfer,
          staging.value.hasPending ? input.operationId : undefined
        );
        if (!replaced.ok) {
          if (replaced.error.code !== "OperationLockLost") {
            await cleanupBeforeCommit(
              input,
              staging.value.staged,
              staging.value.recoveryContainers,
              staging.value.hasPending
            );
          }
          return replaced;
        }
        committed = true;

        return {
          ok: true,
          value: committedHandle(
            input,
            replaced.value,
            staging.value.staged,
            requests.value.removals,
            staging.value.recoveryContainers,
            staging.value.hasPending
          )
        };
      }
    }
  };
}

async function prepareReconciliationStaging(
  input: PrepareTargetReconciliationInput,
  requests: ReconciliationRequests,
  beginPending: PendingStarter,
  pendingMode: "always" | "when-actions"
): Promise<
  Result<PreparedReconciliationStaging, TargetReconciliationError>
> {
  for (const packageFact of [...input.nextState.resolvedPackages].sort(
    (left, right) =>
      compareStrings(left.packageCoordinate, right.packageCoordinate)
  )) {
    const stillHeld = input.lock.checkHeld();
    if (!stillHeld.ok) {
      return stillHeld;
    }
    const verified = await verifyPackageStoreEntry(
      input.home,
      packageFact.contentDigest
    );
    if (!verified.ok) {
      return verified;
    }
  }

  const recoveryActions = [
    ...requests.stages.map((request) => ({
      stagingPath: request.cleanupPath,
      activationName: request.activationName
    })),
    ...requests.removals.map((request) => ({
      stagingPath: request.cleanupPath,
      activationName: request.activationName
    })),
    ...(input.extraPendingActions ?? [])
  ];
  const validatedActions =
    validatePendingStagingActions(
      input.targetRoot,
      recoveryActions
    );
  if (!validatedActions.ok) {
    return validatedActions;
  }
  const pending =
    pendingMode === "when-actions" && recoveryActions.length === 0
      ? null
      : beginPending(input.nextState.targetId, {
          operationId: input.operationId,
          actions: recoveryActions
        });
  if (pending !== null && !pending.ok) {
    return pending;
  }

  const staged: StagedProjection[] = [];
  const recoveryContainers: string[] = [];
  for (const request of requests.stages) {
    const stillHeld = input.lock.checkHeld();
    if (!stillHeld.ok) {
      return stillHeld;
    }

    const prepared = await prepareManagedProjection({
      home: input.home,
      targetRoot: input.targetRoot,
      projection: request.projection,
      materialization: request.materialization,
      cleanupPath: request.cleanupPath,
      ...(request.current === undefined
        ? {}
        : {
            current: {
              projection: request.current.projection,
              materialization: request.current.materialization
            }
          })
    });
    if (!prepared.ok) {
      await cleanupBeforeCommit(
        input,
        staged,
        recoveryContainers,
        pending?.ok === true
      );
      return prepared;
    }
    await writeTargetReconciliationRecoveryManifest(
      request.cleanupPath,
      {
        operationId: input.operationId,
        targetId: input.nextState.targetId,
        activationName: request.activationName,
        action: "stage",
        previous:
          request.current === undefined
            ? null
            : {
                projection: request.current.projection,
                materialization: request.current.materialization
              }
      }
    );
    staged.push({
      activationName: request.activationName,
      cleanupPath: request.cleanupPath,
      prepared: prepared.value
    });
  }

  for (const request of requests.removals) {
    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    await writeTargetReconciliationRecoveryManifest(
      request.cleanupPath,
      {
        operationId: input.operationId,
        targetId: input.nextState.targetId,
        activationName: request.activationName,
        action: "remove",
        previous: {
          projection: request.current.projection,
          materialization: request.current.materialization
        }
      }
    );
    recoveryContainers.push(request.cleanupPath);
  }

  return {
    ok: true,
    value: {
      staged,
      recoveryContainers,
      hasPending: pending?.ok === true
    }
  };
}

function committedHandle(
  input: PrepareTargetReconciliationInput,
  state: RegistryTargetState,
  staged: ReadonlyArray<StagedProjection>,
  removals: ReadonlyArray<RemovalRequest>,
  recoveryContainers: ReadonlyArray<string>,
  hasPending: boolean
): CommittedTargetReconciliation {
  let reconciled = false;

  return {
    state,
    async reconcileLiveTarget() {
      if (reconciled) {
        throw new Error("target reconciliation already completed");
      }

      for (const removal of removals) {
        const held = input.lock.checkHeld();
        if (!held.ok) {
          return held;
        }
        const removed = await removeManagedProjection({
          home: input.home,
          targetRoot: input.targetRoot,
          expected: {
            projection: removal.current.projection,
            materialization: removal.current.materialization
          }
        });
        if (!removed.ok) {
          return removed;
        }
      }

      for (const projection of staged) {
        const held = input.lock.checkHeld();
        if (!held.ok) {
          return held;
        }
        const activated = await projection.prepared.activate();
        if (!activated.ok) {
          return activated;
        }
      }

      if (!input.deferPendingCompletion) {
        for (const projection of staged) {
          const held = input.lock.checkHeld();
          if (!held.ok) {
            return held;
          }
          await projection.prepared.discard();
        }

        for (const path of recoveryContainers) {
          const held = input.lock.checkHeld();
          if (!held.ok) {
            return held;
          }
          await removePendingStagingPath(path);
        }
      }

      if (hasPending && !input.deferPendingCompletion) {
        const completed = input.registry.completePendingOperation(
          input.operationId
        );
        if (!completed.ok) {
          return completed;
        }
      }

      reconciled = true;
      return { ok: true, value: state };
    }
  };
}

async function cleanupBeforeCommit(
  input: PrepareTargetReconciliationInput,
  staged: ReadonlyArray<StagedProjection>,
  recoveryContainers: ReadonlyArray<string>,
  hasPending: boolean
): Promise<void> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return;
  }

  for (const projection of staged) {
    const stillHeld = input.lock.checkHeld();
    if (!stillHeld.ok) {
      return;
    }
    await projection.prepared.discard();
  }

  for (const path of recoveryContainers) {
    const stillHeld = input.lock.checkHeld();
    if (!stillHeld.ok) {
      return;
    }
    await removePendingStagingPath(path);
  }

  if (hasPending) {
    input.registry.completePendingOperation(input.operationId);
  }
}

function validateAndBuildReconciliationRequests(
  input: PrepareTargetReconciliationInput
): Result<ReconciliationRequests, InvalidTargetReconciliationInput> {
  if (input.operationId.length === 0) {
    return invalidInput("empty-operation-id", input.operationId);
  }

  const normalizedTargetRoot = resolve(input.targetRoot);
  if (
    !input.nextState.locations.some(
      (location) => resolve(location.path) === normalizedTargetRoot
    )
  ) {
    return invalidInput("target-location-mismatch", input.targetRoot);
  }

  const desiredByActivation = new Map(
    input.desiredPlan.projections.map((projection) => [
      projection.activationName,
      projection
    ])
  );
  const currentByActivation = new Map(
    input.currentProjections.map((owned) => [
      owned.projection.activationName,
      owned
    ])
  );
  const packageByCoordinate = new Map(
    input.nextState.resolvedPackages.map((packageFact) => [
      packageFact.packageCoordinate,
      packageFact
    ])
  );
  const registryProjectionByPackage = new Map(
    input.nextState.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  const registryProjectionByActivation = new Map(
    input.nextState.projections.map((projection) => [
      projection.activationName,
      projection
    ])
  );

  const stages: StageRequest[] = [];
  const removals: RemovalRequest[] = [];
  const expectedManagedPackages = new Set<string>();

  for (const action of input.preflight.actions) {
    if (action.action === "remove") {
      const current = currentByActivation.get(action.activationName);
      if (
        current === undefined ||
        current.ownership !== "managed" ||
        action.currentPackageCoordinate === null ||
        current.projection.packageCoordinate !== action.currentPackageCoordinate
      ) {
        return invalidInput(
          "missing-current-projection",
          action.activationName
        );
      }
      if (registryProjectionByActivation.has(action.activationName)) {
        return invalidInput(
          "registry-projection-mismatch",
          action.activationName
        );
      }
      removals.push({
        activationName: action.activationName,
        cleanupPath: join(
          input.targetRoot,
          `.skiloom-stage-${action.activationName}-${randomUUID()}`
        ),
        current
      });
      continue;
    }

    if (action.action === "drop-missing") {
      if (registryProjectionByActivation.has(action.activationName)) {
        return invalidInput(
          "registry-projection-mismatch",
          action.activationName
        );
      }
      continue;
    }

    if (
      action.action === "preserve-user" ||
      action.action === "preserve-broken-binding"
    ) {
      continue;
    }

    if (
      action.action !== "keep" &&
      action.action !== "materialize" &&
      action.action !== "replace"
    ) {
      return invalidInput(
        "unsupported-preflight-action",
        `${action.activationName}:${action.action}`
      );
    }

    const desired = desiredByActivation.get(action.activationName);
    if (desired === undefined) {
      return invalidInput("missing-desired-projection", action.activationName);
    }

    const packageFact = packageByCoordinate.get(desired.packageCoordinate);
    if (
      packageFact === undefined ||
      packageFact.packageRoot !== desired.packageRoot ||
      packageFact.contentDigest !== desired.contentDigest
    ) {
      return invalidInput(
        "missing-registry-package",
        desired.packageCoordinate
      );
    }

    const registryProjection = registryProjectionByPackage.get(
      desired.packageCoordinate
    );
    if (registryProjection === undefined) {
      return invalidInput(
        "missing-registry-projection",
        desired.packageCoordinate
      );
    }
    if (
      registryProjection.ownership !== "managed" ||
      registryProjection.activationName !== desired.activationName ||
      registryProjection.transformJson !== transformJson(desired) ||
      (desired.transform !== null &&
        registryProjection.materialization !== "copy")
    ) {
      return invalidInput(
        "registry-projection-mismatch",
        desired.packageCoordinate
      );
    }

    expectedManagedPackages.add(desired.packageCoordinate);

    let current: TargetOwnedProjection | undefined;
    if (action.currentPackageCoordinate !== null) {
      current = currentByActivation.get(action.activationName);
      if (
        current === undefined ||
        current.ownership !== "managed" ||
        current.projection.packageCoordinate !== action.currentPackageCoordinate
      ) {
        return invalidInput(
          "missing-current-projection",
          action.activationName
        );
      }
    }

    if (action.action === "keep") {
      continue;
    }

    stages.push({
      activationName: action.activationName,
      cleanupPath: join(
        input.targetRoot,
        `.skiloom-stage-${action.activationName}-${randomUUID()}`
      ),
      projection: desired,
      materialization: registryProjection.materialization,
      current
    });
  }

  for (const projection of input.nextState.projections) {
    if (
      projection.ownership === "managed" &&
      !expectedManagedPackages.has(projection.packageCoordinate)
    ) {
      return invalidInput(
        "registry-projection-mismatch",
        projection.packageCoordinate
      );
    }
  }

  stages.sort((left, right) =>
    compareStrings(left.activationName, right.activationName)
  );
  removals.sort((left, right) =>
    compareStrings(left.activationName, right.activationName)
  );
  return {
    ok: true,
    value: {
      stages,
      removals
    }
  };
}

function transformJson(projection: TargetProjection): string | null {
  if (projection.transform === null) {
    return null;
  }
  return JSON.stringify({
    rename: projection.transform.rename,
    dependencyRoutes: projection.transform.dependencyRoutes
  });
}

function invalidInput(
  reason: InvalidTargetReconciliationInput["facts"]["reason"],
  subject: string
): Result<never, InvalidTargetReconciliationInput> {
  return {
    ok: false,
    error: productError("InvalidTargetReconciliationInput", {
      reason,
      subject
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
