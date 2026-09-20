import {
  productError,
  type ProductError,
  type Result
} from "../domain/errors/index.js";
import {
  decideTargetRecovery,
  type TargetRecoveryDecision,
  type TargetRecoveryObservationFacts,
  type TargetRecoveryStaleChoice,
  type TargetRecoveryMarkerFacts,
  type TargetRecoveryManagedBaseline,
  type TargetRecoveryConflict
} from "../domain/target/recovery.js";
import {
  parseTargetStateMarker,
  writeTargetStateMarker,
  type TargetStateMarkerParseError
} from "../domain/target/state-marker.js";
import type {
  RegistryTargetState
} from "./registry/index.js";
import {
  readTargetStateMarkerFile,
  writeTargetStateMarkerFile,
  type TargetStateMarkerReadFailed,
  type TargetStateMarkerWriteFailed
} from "./target-state-marker.js";

export type InvalidRegistryTargetMarkerFacts = ProductError<
  "InvalidRegistryTargetMarkerFacts",
  Readonly<{
    targetId: string;
    reason: string;
    subject: string | null;
  }>
>;

export type TargetStateMarkerRepairNotAllowed = ProductError<
  "TargetStateMarkerRepairNotAllowed",
  Readonly<{
    targetId: string;
    decisionKind: TargetRecoveryDecision["kind"];
  }>
>;

export type TargetRecoveryMarkerStatus =
  | "valid"
  | "missing"
  | "invalid";

export type InspectedTargetRecovery = Readonly<{
  markerStatus: TargetRecoveryMarkerStatus;
  markerError: TargetStateMarkerParseError | null;
  decision: TargetRecoveryDecision;
}>;

export type InspectTargetRecoveryError =
  | TargetRecoveryConflict
  | TargetStateMarkerParseError
  | TargetStateMarkerReadFailed;

export type InspectTargetRecoveryInput = Readonly<{
  targetRoot: string;
  registryState: RegistryTargetState | null;
  target: TargetRecoveryObservationFacts;
  staleChoice: TargetRecoveryStaleChoice;
}>;

export async function inspectTargetRecovery(
  input: InspectTargetRecoveryInput
): Promise<
  Result<InspectedTargetRecovery, InspectTargetRecoveryError>
> {
  const markerRead = await readTargetStateMarkerFile(
    input.targetRoot
  );

  let marker: TargetRecoveryMarkerFacts | null;
  let markerStatus: TargetRecoveryMarkerStatus;
  let markerError: TargetStateMarkerParseError | null = null;

  if (!markerRead.ok) {
    if (markerRead.error.code === "TargetStateMarkerReadFailed") {
      return markerRead;
    }
    if (input.registryState === null) {
      return markerRead;
    }
    marker = null;
    markerStatus = "invalid";
    markerError = markerRead.error;
  } else {
    marker = markerRead.value;
    markerStatus = marker === null ? "missing" : "valid";
  }

  const decision = decideTargetRecovery({
    registry:
      input.registryState === null
        ? null
        : {
            targetId: input.registryState.targetId,
            generation: input.registryState.generation
          },
    marker,
    target: input.target,
    staleChoice: input.staleChoice
  });
  if (!decision.ok) {
    return decision;
  }

  return {
    ok: true,
    value: {
      markerStatus,
      markerError,
      decision: decision.value
    }
  };
}

export function targetStateMarkerFactsFromRegistryState(
  state: RegistryTargetState
): Result<TargetRecoveryMarkerFacts, InvalidRegistryTargetMarkerFacts> {
  const packageByCoordinate = new Map(
    state.resolvedPackages.map((packageFact) => [
      packageFact.packageCoordinate,
      packageFact
    ])
  );
  const managed: TargetRecoveryManagedBaseline[] = [];
  for (const projection of state.projections) {
    if (projection.ownership !== "managed") {
      continue;
    }
    const packageFact = packageByCoordinate.get(
      projection.packageCoordinate
    );
    if (packageFact === undefined) {
      return {
        ok: false,
        error: productError("InvalidRegistryTargetMarkerFacts", {
          targetId: state.targetId,
          reason: "managed-package-missing",
          subject: projection.packageCoordinate
        })
      };
    }
    managed.push({
      packageCoordinate: projection.packageCoordinate,
      activationName: projection.activationName,
      materialization: projection.materialization,
      packageRoot: packageFact.packageRoot,
      contentDigest: packageFact.contentDigest,
      transformJson: projection.transformJson
    });
  }

  const candidate: TargetRecoveryMarkerFacts = {
    targetId: state.targetId,
    generation: state.generation,
    requirements: state.directRequirements,
    projectionOverrides: state.projections.map((projection) => ({
      packageCoordinate: projection.packageCoordinate,
      activationName: projection.activationName
    })),
    managed,
    detached: state.detachedBaselines.map((baseline) =>
      baseline.sourceKind === "git"
        ? {
            packageCoordinate: baseline.packageCoordinate,
            sourceKind: "git" as const,
            requestedRef: baseline.requestedRef,
            exactCommit: baseline.exactCommit,
            packageRoot: baseline.packageRoot,
            contentDigest: baseline.contentDigest
          }
        : {
            packageCoordinate: baseline.packageCoordinate,
            sourceKind: "github-release" as const,
            version: baseline.version,
            actualTag: baseline.actualTag,
            exactCommit: baseline.exactCommit,
            packageRoot: baseline.packageRoot,
            contentDigest: baseline.contentDigest
          }
    )
  };

  const parsed = parseTargetStateMarker(
    writeTargetStateMarker(candidate)
  );
  if (!parsed.ok) {
    return {
      ok: false,
      error: productError("InvalidRegistryTargetMarkerFacts", {
        targetId: state.targetId,
        reason: parsed.error.code,
        subject:
          parsed.error.code === "InvalidTargetState"
            ? parsed.error.facts.path
            : parsed.error.facts.format
      })
    };
  }
  return parsed;
}

export type RepairTargetStateMarkerFromRegistryError =
  | InspectTargetRecoveryError
  | InvalidRegistryTargetMarkerFacts
  | TargetStateMarkerRepairNotAllowed
  | TargetStateMarkerWriteFailed;

export async function repairTargetStateMarkerFromRegistry(
  input: Readonly<{
    targetRoot: string;
    registryState: RegistryTargetState;
    target: TargetRecoveryObservationFacts;
  }>
): Promise<
  Result<
    TargetRecoveryMarkerFacts,
    RepairTargetStateMarkerFromRegistryError
  >
> {
  const inspected = await inspectTargetRecovery({
    targetRoot: input.targetRoot,
    registryState: input.registryState,
    target: input.target,
    staleChoice: null
  });
  if (!inspected.ok) {
    return inspected;
  }
  if (inspected.value.decision.kind !== "repair-marker") {
    return {
      ok: false,
      error: productError("TargetStateMarkerRepairNotAllowed", {
        targetId: input.registryState.targetId,
        decisionKind: inspected.value.decision.kind
      })
    };
  }

  const facts = targetStateMarkerFactsFromRegistryState(
    input.registryState
  );
  if (!facts.ok) {
    return facts;
  }
  const written = await writeTargetStateMarkerFile(
    input.targetRoot,
    facts.value
  );
  if (!written.ok) {
    return written;
  }
  return facts;
}
