import type {
  LifecycleCandidatePlan
} from "../../runtime/orchestration/lifecycle-candidate.js";
import type {
  LifecycleCandidateProjection
} from "../../runtime/orchestration/lifecycle/projection/plan.js";
import type {
  DetachedContentChangeRisk
} from "../../runtime/orchestration/lifecycle/projection/risk.js";
import type {
  CliPresentedDirectRequirement
} from "../candidate-acceptance.js";
import type {
  ResolvedCliTarget
} from "../target-selector.js";

export type CliCandidatePresentationFacts<
  Status extends string = string
> = Readonly<{
  status: Status;
  target: ResolvedCliTarget;
  directRequirements:
    ReadonlyArray<CliPresentedDirectRequirement>;
  sources:
    LifecycleCandidatePlan["candidate"]["sourceBindings"];
  packages:
    LifecycleCandidatePlan["candidate"]["packages"];
  dependencyEdges:
    LifecycleCandidatePlan["candidate"]["dependencyEdges"];
  comparison: LifecycleCandidatePlan["comparison"];
  projections: ReadonlyArray<LifecycleCandidateProjection>;
  detachedContentRisks?: ReadonlyArray<DetachedContentChangeRisk>;
}>;

export function formatCliCandidatePresentation(
  facts: CliCandidatePresentationFacts
): string {
  const lines = [
    "Target: " + facts.target.path,
    "Status: " + facts.status,
    "Direct Install Requirements:"
  ];
  for (const requirement of facts.directRequirements) {
    const source =
      requirement.sourceKind === "git"
        ? "git " + requirement.requestedRef
        : "github-release" +
          (requirement.versionRequirement === undefined
            ? ""
            : " " + requirement.versionRequirement);
    lines.push(
      "- " + requirement.kind + " " +
      requirement.coordinate + " " + source
    );
  }

  lines.push("Sources:");
  for (const source of facts.sources) {
    lines.push(
      source.sourceKind === "git"
        ? "- " + source.repositoryCoordinate +
          " git " + source.requestedRef +
          " @ " + source.exactCommit
        : "- " + source.repositoryCoordinate +
          " github-release " + source.version +
          " (" + source.actualTag + ") @ " +
          source.exactCommit
    );
  }

  lines.push("Packages:");
  for (const packageFact of facts.packages) {
    lines.push(
      "- " + packageFact.packageCoordinate +
      " " + packageFact.contentDigest
    );
  }

  lines.push("Dependency Edges:");
  if (facts.dependencyEdges.length === 0) {
    lines.push("- none");
  } else {
    for (const edge of facts.dependencyEdges) {
      lines.push(
        "- " + edge.sourcePackageCoordinate +
        " -> " + edge.targetPackageCoordinate
      );
    }
  }

  lines.push("Projections / Ownership:");
  for (const projection of facts.projections) {
    lines.push(
      "- " + projection.packageCoordinate +
      " -> " + projection.activationName +
      " (" + projection.ownership + ")"
    );
  }

  lines.push("Changes:");
  const deltas = [
    ...facts.comparison.sourceDeltas.map(
      (delta) => delta.kind
    ),
    ...facts.comparison.packageDeltas.map(
      (delta) => delta.kind
    ),
    ...facts.comparison.dependencyEdgeDeltas.map(
      (delta) => delta.kind
    )
  ];
  if (deltas.length === 0) {
    lines.push("- none");
  } else {
    for (const delta of deltas) {
      lines.push("- " + delta);
    }
  }

  lines.push("Warnings / Special Risks:");
  const retargets = facts.comparison.sourceDeltas.filter(
    (delta) => delta.kind === "release-retarget"
  );
  const detachedContentRisks =
    facts.detachedContentRisks ?? [];
  if (
    retargets.length === 0 &&
    detachedContentRisks.length === 0
  ) {
    lines.push("- none");
  } else {
    for (const retarget of retargets) {
      lines.push(
        "- release-retarget " +
        retarget.repositoryCoordinate
      );
    }
    for (const risk of detachedContentRisks) {
      lines.push(
        "- detached-content-change " +
        risk.packageCoordinate +
        " — user-owned bytes are preserved; " +
        "review compatibility manually"
      );
    }
  }

  return lines.join("\n") + "\n";
}
