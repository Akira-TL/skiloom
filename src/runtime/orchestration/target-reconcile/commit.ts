import {
  productError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  MachineRegistry,
  RegistryForkLocationTransfer,
  RegistryReplaceLockedError,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../../registry/index.js";

export function commitReconciliationRegistryState(
  registry: MachineRegistry,
  state: RegistryTargetStateInput,
  transfer: RegistryForkLocationTransfer | undefined,
  pendingOperationId: string | undefined
): Result<RegistryTargetState, RegistryReplaceLockedError> {
  if (transfer === undefined) {
    return registry.replaceTargetState(state, pendingOperationId);
  }
  if (registry.replaceForkedTargetState === undefined) {
    return {
      ok: false,
      error: productError("RegistryStateRejected", {
        targetId: state.targetId,
        reason: "fork-location-conflict" as const
      })
    };
  }
  return registry.replaceForkedTargetState(
    state,
    transfer,
    pendingOperationId
  );
}
