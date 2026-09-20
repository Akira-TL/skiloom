import {
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type { TargetRecoveryMarkerFacts } from "../../../domain/target/recovery.js";
import type { OperationLockSession } from "../../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../../home.js";
import type {
  MachineRegistry,
  RegistryTargetState
} from "../../registry/index.js";
import type {
  GitHubJsonTransport,
  GitHubRepositoryTransport
} from "../../source/github/index.js";
import type {
  LifecycleCandidatePlan
} from "../lifecycle-candidate.js";
import type {
  LifecycleCandidateAcceptanceCallback
} from "./acceptance.js";
import type {
  LifecycleCandidateProjection
} from "./projection/plan.js";
import type {
  DetachedContentChangeRisk
} from "./projection/risk.js";
import {
  applyAcceptedRequirementChange,
  type AcceptedRequirementChangeError
} from "./requirement-change.js";

export type RemoveDirectRequirementSelector = Readonly<{
  kind: "package" | "repository";
  coordinate: string;
}>;

export type InvalidRemoveDirectRequirement = ProductError<
  "InvalidRemoveDirectRequirement",
  Readonly<{
    targetId: string;
    kind: "package" | "repository";
    coordinate: string;
    reason: "invalid-coordinate" | "target-not-found" | "requirement-not-found";
  }>
>;

export type RemoveAcceptedTargetRequirementError =
  | AcceptedRequirementChangeError
  | InvalidRemoveDirectRequirement;

export type RemoveAcceptedTargetRequirementResult =
  | Readonly<{
      status: "planned";
      plan: LifecycleCandidatePlan;
      projections: ReadonlyArray<LifecycleCandidateProjection>;
      detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
      state: RegistryTargetState;
    }>
  | Readonly<{
      status: "no-op";
      plan: LifecycleCandidatePlan;
      projections: ReadonlyArray<LifecycleCandidateProjection>;
      detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
      state: RegistryTargetState;
    }>
  | Readonly<{
      status: "declined";
      plan: LifecycleCandidatePlan;
      projections: ReadonlyArray<LifecycleCandidateProjection>;
      detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
      state: RegistryTargetState;
    }>
  | Readonly<{
      status: "removed";
      plan: LifecycleCandidatePlan;
      projections: ReadonlyArray<LifecycleCandidateProjection>;
      detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
      state: RegistryTargetState;
      marker: TargetRecoveryMarkerFacts;
    }>;

export type RemoveAcceptedTargetRequirementInput = Readonly<{
  home: SkiloomHomePaths;
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  remove: RemoveDirectRequirementSelector;
  credential?: string;
  signal?: AbortSignal;
  sourceCachePath?: string;
  repositoryTransport: GitHubRepositoryTransport;
  transport: GitHubJsonTransport;
  acceptCandidate: LifecycleCandidateAcceptanceCallback;
  syncMarker?: (
    marker: TargetRecoveryMarkerFacts
  ) => void | Promise<void>;
  createOperationId?: () => string;
}>;

export async function removeAcceptedTargetRequirement(
  input: RemoveAcceptedTargetRequirementInput
): Promise<
  Result<
    RemoveAcceptedTargetRequirementResult,
    RemoveAcceptedTargetRequirementError
  >
> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const canonical = canonicalSelector(input);
  if (!canonical.ok) {
    return canonical;
  }

  const current = input.registry.readTargetState(input.targetId);
  if (!current.ok) {
    return current;
  }
  if (current.value === undefined) {
    return invalidRemove(
      input,
      canonical.value,
      "target-not-found"
    );
  }
  if (
    !current.value.directRequirements.some(
      (requirement) =>
        requirement.kind === input.remove.kind &&
        requirement.coordinate === canonical.value
    )
  ) {
    return invalidRemove(
      input,
      canonical.value,
      "requirement-not-found"
    );
  }

  const result = await applyAcceptedRequirementChange({
    home: input.home,
    targetId: input.targetId,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry,
    repositoryTransport: input.repositoryTransport,
    transport: input.transport,
    mutateRequirements: (requirements) =>
      requirements.filter(
        (requirement) =>
          !(
            requirement.kind === input.remove.kind &&
            requirement.coordinate.canonical === canonical.value
          )
      ),
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
  if (!result.ok) {
    return result;
  }

  if (result.value.status === "planned") {
    return {
      ok: true,
      value: {
        status: "planned",
        plan: result.value.plan,
        projections: result.value.projections,
        detachedContentRisks:
          result.value.detachedContentRisks,
        state: result.value.state
      }
    };
  }
  if (result.value.status === "no-op") {
    return {
      ok: true,
      value: {
        status: "no-op",
        plan: result.value.plan,
        projections: result.value.projections,
        detachedContentRisks:
          result.value.detachedContentRisks,
        state: result.value.state
      }
    };
  }
  if (result.value.status === "declined") {
    return {
      ok: true,
      value: {
        status: "declined",
        plan: result.value.plan,
        projections: result.value.projections,
        detachedContentRisks:
          result.value.detachedContentRisks,
        state: result.value.state
      }
    };
  }
  return {
    ok: true,
    value: {
      status: "removed",
      plan: result.value.plan,
      projections: result.value.projections,
      detachedContentRisks:
        result.value.detachedContentRisks,
      state: result.value.state,
      marker: result.value.marker
    }
  };
}

function canonicalSelector(
  input: RemoveAcceptedTargetRequirementInput
): Result<string, InvalidRemoveDirectRequirement> {
  const parsed =
    input.remove.kind === "package"
      ? parsePackageCoordinate(input.remove.coordinate)
      : parseRepositoryCoordinate(input.remove.coordinate);
  if (!parsed.ok) {
    return invalidRemove(
      input,
      input.remove.coordinate,
      "invalid-coordinate"
    );
  }
  return { ok: true, value: parsed.value.canonical };
}

function invalidRemove(
  input: RemoveAcceptedTargetRequirementInput,
  coordinate: string,
  reason: InvalidRemoveDirectRequirement["facts"]["reason"]
): Result<never, InvalidRemoveDirectRequirement> {
  return {
    ok: false,
    error: productError("InvalidRemoveDirectRequirement", {
      targetId: input.targetId,
      kind: input.remove.kind,
      coordinate,
      reason
    })
  };
}
