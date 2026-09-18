import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import type { TargetProjection } from "../../domain/target/index.js";
import type {
  OperationLockLost
} from "../../native/skiloom-lock.js";
import type {
  RegistryPendingLockedError
} from "../registry/index.js";
import {
  prepareManagedProjection,
  verifyManagedProjection,
  type ManagedProjectionRuntimeError
} from "../target-projection/index.js";
import {
  cleanupPendingTargetStaging,
  type ReconcileAcceptedTargetStateInput,
  type TargetReconciliationError
} from "./target-reconcile.js";

export type InvalidInterruptedDetach = ProductError<
  "InvalidInterruptedDetach",
  Readonly<{
    activationName: string;
    reason:
      | "package-missing"
      | "unexpected-transform"
      | "live-state-not-recoverable"
      | "ambiguous-pending-actions";
  }>
>;

export type DetachRecoveryError =
  | InvalidInterruptedDetach
  | OperationLockLost
  | RegistryPendingLockedError
  | ManagedProjectionRuntimeError
  | TargetReconciliationError;

export async function recoverInterruptedDetach(
  input: ReconcileAcceptedTargetStateInput
): Promise<Result<void, DetachRecoveryError>> {
  const pending = input.registry.readPendingOperations();
  if (!pending.ok) {
    return pending;
  }

  const targetPending = pending.value.filter(
    (operation) => operation.targetId === input.acceptedState.targetId
  );
  if (targetPending.length === 0) {
    return { ok: true, value: undefined };
  }
  if (targetPending.length !== 1) {
    return invalidDetach("", "ambiguous-pending-actions");
  }

  const operation = targetPending[0]!;
  const matches = operation.actions.flatMap((action) => {
    const projection = input.acceptedState.projections.find(
      (candidate) =>
        candidate.activationName === action.activationName &&
        candidate.ownership === "detached" &&
        candidate.materialization === "copy"
    );
    return projection === undefined ? [] : [projection];
  });

  if (matches.length === 0) {
    return { ok: true, value: undefined };
  }
  if (matches.length !== 1) {
    return invalidDetach("", "ambiguous-pending-actions");
  }

  const projection = matches[0]!;
  const activationPath = join(input.targetRoot, projection.activationName);
  let stat;
  try {
    stat = await lstat(activationPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return invalidDetach(
        projection.activationName,
        "live-state-not-recoverable"
      );
    }
    throw error;
  }

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    return { ok: true, value: undefined };
  }
  if (!stat.isSymbolicLink()) {
    return invalidDetach(
      projection.activationName,
      "live-state-not-recoverable"
    );
  }
  if (projection.transformJson !== null) {
    return invalidDetach(
      projection.activationName,
      "unexpected-transform"
    );
  }

  const packageFact = input.acceptedState.resolvedPackages.find(
    (candidate) =>
      candidate.packageCoordinate === projection.packageCoordinate
  );
  if (packageFact === undefined) {
    return invalidDetach(
      projection.activationName,
      "package-missing"
    );
  }

  const managedProjection: TargetProjection = {
    packageCoordinate: packageFact.packageCoordinate,
    packageRoot: packageFact.packageRoot,
    contentDigest: packageFact.contentDigest,
    activationName: projection.activationName,
    projectionKind: "direct",
    transform: null
  };
  const oldMaterialization =
    process.platform === "win32" ? "junction" : "symlink";

  const verified = await verifyManagedProjection({
    home: input.home,
    targetRoot: input.targetRoot,
    expected: {
      projection: managedProjection,
      materialization: oldMaterialization
    }
  });
  if (!verified.ok) {
    return verified;
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

  const cleanupPath = join(
    input.targetRoot,
    ".skiloom-stage-" +
      projection.activationName +
      "-" +
      randomUUID()
  );
  const replacementPending =
    input.registry.beginPendingReconciliation(
      input.acceptedState.targetId,
      {
        operationId: input.operationId,
        actions: [
          {
            stagingPath: cleanupPath,
            activationName: projection.activationName
          }
        ]
      }
    );
  if (!replacementPending.ok) {
    return replacementPending;
  }

  const prepared = await prepareManagedProjection({
    home: input.home,
    targetRoot: input.targetRoot,
    projection: managedProjection,
    materialization: "copy",
    current: {
      projection: managedProjection,
      materialization: oldMaterialization
    },
    cleanupPath
  });
  if (!prepared.ok) {
    const held = input.lock.checkHeld();
    if (held.ok) {
      input.registry.completePendingOperation(input.operationId);
    }
    return prepared;
  }

  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
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

  return { ok: true, value: undefined };
}

function invalidDetach(
  activationName: string,
  reason: InvalidInterruptedDetach["facts"]["reason"]
): Result<never, InvalidInterruptedDetach> {
  return {
    ok: false,
    error: productError("InvalidInterruptedDetach", {
      activationName,
      reason
    })
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
