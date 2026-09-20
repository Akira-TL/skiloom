import {
  compareCandidateGraphs,
  type DirectInstallRequirement,
  type ResolverCandidateGraph
} from "../../domain/resolver/index.js";
import type {
  ProductError,
  Result
} from "../../domain/errors/index.js";
import type {
  LifecycleCandidatePlan
} from "../../runtime/orchestration/lifecycle-candidate.js";
import {
  registryRequirementsToDomain
} from "../../runtime/orchestration/lifecycle/requirements.js";
import type {
  MachineRegistry,
  RegistryTargetState
} from "../../runtime/registry/index.js";

export type AcceptedInstallNoOp = Readonly<{
  plan: LifecycleCandidatePlan;
  state: RegistryTargetState;
}>;

export function planOnlyInstallRegistry(): MachineRegistry {
  const unexpected = (): never => {
    throw new Error(
      "plan-only fresh install touched Machine Registry"
    );
  };
  return {
    close() {},
    pragmas: unexpected,
    readTargetState: unexpected,
    readPendingOperations: unexpected,
    beginPendingOperation: unexpected,
    beginPendingReconciliation: unexpected,
    completePendingOperation: unexpected,
    replaceTargetState: unexpected
  };
}

export function acceptedInstallNoOp(
  registry: MachineRegistry,
  targetId: string,
  requirement: DirectInstallRequirement
): Result<AcceptedInstallNoOp | null, ProductError> {
  const current = registry.readTargetState(targetId);
  if (!current.ok) {
    return current;
  }
  if (
    current.value === undefined ||
    !hasDirectRequirement(
      current.value,
      requirement
    )
  ) {
    return { ok: true, value: null };
  }

  const plan = acceptedNoOpPlan(current.value);
  return plan.ok
    ? {
        ok: true,
        value: {
          plan: plan.value,
          state: current.value
        }
      }
    : plan;
}

function hasDirectRequirement(
  state: RegistryTargetState,
  requirement: DirectInstallRequirement
): boolean {
  return state.directRequirements.some((entry) => {
    if (
      entry.kind !== requirement.kind ||
      entry.coordinate !== requirement.coordinate.canonical ||
      entry.sourceKind !== requirement.sourceKind
    ) {
      return false;
    }
    if (
      entry.sourceKind === "git" &&
      requirement.sourceKind === "git"
    ) {
      return entry.requestedRef === requirement.requestedRef;
    }
    return (
      entry.sourceKind === "github-release" &&
      requirement.sourceKind === "github-release" &&
      entry.versionRequirement ===
        (requirement.versionRequirement ?? null)
    );
  });
}

function acceptedNoOpPlan(
  state: RegistryTargetState
): Result<LifecycleCandidatePlan, ProductError> {
  const directRequirements = registryRequirementsToDomain(
    state.targetId,
    state.directRequirements
  );
  if (!directRequirements.ok) {
    return directRequirements;
  }

  const candidate: ResolverCandidateGraph = {
    sourceBindings: state.resolvedSources,
    packages: state.resolvedPackages.map((entry) => ({
      packageCoordinate: entry.packageCoordinate,
      packageRoot: entry.packageRoot,
      contentDigest: entry.contentDigest
    })),
    dependencyEdges: state.dependencyEdges.map((entry) => ({
      sourcePackageCoordinate: entry.fromPackage,
      targetPackageCoordinate: entry.toPackage
    }))
  };

  return {
    ok: true,
    value: {
      directRequirements: directRequirements.value,
      candidate,
      comparison: compareCandidateGraphs({
        previous: candidate,
        candidate,
        directRequirements: directRequirements.value
      }),
      noChange: true
    }
  };
}
