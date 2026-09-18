import type { Result } from "../../../domain/errors/index.js";
import type {
  OperationLockSession
} from "../../../native/skiloom-lock.js";
import type {
  MachineRegistry
} from "../../registry/index.js";
import type {
  TargetReconciliationError
} from "../target-reconcile.js";
import {
  isSafePendingStagingPath,
  removePendingStagingPath
} from "../target-reconcile-state.js";

export type CleanupPendingTargetStagingInput = Readonly<{
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
}>;

export async function cleanupPendingTargetStaging(
  input: CleanupPendingTargetStagingInput
): Promise<Result<void, TargetReconciliationError>> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const pending = input.registry.readPendingOperations();
  if (!pending.ok) {
    return pending;
  }
  const operations = pending.value.filter(
    (operation) => operation.targetId === input.targetId
  );

  for (const operation of operations) {
    for (const action of operation.actions) {
      if (
        !isSafePendingStagingPath(
          input.targetRoot,
          action
        )
      ) {
        return {
          ok: false,
          error: {
            code: "InvalidTargetReconciliationInput",
            facts: {
              reason: "unsafe-pending-staging-path",
              subject: action.stagingPath
            }
          }
        };
      }
    }
  }

  for (const operation of operations) {
    for (const action of operation.actions) {
      const stillHeld = input.lock.checkHeld();
      if (!stillHeld.ok) {
        return stillHeld;
      }
      await removePendingStagingPath(action.stagingPath);
    }

    const completed =
      input.registry.completePendingOperation(
        operation.operationId
      );
    if (!completed.ok) {
      return completed;
    }
  }

  return { ok: true, value: undefined };
}
