import type { Result } from "../../domain/errors/index.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../home.js";
import {
  openMachineRegistry as openRawMachineRegistry,
  type MachineRegistry as RawMachineRegistry,
  type RegistryConnectionPragmas,
  type RegistryLocationRejected,
  type RegistryObservationRejected,
  type RegistryPendingOperationRejected,
  type RegistryReplaceError
} from "./database.js";
import {
  prepareMachineRegistry,
  type RegistryCorrupt,
  type RegistryMaintenanceError
} from "./maintenance.js";
import type {
  RegistryDependencyObservation,
  RegistryForkLocationTransfer,
  RegistryPendingOperation,
  RegistryPendingOperationInput,
  RegistryTargetState,
  RegistryTargetStateInput
} from "./model.js";

export type RegistryOpenError = RegistryMaintenanceError | RegistryCorrupt;
export type RegistryPendingLockedError =
  | RegistryPendingOperationRejected
  | OperationLockLost;
export type RegistryReplaceLockedError = RegistryReplaceError | OperationLockLost;
export type RegistryLocationLockedError =
  | RegistryLocationRejected
  | OperationLockLost;
export type RegistryObservationLockedError =
  | RegistryObservationRejected
  | OperationLockLost;

export interface MachineRegistry {
  close(): void;
  pragmas(): Result<RegistryConnectionPragmas, OperationLockLost>;
  readTargetState(
    targetId: string
  ): Result<RegistryTargetState | undefined, OperationLockLost>;
  readPendingOperations(): Result<
    ReadonlyArray<RegistryPendingOperation>,
    OperationLockLost
  >;
  beginPendingOperation(
    targetId: string,
    pending: RegistryPendingOperationInput
  ): Result<RegistryPendingOperation, RegistryPendingLockedError>;
  beginPendingReconciliation(
    targetId: string,
    pending: RegistryPendingOperationInput
  ): Result<RegistryPendingOperation, RegistryPendingLockedError>;
  completePendingOperation(
    operationId: string
  ): Result<void, OperationLockLost>;
  observeTargetLocation(
    targetId: string,
    path: string,
    observedGeneration: number
  ): Result<
    RegistryTargetState,
    RegistryLocationLockedError
  >;
  replaceDependencyObservations(
    targetId: string,
    kind: RegistryDependencyObservation["kind"],
    observations: ReadonlyArray<RegistryDependencyObservation>
  ): Result<RegistryTargetState, RegistryObservationLockedError>;
  replaceTargetState(
    state: RegistryTargetStateInput,
    pendingOperationId?: string
  ): Result<RegistryTargetState, RegistryReplaceLockedError>;
  replaceForkedTargetState?(
    state: RegistryTargetStateInput,
    transfer: RegistryForkLocationTransfer,
    pendingOperationId?: string
  ): Result<RegistryTargetState, RegistryReplaceLockedError>;
}

class LockedMachineRegistry implements MachineRegistry {
  readonly #registry: RawMachineRegistry;
  readonly #lock: OperationLockSession;

  constructor(registry: RawMachineRegistry, lock: OperationLockSession) {
    this.#registry = registry;
    this.#lock = lock;
  }

  close(): void {
    this.#registry.close();
  }

  pragmas(): Result<RegistryConnectionPragmas, OperationLockLost> {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    return { ok: true, value: this.#registry.pragmas() };
  }

  readTargetState(
    targetId: string
  ): Result<RegistryTargetState | undefined, OperationLockLost> {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    return { ok: true, value: this.#registry.readTargetState(targetId) };
  }

  readPendingOperations(): Result<
    ReadonlyArray<RegistryPendingOperation>,
    OperationLockLost
  > {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    return { ok: true, value: this.#registry.readPendingOperations() };
  }

  beginPendingOperation(
    targetId: string,
    pending: RegistryPendingOperationInput
  ): Result<RegistryPendingOperation, RegistryPendingLockedError> {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    return this.#registry.beginPendingOperation(targetId, pending);
  }

  beginPendingReconciliation(
    targetId: string,
    pending: RegistryPendingOperationInput
  ): Result<RegistryPendingOperation, RegistryPendingLockedError> {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    return this.#registry.beginPendingReconciliation(targetId, pending);
  }

  completePendingOperation(
    operationId: string
  ): Result<void, OperationLockLost> {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    this.#registry.completePendingOperation(operationId);
    return { ok: true, value: undefined };
  }

  observeTargetLocation(
    targetId: string,
    path: string,
    observedGeneration: number
  ): Result<
    RegistryTargetState,
    RegistryLocationLockedError
  > {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    return this.#registry.observeTargetLocation(
      targetId,
      path,
      observedGeneration
    );
  }

  replaceDependencyObservations(
    targetId: string,
    kind: RegistryDependencyObservation["kind"],
    observations: ReadonlyArray<RegistryDependencyObservation>
  ): Result<RegistryTargetState, RegistryObservationLockedError> {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    return this.#registry.replaceDependencyObservations(
      targetId,
      kind,
      observations
    );
  }

  replaceTargetState(
    state: RegistryTargetStateInput,
    pendingOperationId?: string
  ): Result<RegistryTargetState, RegistryReplaceLockedError> {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    return this.#registry.replaceTargetState(state, pendingOperationId);
  }

  replaceForkedTargetState(
    state: RegistryTargetStateInput,
    transfer: RegistryForkLocationTransfer,
    pendingOperationId?: string
  ): Result<RegistryTargetState, RegistryReplaceLockedError> {
    const held = this.#lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    return this.#registry.replaceForkedTargetState(
      state,
      transfer,
      pendingOperationId
    );
  }
}

export async function openMachineRegistry(
  paths: SkiloomHomePaths,
  lock: OperationLockSession
): Promise<Result<MachineRegistry, RegistryOpenError>> {
  const prepared = await prepareMachineRegistry(paths, lock);
  if (!prepared.ok) {
    return prepared;
  }

  const held = lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const opened = openRawMachineRegistry(paths);
  if (!opened.ok) {
    return {
      ok: false,
      error: {
        code: "RegistryCorrupt",
        facts: { reason: "schema-shape" }
      }
    };
  }
  return {
    ok: true,
    value: new LockedMachineRegistry(opened.value, lock)
  };
}
