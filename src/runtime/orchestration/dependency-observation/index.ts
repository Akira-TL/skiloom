import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  HostObservationStatus
} from "../../host-observation/index.js";
import type {
  MachineRegistry,
  RegistryDependencyObservation,
  RegistryTargetState
} from "../../registry/index.js";

export const SPECIAL_OBSERVATION_STATUSES = [
  "unknown",
  "satisfied",
  "missing",
  "incompatible",
  "blocked"
] as const satisfies ReadonlyArray<HostObservationStatus>;

export type SpecialObservationStatus =
  typeof SPECIAL_OBSERVATION_STATUSES[number];

export type SpecialObservationAction =
  | Readonly<{
      kind: "set";
      status: SpecialObservationStatus;
      note: string | null;
    }>
  | Readonly<{ kind: "clear" }>;

export type SpecialObservationResult = Readonly<{
  status: "recorded" | "updated" | "cleared" | "no-op";
  state: RegistryTargetState;
  observation: RegistryDependencyObservation | null;
}>;

export type SpecialObservationTargetUnavailable = ProductError<
  "SpecialObservationTargetUnavailable",
  Readonly<{ targetId: string }>
>;

export type SpecialObservationPackageUnavailable = ProductError<
  "SpecialObservationPackageUnavailable",
  Readonly<{
    targetId: string;
    packageCoordinate: string;
  }>
>;

export async function updateSpecialObservation(
  input: Readonly<{
    registry: MachineRegistry;
    targetId: string;
    packageCoordinate: string;
    name: string;
    action: SpecialObservationAction;
  }>
): Promise<Result<SpecialObservationResult, ProductError>> {
  const read = input.registry.readTargetState(input.targetId);
  if (!read.ok) {
    return read;
  }
  if (read.value === undefined) {
    return {
      ok: false,
      error: productError("SpecialObservationTargetUnavailable", {
        targetId: input.targetId
      })
    };
  }

  const state = read.value;
  const packageFact = state.resolvedPackages.find(
    (entry) =>
      entry.packageCoordinate === input.packageCoordinate
  );
  if (packageFact === undefined) {
    return {
      ok: false,
      error: productError("SpecialObservationPackageUnavailable", {
        targetId: input.targetId,
        packageCoordinate: input.packageCoordinate
      })
    };
  }

  const currentDigestByPackage = new Map(
    state.resolvedPackages.map((entry) => [
      entry.packageCoordinate,
      entry.contentDigest
    ])
  );
  const currentSpecial = state.dependencyObservations.filter(
    (entry) =>
      entry.kind === "special" &&
      currentDigestByPackage.get(entry.packageCoordinate) ===
        entry.packageContentDigest
  );
  const existing = currentSpecial.find(
    (entry) =>
      entry.packageCoordinate === input.packageCoordinate &&
      entry.name === input.name
  );

  if (input.action.kind === "clear") {
    if (existing === undefined) {
      return {
        ok: true,
        value: {
          status: "no-op",
          state,
          observation: null
        }
      };
    }
    const replaced = input.registry.replaceDependencyObservations(
      state.targetId,
      "special",
      currentSpecial.filter(
        (entry) =>
          entry.packageCoordinate !== input.packageCoordinate ||
          entry.name !== input.name
      )
    );
    if (!replaced.ok) {
      return replaced;
    }
    return {
      ok: true,
      value: {
        status: "cleared",
        state: replaced.value,
        observation: null
      }
    };
  }

  const observation: RegistryDependencyObservation = {
    packageCoordinate: input.packageCoordinate,
    packageContentDigest: packageFact.contentDigest,
    kind: "special",
    name: input.name,
    status: input.action.status,
    detectedVersion: null,
    location: null,
    note: input.action.note
  };

  if (
    existing !== undefined &&
    sameSpecialObservation(existing, observation)
  ) {
    return {
      ok: true,
      value: {
        status: "no-op",
        state,
        observation: existing
      }
    };
  }

  const next = currentSpecial.filter(
    (entry) =>
      entry.packageCoordinate !== input.packageCoordinate ||
      entry.name !== input.name
  );
  next.push(observation);
  next.sort(compareObservations);

  const replaced = input.registry.replaceDependencyObservations(
    state.targetId,
    "special",
    next
  );
  if (!replaced.ok) {
    return replaced;
  }
  return {
    ok: true,
    value: {
      status: existing === undefined ? "recorded" : "updated",
      state: replaced.value,
      observation
    }
  };
}

function sameSpecialObservation(
  left: RegistryDependencyObservation,
  right: RegistryDependencyObservation
): boolean {
  return (
    left.packageCoordinate === right.packageCoordinate &&
    left.packageContentDigest === right.packageContentDigest &&
    left.kind === right.kind &&
    left.name === right.name &&
    left.status === right.status &&
    left.detectedVersion === right.detectedVersion &&
    left.location === right.location &&
    left.note === right.note
  );
}

function compareObservations(
  left: RegistryDependencyObservation,
  right: RegistryDependencyObservation
): number {
  return Buffer.compare(
    Buffer.from(
      [
        left.packageCoordinate,
        left.kind,
        left.name
      ].join("\0"),
      "utf8"
    ),
    Buffer.from(
      [
        right.packageCoordinate,
        right.kind,
        right.name
      ].join("\0"),
      "utf8"
    )
  );
}
