import { homedir } from "node:os";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import {
  productError
} from "../domain/errors/index.js";
import type {
  DirectInstallRequirement
} from "../domain/resolver/index.js";
import {
  createNonInteractiveLifecycleAcceptance,
  type LifecycleCandidateAcceptanceCallback,
  type LifecycleCandidateAcceptanceResponse
} from "../runtime/orchestration/lifecycle/acceptance.js";
import type {
  LifecycleCandidatePlan
} from "../runtime/orchestration/lifecycle-candidate.js";
import type {
  LifecycleCandidateProjection
} from "../runtime/orchestration/lifecycle/projection/plan.js";

export type CliCandidateInvocation = Readonly<{
  plan: boolean;
  yes: boolean;
  allowReleaseRetarget: boolean;
  nonInteractive: boolean;
  json: boolean;
}>;

export type CliPresentedDirectRequirement = Readonly<{
  kind: "package" | "repository";
  coordinate: string;
  sourceKind: "github-release" | "git";
  versionRequirement?: string;
  requestedRef?: string;
}>;

type ReleaseRetargetFact = Extract<
  LifecycleCandidatePlan["comparison"]["sourceDeltas"][number],
  Readonly<{ kind: "release-retarget" }>
>;

export type CliCandidateAcceptance = Readonly<{
  acceptCandidate: LifecycleCandidateAcceptanceCallback;
  authorizeReleaseRetarget: (
    retargets: ReadonlyArray<ReleaseRetargetFact>,
    plan: LifecycleCandidatePlan
  ) =>
    | LifecycleCandidateAcceptanceResponse
    | Promise<LifecycleCandidateAcceptanceResponse>;
  acceptCandidateWithRetarget:
    LifecycleCandidateAcceptanceCallback;
}>;

export type CliCandidatePresentation = Readonly<{
  presentCandidate: (
    plan: LifecycleCandidatePlan,
    projections: ReadonlyArray<LifecycleCandidateProjection>
  ) => void;
  presentRetargets: (
    retargets: ReadonlyArray<ReleaseRetargetFact>
  ) => void;
}>;

export function createCliCandidateAcceptance(
  input: CliCandidateInvocation,
  presentation: CliCandidatePresentation
): CliCandidateAcceptance {
  const interactive = isInteractiveCli(input);

  if (!interactive || input.plan || input.yes) {
    const nonInteractive =
      createNonInteractiveLifecycleAcceptance({
        mode: input.plan ? "plan" : "apply",
        ordinaryApproval: input.yes,
        releaseRetargetApproval:
          input.allowReleaseRetarget
      });
    return {
      ...nonInteractive,
      acceptCandidateWithRetarget:
        nonInteractive.acceptCandidate
    };
  }

  const authorizeReleaseRetarget =
    async (
      retargets: ReadonlyArray<ReleaseRetargetFact>
    ): Promise<LifecycleCandidateAcceptanceResponse> => {
      presentation.presentRetargets(retargets);
      if (
        await confirmCliQuestion(
          "Accept release tag retarget risk? [y/N] "
        )
      ) {
        return { kind: "accept" };
      }
      return {
        kind: "reject",
        error: productError("InteractionRequired", {
          reason: "release-retarget-authorization-required",
          repositories: retargets
            .map((entry) => entry.repositoryCoordinate)
            .sort(compareUtf8)
        })
      };
    };

  const acceptCandidate:
    LifecycleCandidateAcceptanceCallback =
    async (plan, projections = []) => {
      presentation.presentCandidate(plan, projections);
      return confirmCliQuestion(
        "Apply this complete state? [y/N] "
      );
    };

  const acceptCandidateWithRetarget:
    LifecycleCandidateAcceptanceCallback =
    async (plan, projections = []) => {
      const retargets = releaseRetargets(plan);
      if (retargets.length > 0) {
        const authorization =
          await authorizeReleaseRetarget(retargets);
        if (
          typeof authorization !== "boolean" &&
          authorization.kind !== "accept"
        ) {
          return authorization;
        }
        if (authorization === false) {
          return false;
        }
      }
      return acceptCandidate(plan, projections);
    };

  return {
    acceptCandidate,
    authorizeReleaseRetarget,
    acceptCandidateWithRetarget
  };
}

export function presentDirectRequirement(
  requirement: DirectInstallRequirement
): CliPresentedDirectRequirement {
  return requirement.sourceKind === "git"
    ? {
        kind: requirement.kind,
        coordinate: requirement.coordinate.canonical,
        sourceKind: "git",
        requestedRef: requirement.requestedRef
      }
    : {
        kind: requirement.kind,
        coordinate: requirement.coordinate.canonical,
        sourceKind: "github-release",
        ...(requirement.versionRequirement === undefined
          ? {}
          : {
              versionRequirement:
                requirement.versionRequirement
            })
      };
}

export function currentUserHome(): string {
  return process.env.HOME ??
    process.env.USERPROFILE ??
    homedir();
}

export function formatReleaseRetargetRisk(
  retargets: ReadonlyArray<ReleaseRetargetFact>
): string {
  const lines = ["Release retarget risk:"];
  for (const retarget of retargets) {
    lines.push(
      "- " + retarget.repositoryCoordinate +
      " " + retarget.actualTag +
      " " + retarget.previousCommit +
      " -> " + retarget.candidateCommit
    );
  }
  return lines.join("\n") + "\n";
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

export function isInteractiveCli(
  input: Readonly<{
    json: boolean;
    nonInteractive: boolean;
  }>
): boolean {
  return (
    !input.json &&
    !input.nonInteractive &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true
  );
}

export async function confirmCliQuestion(
  question: string
): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = (await terminal.question(question))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    terminal.close();
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
