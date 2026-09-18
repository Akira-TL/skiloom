import type {
  InteractionRequired,
  LifecycleAcceptanceDecision,
  NonInteractiveLifecycleAuthorization
} from "../../../domain/lifecycle/index.js";
import {
  decideNonInteractiveLifecycleAcceptance
} from "../../../domain/lifecycle/index.js";
import type { Result } from "../../../domain/errors/index.js";
import type {
  LifecycleCandidatePlan
} from "../lifecycle-candidate.js";

export type LifecycleCandidateAcceptanceResponse =
  | boolean
  | LifecycleAcceptanceDecision;

export type LifecycleCandidateAcceptanceCallback = (
  plan: LifecycleCandidatePlan
) =>
  | LifecycleCandidateAcceptanceResponse
  | Promise<LifecycleCandidateAcceptanceResponse>;

export type ResolvedLifecycleAcceptance =
  | "accept"
  | "decline"
  | "plan"
  | "no-op";

export type NonInteractiveLifecycleAcceptanceAdapter = Readonly<{
  acceptCandidate: LifecycleCandidateAcceptanceCallback;
  authorizeReleaseRetarget: () => true;
}>;

export function resolveLifecycleCandidateAcceptance(
  response: LifecycleCandidateAcceptanceResponse
): Result<ResolvedLifecycleAcceptance, InteractionRequired> {
  if (typeof response === "boolean") {
    return {
      ok: true,
      value: response ? "accept" : "decline"
    };
  }
  if (response.kind === "reject") {
    return { ok: false, error: response.error };
  }
  return { ok: true, value: response.kind };
}

export function createNonInteractiveLifecycleAcceptance(
  authorization: NonInteractiveLifecycleAuthorization
): NonInteractiveLifecycleAcceptanceAdapter {
  return {
    acceptCandidate(plan) {
      return decideNonInteractiveLifecycleAcceptance({
        noChange: plan.noChange,
        comparison: plan.comparison,
        authorization
      });
    },
    authorizeReleaseRetarget() {
      // The unified non-interactive decision above owns both approval facts.
      // Returning true here only bypasses the legacy interactive two-callback
      // bridge; it never bypasses the policy decision that gates the commit.
      return true;
    }
  };
}
