import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

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
  RegistryPendingLockedError,
  RegistryReplaceLockedError,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../registry/index.js";
import { verifyPackageStoreEntry } from "../store.js";
import {
  prepareManagedProjection,
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
      | "unsupported-preflight-action";
    subject: string;
  }>
>;

export type TargetReconciliationError =
  | InvalidTargetReconciliationInput
  | ManagedProjectionRuntimeError
  | RegistryPendingLockedError
  | RegistryReplaceLockedError
  | OperationLockLost;

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

export async function prepareTargetReconciliation(
  input: PrepareTargetReconciliationInput
): Promise<Result<PreparedTargetReconciliation, TargetReconciliationError>> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const requests = validateAndBuildStageRequests(input);
  if (!requests.ok) {
    return requests;
  }

  for (const packageFact of [...input.nextState.resolvedPackages].sort((left, right) =>
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

  const pending =
    requests.value.length === 0
      ? null
      : input.registry.beginPendingOperation(input.nextState.targetId, {
          operationId: input.operationId,
          actions: requests.value.map((request) => ({
            stagingPath: request.cleanupPath,
            activationName: request.activationName
          }))
        });
  if (pending !== null && !pending.ok) {
    return pending;
  }

  const staged: StagedProjection[] = [];
  for (const request of requests.value) {
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
      await cleanupBeforeCommit(input, staged, pending?.ok === true);
      return prepared;
    }
    staged.push({
      activationName: request.activationName,
      cleanupPath: request.cleanupPath,
      prepared: prepared.value
    });
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

        const replaced = input.registry.replaceTargetState(
          input.nextState,
          pending?.ok === true ? input.operationId : undefined
        );
        if (!replaced.ok) {
          if (replaced.error.code !== "OperationLockLost") {
            await cleanupBeforeCommit(input, staged, pending?.ok === true);
          }
          return replaced;
        }
        committed = true;

        return {
          ok: true,
          value: committedHandle(
            input,
            replaced.value,
            staged,
            pending?.ok === true
          )
        };
      }
    }
  };
}

function committedHandle(
  input: PrepareTargetReconciliationInput,
  state: RegistryTargetState,
  staged: ReadonlyArray<StagedProjection>,
  hasPending: boolean
): CommittedTargetReconciliation {
  let reconciled = false;

  return {
    state,
    async reconcileLiveTarget() {
      if (reconciled) {
        throw new Error("target reconciliation already completed");
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

      for (const projection of staged) {
        const held = input.lock.checkHeld();
        if (!held.ok) {
          return held;
        }
        await projection.prepared.discard();
      }

      if (hasPending) {
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

  if (hasPending) {
    input.registry.completePendingOperation(input.operationId);
  }
}

function validateAndBuildStageRequests(
  input: PrepareTargetReconciliationInput
): Result<ReadonlyArray<StageRequest>, InvalidTargetReconciliationInput> {
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

  const requests: StageRequest[] = [];
  for (const action of input.preflight.actions) {
    if (action.action !== "materialize" && action.action !== "replace") {
      if (
        action.action === "keep" ||
        action.action === "drop-missing" ||
        action.action === "preserve-user" ||
        action.action === "preserve-broken-binding"
      ) {
        continue;
      }
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

    requests.push({
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

  requests.sort((left, right) =>
    compareStrings(left.activationName, right.activationName)
  );
  return { ok: true, value: requests };
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
