import {
  productError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  RegistryDependencyEdge,
  RegistryDetachedBaseline,
  RegistryDirectRequirement,
  RegistryResolvedSource
} from "../../registry/index.js";
import type {
  ExactMergeConflict,
  ExactMergeConflictReason
} from "../merge-plan.js";

export function compatibleSource(
  left: RegistryResolvedSource,
  right: RegistryResolvedSource
): boolean {
  if (
    left.sourceKind !== right.sourceKind ||
    left.repositoryCoordinate !== right.repositoryCoordinate ||
    left.exactCommit !== right.exactCommit
  ) {
    return false;
  }

  if (
    left.sourceKind === "git" &&
    right.sourceKind === "git"
  ) {
    return left.requestedRef === right.requestedRef;
  }

  return (
    left.sourceKind === "github-release" &&
    right.sourceKind === "github-release" &&
    left.version === right.version &&
    left.actualTag === right.actualTag
  );
}

export function requirementKey(
  requirement: RegistryDirectRequirement
): string {
  return requirement.kind + "\u0000" + requirement.coordinate;
}

export function requirementSortKey(
  requirement: RegistryDirectRequirement
): string {
  return (
    requirement.kind +
    "\u0000" +
    requirement.coordinate +
    "\u0000" +
    requirement.sourceKind
  );
}

export function requirementIdentity(
  requirement: RegistryDirectRequirement
): string {
  return requirement.sourceKind === "git"
    ? "git\u0000" + requirement.requestedRef
    : "github-release\u0000" +
        (requirement.versionRequirement ?? "");
}

export function outgoingEdges(
  edges: ReadonlyArray<RegistryDependencyEdge>
): ReadonlyMap<string, ReadonlyArray<string>> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = map.get(edge.fromPackage) ?? [];
    targets.push(edge.toPackage);
    map.set(edge.fromPackage, targets);
  }
  for (const targets of map.values()) {
    targets.sort(compareUtf8);
  }
  return map;
}

export function edgeSetKey(
  values: ReadonlyArray<string>
): string {
  return values.join("\u0000");
}

export function edgeKey(
  edge: RegistryDependencyEdge
): string {
  return edge.fromPackage + "\u0000" + edge.toPackage;
}

export function detachedBaselineKey(
  baseline: RegistryDetachedBaseline
): string {
  return baseline.sourceKind === "git"
    ? [
        baseline.repositoryCoordinate,
        baseline.sourceKind,
        baseline.requestedRef,
        baseline.exactCommit,
        baseline.packageRoot,
        baseline.contentDigest
      ].join("\u0000")
    : [
        baseline.repositoryCoordinate,
        baseline.sourceKind,
        baseline.version,
        baseline.actualTag,
        baseline.exactCommit,
        baseline.packageRoot,
        baseline.contentDigest
      ].join("\u0000");
}

export function conflict(
  reason: ExactMergeConflictReason,
  subject: string
): Result<never, ExactMergeConflict> {
  return {
    ok: false,
    error: productError("ExactMergeConflict", {
      reason,
      subject
    })
  };
}

export function compareUtf8(
  left: string,
  right: string
): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
