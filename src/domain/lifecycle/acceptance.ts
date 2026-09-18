import {
  productError,
  type ProductError
} from "../errors/index.js";
import type {
  CandidateComparison
} from "../resolver/index.js";

export type LifecycleAcceptanceMode = "apply" | "plan";

export type NonInteractiveLifecycleAuthorization = Readonly<{
  mode: LifecycleAcceptanceMode;
  ordinaryApproval: boolean;
  releaseRetargetApproval: boolean;
}>;

export type InteractionRequiredReason =
  | "ordinary-approval-required"
  | "release-retarget-authorization-required";

export type InteractionRequired = ProductError<
  "InteractionRequired",
  Readonly<{
    reason: InteractionRequiredReason;
    repositories: ReadonlyArray<string>;
  }>
>;

export type LifecycleAcceptanceDecision =
  | Readonly<{ kind: "no-op" }>
  | Readonly<{ kind: "plan" }>
  | Readonly<{ kind: "accept" }>
  | Readonly<{
      kind: "reject";
      error: InteractionRequired;
    }>;

export type NonInteractiveLifecycleAcceptanceInput = Readonly<{
  noChange: boolean;
  comparison: CandidateComparison;
  authorization: NonInteractiveLifecycleAuthorization;
}>;

export function decideNonInteractiveLifecycleAcceptance(
  input: NonInteractiveLifecycleAcceptanceInput
): LifecycleAcceptanceDecision {
  if (input.noChange) {
    return { kind: "no-op" };
  }
  if (input.authorization.mode === "plan") {
    return { kind: "plan" };
  }
  if (!input.authorization.ordinaryApproval) {
    return {
      kind: "reject",
      error: interactionRequired(
        "ordinary-approval-required",
        []
      )
    };
  }

  const retargetRepositories = input.comparison.sourceDeltas
    .filter((delta) => delta.kind === "release-retarget")
    .map((delta) => delta.repositoryCoordinate)
    .sort(compareUtf8);

  if (
    retargetRepositories.length > 0 &&
    !input.authorization.releaseRetargetApproval
  ) {
    return {
      kind: "reject",
      error: interactionRequired(
        "release-retarget-authorization-required",
        retargetRepositories
      )
    };
  }

  return { kind: "accept" };
}

function interactionRequired(
  reason: InteractionRequiredReason,
  repositories: ReadonlyArray<string>
): InteractionRequired {
  return productError("InteractionRequired", {
    reason,
    repositories
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
