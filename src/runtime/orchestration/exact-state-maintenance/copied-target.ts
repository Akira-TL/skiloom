import {
  parsePackageCoordinate
} from "../../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  TargetProjection,
  TargetProjectionTransform
} from "../../../domain/target/index.js";
import type {
  TargetOwnedProjection
} from "../../../domain/target/preflight.js";
import type {
  TargetRecoveryMarkerFacts
} from "../../../domain/target/recovery.js";
import type {
  TargetStateMarkerDocument
} from "../../../domain/target/state-marker.js";
import type {
  RegistryTargetState
} from "../../registry/index.js";
import {
  readTargetStateMarkerDocumentFile
} from "../../target-state-marker.js";

export type ExactTargetMarkerContext =
  | Readonly<{
      kind: "missing-or-current";
      document: TargetStateMarkerDocument | null;
    }>
  | Readonly<{
      kind: "lagging-v2";
      document: TargetStateMarkerDocument;
      currentProjections: ReadonlyArray<TargetOwnedProjection>;
    }>;

export async function readExactTargetMarkerContext(
  targetRoot: string,
  state: RegistryTargetState
): Promise<Result<ExactTargetMarkerContext, ProductError>> {
  const read = await readTargetStateMarkerDocumentFile(
    targetRoot
  );
  if (!read.ok) {
    return read;
  }
  const document = read.value;
  if (document === null) {
    return {
      ok: true,
      value: {
        kind: "missing-or-current",
        document: null
      }
    };
  }

  if (document.facts.targetId !== state.targetId) {
    return unavailable(
      state.targetId,
      "target-id-mismatch",
      document.facts.targetId
    );
  }
  if (document.facts.generation > state.generation) {
    return unavailable(
      state.targetId,
      "marker-generation-ahead",
      String(document.facts.generation)
    );
  }
  if (document.facts.generation === state.generation) {
    return {
      ok: true,
      value: {
        kind: "missing-or-current",
        document
      }
    };
  }

  if (document.format === "SKILOOM-STATE-V1") {
    return unavailable(
      state.targetId,
      "managed-baseline-required",
      targetRoot
    );
  }

  const currentProjections =
    ownedProjectionsFromMarker(document.facts);
  if (!currentProjections.ok) {
    return currentProjections;
  }
  return {
    ok: true,
    value: {
      kind: "lagging-v2",
      document,
      currentProjections: currentProjections.value
    }
  };
}

function ownedProjectionsFromMarker(
  marker: TargetRecoveryMarkerFacts
): Result<ReadonlyArray<TargetOwnedProjection>, ProductError> {
  const overrides = new Map(
    marker.projectionOverrides.map((entry) => [
      entry.packageCoordinate,
      entry.activationName
    ])
  );
  const owned: TargetOwnedProjection[] = [];

  for (const baseline of marker.managed) {
    const projection = managedProjection(
      marker.targetId,
      baseline
    );
    if (!projection.ok) {
      return projection;
    }
    owned.push({
      projection: projection.value,
      ownership: "managed",
      materialization: baseline.materialization
    });
  }

  for (const baseline of marker.detached) {
    const coordinate = parsePackageCoordinate(
      baseline.packageCoordinate
    );
    if (!coordinate.ok) {
      return {
        ok: false,
        error: productError("ExactStateTargetUnavailable", {
          targetId: marker.targetId,
          reason: "invalid-marker-package",
          subject: baseline.packageCoordinate
        })
      };
    }
    owned.push({
      projection: {
        packageCoordinate: baseline.packageCoordinate,
        packageRoot: baseline.packageRoot,
        contentDigest: baseline.contentDigest,
        activationName:
          overrides.get(baseline.packageCoordinate) ??
          coordinate.value.packageName,
        projectionKind: "direct",
        transform: null
      },
      ownership: "detached",
      materialization: "copy"
    });
  }

  return {
    ok: true,
    value: owned.sort((left, right) =>
      compareUtf8(
        left.projection.activationName,
        right.projection.activationName
      )
    )
  };
}

function managedProjection(
  targetId: string,
  baseline: TargetRecoveryMarkerFacts["managed"][number]
): Result<TargetProjection, ProductError> {
  let transform: TargetProjectionTransform | null = null;
  if (baseline.transformJson !== null) {
    try {
      transform = JSON.parse(
        baseline.transformJson
      ) as TargetProjectionTransform;
    } catch {
      return {
        ok: false,
        error: productError("ExactStateTargetUnavailable", {
          targetId,
          reason: "invalid-managed-transform",
          subject: baseline.packageCoordinate
        })
      };
    }
  }

  return {
    ok: true,
    value: {
      packageCoordinate: baseline.packageCoordinate,
      packageRoot: baseline.packageRoot,
      contentDigest: baseline.contentDigest,
      activationName: baseline.activationName,
      projectionKind:
        transform === null ? "direct" : "transformed-copy",
      transform
    }
  };
}

function unavailable(
  targetId: string,
  reason:
    | "target-id-mismatch"
    | "marker-generation-ahead"
    | "managed-baseline-required",
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

function compareUtf8(
  left: string,
  right: string
): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
