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
    mutateRequirements: (current) =>
      upsertDirectRequirements(current, input.additions),
    acceptCandidate: input.acceptCandidate,
    ...(input.requestedProjectionRename === undefined
      ? {}
      : {
          requestedProjectionRename:
            input.requestedProjectionRename
        }),
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

function upsertDirectRequirements(
  current: ReadonlyArray<DirectInstallRequirement>,
  additions: ReadonlyArray<DirectInstallRequirement>
): ReadonlyArray<DirectInstallRequirement> {
  const next = [...current];

  for (const addition of additions) {
    const existingIndex = next.findIndex(
      (requirement) =>
        requirement.kind === addition.kind &&
        requirement.coordinate.canonical ===
          addition.coordinate.canonical
    );
    if (existingIndex === -1) {
      next.push(addition);
      continue;
    }
    next[existingIndex] = addition;
  }

  return next;
}
