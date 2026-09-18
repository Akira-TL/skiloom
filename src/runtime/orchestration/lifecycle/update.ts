import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  SourceAuthorizationDelta
} from "../../../domain/resolver/index.js";
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
import {
  applyAcceptedRequirementChange,
  type AcceptedRequirementChangeError
} from "./requirement-change.js";

export type ReleaseRetargetFact = Extract<
  SourceAuthorizationDelta,
  Readonly<{ kind: "release-retarget" }>
>;

export type ReleaseRetargetAuthorizationRequired = ProductError<
  "ReleaseRetargetAuthorizationRequired",
  Readonly<{
    retargets: ReadonlyArray<Readonly<{
      repositoryCoordinate: string;
      actualTag: string;
      previousCommit: string;
      candidateCommit: string;
    }>>;
  }>
>;

export type ReleaseRetargetAuthorizationFailed = ProductError<
  "ReleaseRetargetAuthorizationFailed",
  Readonly<{
    repositories: ReadonlyArray<string>;
  }>
>;

export type UpdateAcceptedTargetError =
  | AcceptedRequirementChangeError
  | ReleaseRetargetAuthorizationRequired
  | ReleaseRetargetAuthorizationFailed;

export type UpdateAcceptedTargetResult =
  | Readonly<{
      status: "declined";
      plan: LifecycleCandidatePlan;
      state: RegistryTargetState;
    }>
  | Readonly<{
      status: "updated";
      plan: LifecycleCandidatePlan;
      state: RegistryTargetState;
      marker: TargetRecoveryMarkerFacts;
    }>;

export type UpdateAcceptedTargetInput = Readonly<{
  home: SkiloomHomePaths;
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  credential?: string;
  signal?: AbortSignal;
  sourceCachePath?: string;
  repositoryTransport: GitHubRepositoryTransport;
  transport: GitHubJsonTransport;
  authorizeReleaseRetarget?: (
    retargets: ReadonlyArray<ReleaseRetargetFact>,
    plan: LifecycleCandidatePlan
  ) => boolean | Promise<boolean>;
  acceptCandidate: (
    plan: LifecycleCandidatePlan
  ) => boolean | Promise<boolean>;
  syncMarker: (
    marker: TargetRecoveryMarkerFacts
  ) => void | Promise<void>;
  createOperationId?: () => string;
}>;

export async function updateAcceptedTarget(
  input: UpdateAcceptedTargetInput
): Promise<
  Result<UpdateAcceptedTargetResult, UpdateAcceptedTargetError>
> {
  let retargetFailure:
    | ReleaseRetargetAuthorizationRequired
    | ReleaseRetargetAuthorizationFailed
    | undefined;

  const result = await applyAcceptedRequirementChange({
    home: input.home,
    targetId: input.targetId,
    targetRoot: input.targetRoot,
    lock: input.lock,
    registry: input.registry,
    mutateRequirements: (current) => current,
    repositoryTransport: input.repositoryTransport,
    transport: input.transport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential }),
    ...(input.signal === undefined
      ? {}
      : { signal: input.signal }),
    ...(input.sourceCachePath === undefined
      ? {}
      : { sourceCachePath: input.sourceCachePath }),
    acceptCandidate: async (plan) => {
      const retargets = releaseRetargets(plan);
      if (retargets.length > 0) {
        if (input.authorizeReleaseRetarget === undefined) {
          retargetFailure = retargetRequired(retargets);
          return false;
        }

        let authorized: boolean;
        try {
          authorized = await input.authorizeReleaseRetarget(
            retargets,
            plan
          );
        } catch {
          retargetFailure = productError(
            "ReleaseRetargetAuthorizationFailed",
            {
              repositories: retargets
                .map((entry) => entry.repositoryCoordinate)
                .sort(compareUtf8)
            }
          );
          return false;
        }
        if (!authorized) {
          retargetFailure = retargetRequired(retargets);
          return false;
        }
      }

      return await input.acceptCandidate(plan);
    },
    syncMarker: input.syncMarker,
    ...(input.createOperationId === undefined
      ? {}
      : { createOperationId: input.createOperationId })
  });

  if (retargetFailure !== undefined) {
    return { ok: false, error: retargetFailure };
  }
  if (!result.ok) {
    return result;
  }
  if (result.value.status === "declined") {
    return {
      ok: true,
      value: {
        status: "declined",
        plan: result.value.plan,
        state: result.value.state
      }
    };
  }
  return {
    ok: true,
    value: {
      status: "updated",
      plan: result.value.plan,
      state: result.value.state,
      marker: result.value.marker
    }
  };
}

function releaseRetargets(
  plan: LifecycleCandidatePlan
): ReadonlyArray<ReleaseRetargetFact> {
  return plan.comparison.sourceDeltas
    .filter(
      (
        delta
      ): delta is ReleaseRetargetFact =>
        delta.kind === "release-retarget"
    )
    .sort((left, right) =>
      compareUtf8(
        left.repositoryCoordinate,
        right.repositoryCoordinate
      )
    );
}

function retargetRequired(
  retargets: ReadonlyArray<ReleaseRetargetFact>
): ReleaseRetargetAuthorizationRequired {
  return productError("ReleaseRetargetAuthorizationRequired", {
    retargets: retargets.map((entry) => ({
      repositoryCoordinate: entry.repositoryCoordinate,
      actualTag: entry.actualTag,
      previousCommit: entry.previousCommit,
      candidateCommit: entry.candidateCommit
    }))
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
