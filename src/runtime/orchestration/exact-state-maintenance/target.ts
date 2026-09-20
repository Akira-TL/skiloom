import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  TargetPlan
} from "../../../domain/target/index.js";
import type {
  TargetOwnedProjection,
  TargetPathObservation
} from "../../../domain/target/preflight.js";
import type {
  SkiloomHomePaths
} from "../../home.js";
import type {
  RegistryTargetState
} from "../../registry/index.js";
import {
  readTargetStateMarkerFile
} from "../../target-state-marker.js";
import {
  verifyManagedProjection
} from "../../target-projection/index.js";
import {
  buildMarkerFacts
} from "../lifecycle/apply.js";

export function currentOwnedProjections(
  state: RegistryTargetState,
  plan: TargetPlan
): Result<ReadonlyArray<TargetOwnedProjection>, ProductError> {
  const plannedByPackage = new Map(
    plan.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );
  if (plannedByPackage.size !== state.projections.length) {
    return unavailable(
      state.targetId,
      "projection-count-mismatch",
      state.targetId
    );
  }

  const result: TargetOwnedProjection[] = [];
  for (const registryProjection of state.projections) {
    const projection = plannedByPackage.get(
      registryProjection.packageCoordinate
    );
    if (projection === undefined) {
      return unavailable(
        state.targetId,
        "projection-not-found",
        registryProjection.packageCoordinate
      );
    }
    result.push({
      projection,
      ownership: registryProjection.ownership,
      materialization: registryProjection.materialization
    });
  }
  return { ok: true, value: result };
}

export async function observeCurrentTarget(
  home: SkiloomHomePaths,
  targetRoot: string,
  current: ReadonlyArray<TargetOwnedProjection>
): Promise<Result<ReadonlyArray<TargetPathObservation>, ProductError>> {
  const observations: TargetPathObservation[] = [];

  for (const owned of current) {
    const activationPath = join(
      targetRoot,
      owned.projection.activationName
    );
    if (owned.ownership === "detached") {
      if (await pathExists(activationPath)) {
        observations.push({
          activationName: owned.projection.activationName,
          kind: "existing"
        });
      }
      continue;
    }

    const verified = await verifyManagedProjection({
      home,
      targetRoot,
      expected: {
        projection: owned.projection,
        materialization: owned.materialization
      }
    });
    if (verified.ok) {
      observations.push({
        activationName: owned.projection.activationName,
        kind: "managed",
        packageCoordinate:
          owned.projection.packageCoordinate,
        contentDigest: owned.projection.contentDigest,
        materialization: owned.materialization,
        expectedViewMatches: true
      });
      continue;
    }
    if (verified.error.code === "ManagedProjectionMissing") {
      continue;
    }
    return verified;
  }

  return { ok: true, value: observations };
}

export async function acceptedMarkerCurrent(
  targetRoot: string,
  state: RegistryTargetState,
  plan: TargetPlan
): Promise<Result<boolean, ProductError>> {
  const read = await readTargetStateMarkerFile(targetRoot);
  if (!read.ok) {
    if (read.error.code === "TargetStateMarkerReadFailed") {
      return read;
    }
    return { ok: true, value: false };
  }
  if (read.value === null) {
    return { ok: true, value: false };
  }
  return {
    ok: true,
    value:
      JSON.stringify(read.value) ===
      JSON.stringify(buildMarkerFacts(state, plan))
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function unavailable(
  targetId: string,
  reason:
    | "projection-count-mismatch"
    | "projection-not-found",
  subject: string
): Result<never, ProductError> {
  return {
    ok: false,
    error: productError("ExactStateTargetUnavailable", {
      targetId,
      reason,
      subject
    })
  };
}
