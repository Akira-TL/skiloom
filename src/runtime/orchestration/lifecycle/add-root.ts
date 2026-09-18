import type {
  DirectInstallRequirement
} from "../../../domain/resolver/index.js";
import type { Result } from "../../../domain/errors/index.js";
import {
  applyAcceptedRequirementChange,
  type AcceptedRequirementChangeError,
  type AcceptedRequirementChangeInput,
  type AcceptedRequirementChangeResult,
  type InvalidAcceptedRequirementChangeState
} from "./requirement-change.js";

export type InvalidAddRootLifecycleState =
  InvalidAcceptedRequirementChangeState;

export type AddAcceptedTargetRootsError =
  AcceptedRequirementChangeError;

export type AddAcceptedTargetRootsResult =
  AcceptedRequirementChangeResult;

export type AddAcceptedTargetRootsInput =
  Omit<AcceptedRequirementChangeInput, "mutateRequirements"> &
    Readonly<{
      additions: ReadonlyArray<DirectInstallRequirement>;
    }>;

export async function addAcceptedTargetRoots(
  input: AddAcceptedTargetRootsInput
): Promise<
  Result<AddAcceptedTargetRootsResult, AddAcceptedTargetRootsError>
> {
  return applyAcceptedRequirementChange({
    home: input.home,
    targetId: input.targetId,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry,
    repositoryTransport: input.repositoryTransport,
    transport: input.transport,
    mutateRequirements: (current) => [
      ...current,
      ...input.additions
    ],
    acceptCandidate: input.acceptCandidate,
    ...(input.syncMarker === undefined
      ? {}
      : { syncMarker: input.syncMarker }),
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential }),
    ...(input.signal === undefined
      ? {}
      : { signal: input.signal }),
    ...(input.sourceCachePath === undefined
      ? {}
      : { sourceCachePath: input.sourceCachePath }),
    ...(input.createOperationId === undefined
      ? {}
      : { createOperationId: input.createOperationId })
  });
}
