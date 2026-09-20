import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";
import { classifyTargetGeneration } from "./preflight.js";

export type TargetRecoveryRequirement =
  | Readonly<{
      kind: "package" | "repository";
      coordinate: string;
      sourceKind: "github-release";
      versionRequirement: string | null;
    }>
  | Readonly<{
      kind: "package" | "repository";
      coordinate: string;
      sourceKind: "git";
      requestedRef: string;
    }>;

export type TargetRecoveryProjectionOverride = Readonly<{
  packageCoordinate: string;
  activationName: string;
}>;

export type TargetRecoveryManagedBaseline = Readonly<{
  packageCoordinate: string;
  activationName: string;
  materialization: "symlink" | "junction" | "copy";
  packageRoot: string;
  contentDigest: string;
  transformJson: string | null;
}>;

export type TargetRecoveryDetachedBaseline =
  | Readonly<{
      packageCoordinate: string;
      sourceKind: "github-release";
      version: string;
      actualTag: string;
      exactCommit: string;
      packageRoot: string;
      contentDigest: string;
    }>
  | Readonly<{
      packageCoordinate: string;
      sourceKind: "git";
      requestedRef: string;
      exactCommit: string;
      packageRoot: string;
      contentDigest: string;
    }>;

export type TargetRecoveryMarkerFacts = Readonly<{
  targetId: string;
  generation: number;
  requirements: ReadonlyArray<TargetRecoveryRequirement>;
  projectionOverrides: ReadonlyArray<TargetRecoveryProjectionOverride>;
  managed: ReadonlyArray<TargetRecoveryManagedBaseline>;
  detached: ReadonlyArray<TargetRecoveryDetachedBaseline>;
}>;

export type TargetRecoveryRegistryFacts = Readonly<{
  targetId: string;
  generation: number;
}>;

export type TargetRecoveryObservationFacts = Readonly<{
  pathPresent: boolean;
  projectionsVerifiedExact: boolean;
}>;

export type TargetRecoveryStaleChoice =
  | null
  | Readonly<{ kind: "sync" }>
  | Readonly<{ kind: "fork"; newTargetId: string }>;

export type TargetRecoveryDecisionInput = Readonly<{
  registry: TargetRecoveryRegistryFacts | null;
  marker: TargetRecoveryMarkerFacts | null;
  target: TargetRecoveryObservationFacts;
  staleChoice: TargetRecoveryStaleChoice;
}>;

export type TargetRecoveryIntent = Readonly<{
  requirements: ReadonlyArray<TargetRecoveryRequirement>;
  projectionOverrides: ReadonlyArray<TargetRecoveryProjectionOverride>;
  detached: ReadonlyArray<TargetRecoveryDetachedBaseline>;
}>;

export type TargetRecoveryDecision =
  | Readonly<{
      kind: "current";
      targetId: string;
      generation: number;
    }>
  | Readonly<{
      kind: "dormant";
      targetId: string;
      generation: number;
    }>
  | Readonly<{
      kind: "repair-marker";
      targetId: string;
      generation: number;
    }>
  | Readonly<{
      kind: "reconcile-to-registry";
      targetId: string;
      generation: number;
      reason: "missing-marker" | "projection-drift";
    }>
  | Readonly<{
      kind: "choice-required";
      targetId: string;
      markerGeneration: number;
      registryGeneration: number;
      choices: readonly ["sync", "fork"];
    }>
  | Readonly<{
      kind: "sync-to-registry";
      targetId: string;
      fromGeneration: number;
      toGeneration: number;
    }>
  | Readonly<{
      kind: "recover-candidate";
      targetId: string;
      intent: TargetRecoveryIntent;
      requiresSourceConfirmation: true;
    }>
  | Readonly<{
      kind: "fork-candidate";
      targetId: string;
      intent: TargetRecoveryIntent;
      requiresSourceConfirmation: true;
    }>;

export type TargetRecoveryConflictReason =
  | "target-id-mismatch"
  | "marker-generation-ahead"
  | "registry-and-marker-unavailable"
  | "invalid-fork-target-id"
  | "inconsistent-facts";

export type TargetRecoveryConflict = ProductError<
  "TargetRecoveryConflict",
  Readonly<{
    reason: TargetRecoveryConflictReason;
    registryTargetId: string | null;
    markerTargetId: string | null;
  }>
>;

export type TargetRecoveryDecisionResult = Result<
  TargetRecoveryDecision,
  TargetRecoveryConflict
>;

export function decideTargetRecovery(
  input: TargetRecoveryDecisionInput
): TargetRecoveryDecisionResult {
  if (input.registry !== null) {
    return decideWithRegistry(input, input.registry);
  }

  if (input.marker === null) {
    return conflict(input, "registry-and-marker-unavailable");
  }
  if (!input.target.pathPresent) {
    return conflict(input, "inconsistent-facts");
  }

  return {
    ok: true,
    value: {
      kind: "recover-candidate",
      targetId: input.marker.targetId,
      intent: recoveryIntent(input.marker),
      requiresSourceConfirmation: true
    }
  };
}

function decideWithRegistry(
  input: TargetRecoveryDecisionInput,
  registry: TargetRecoveryRegistryFacts
): TargetRecoveryDecisionResult {
  if (
    input.marker !== null &&
    registry.targetId !== input.marker.targetId
  ) {
    return conflict(input, "target-id-mismatch");
  }

  const generation = classifyTargetGeneration({
    registryGeneration: registry.generation,
    targetPathPresent: input.target.pathPresent,
    markerGeneration: input.marker?.generation ?? null,
    projectionsVerifiedExact: input.target.projectionsVerifiedExact
  });

  switch (generation.status) {
    case "dormant":
      return {
        ok: true,
        value: {
          kind: "dormant",
          targetId: registry.targetId,
          generation: registry.generation
        }
      };
    case "missing-marker-repairable":
      return {
        ok: true,
        value: {
          kind: "repair-marker",
          targetId: registry.targetId,
          generation: registry.generation
        }
      };
    case "missing-marker-reconcile-required":
      return {
        ok: true,
        value: {
          kind: "reconcile-to-registry",
          targetId: registry.targetId,
          generation: registry.generation,
          reason: "missing-marker"
        }
      };
    case "ahead-anomaly":
      return conflict(input, "marker-generation-ahead");
    case "current":
      return input.target.projectionsVerifiedExact
        ? {
            ok: true,
            value: {
              kind: "current",
              targetId: registry.targetId,
              generation: registry.generation
            }
          }
        : {
            ok: true,
            value: {
              kind: "reconcile-to-registry",
              targetId: registry.targetId,
              generation: registry.generation,
              reason: "projection-drift"
            }
          };
    case "stale-behind": {
      if (input.marker === null) {
        return conflict(input, "inconsistent-facts");
      }
      if (input.staleChoice === null) {
        return {
          ok: true,
          value: {
            kind: "choice-required",
            targetId: registry.targetId,
            markerGeneration: input.marker.generation,
            registryGeneration: registry.generation,
            choices: ["sync", "fork"]
          }
        };
      }
      if (input.staleChoice.kind === "sync") {
        return {
          ok: true,
          value: {
            kind: "sync-to-registry",
            targetId: registry.targetId,
            fromGeneration: input.marker.generation,
            toGeneration: registry.generation
          }
        };
      }
      if (
        input.staleChoice.newTargetId === input.marker.targetId ||
        !isCanonicalUuidV4(input.staleChoice.newTargetId)
      ) {
        return conflict(input, "invalid-fork-target-id");
      }
      return {
        ok: true,
        value: {
          kind: "fork-candidate",
          targetId: input.staleChoice.newTargetId,
          intent: recoveryIntent(input.marker),
          requiresSourceConfirmation: true
        }
      };
    }
  }
}

function recoveryIntent(
  marker: TargetRecoveryMarkerFacts
): TargetRecoveryIntent {
  return {
    requirements: [...marker.requirements].sort((left, right) =>
      compareUtf8(
        `${left.kind}\0${left.coordinate}`,
        `${right.kind}\0${right.coordinate}`
      )
    ),
    projectionOverrides: [...marker.projectionOverrides].sort(
      (left, right) =>
        compareUtf8(
          left.packageCoordinate,
          right.packageCoordinate
        )
    ),
    detached: [...marker.detached].sort((left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
    )
  };
}

function isCanonicalUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function conflict(
  input: TargetRecoveryDecisionInput,
  reason: TargetRecoveryConflictReason
): TargetRecoveryDecisionResult {
  return {
    ok: false,
    error: productError("TargetRecoveryConflict", {
      reason,
      registryTargetId: input.registry?.targetId ?? null,
      markerTargetId: input.marker?.targetId ?? null
    })
  };
}
