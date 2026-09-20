import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ProductError,
  Result
} from "../../domain/errors/index.js";
import type {
  TargetRecoveryDecision
} from "../../domain/target/recovery.js";
import type {
  RegistryDependencyObservation,
  RegistryTargetState
} from "../registry/index.js";
import {
  readPendingOperations,
  readTargetRows
} from "../registry/read.js";
import {
  verifyPackageStoreEntry
} from "../store.js";
import {
  verifyManagedProjection
} from "../target-projection/index.js";
import {
  readTargetStateMarkerFile,
  TARGET_STATE_MARKER_FILENAME
} from "../target-state-marker.js";
import {
  inspectTargetRecovery
} from "../target-state-recovery.js";
import type {
  SkiloomHomePaths
} from "../home.js";
import {
  acceptedTargetPlan
} from "../orchestration/lifecycle/recovery/target.js";
import {
  inspectRegistryConnection,
  targetIdsAtPath
} from "./registry.js";

export type DoctorRecommendation =
  "sync" | "repair" | "recover" | "rebind" | null;

export type DoctorSeverity =
  "info" | "warning" | "error";

export type DoctorDiagnosticCode =
  | "TargetUnregistered"
  | "RegistryMissing"
  | "RegistryIntegrityFailed"
  | "RegistrySchemaMismatch"
  | "PendingOperation"
  | "TargetLocationMismatch"
  | "TargetPathMissing"
  | "AcceptedStateInvalid"
  | "StoreEntryMissing"
  | "StoreEntryCorrupt"
  | "ManagedProjectionMissing"
  | "ManagedProjectionDrift"
  | "DetachedOverridePresent"
  | "DetachedBindingBroken"
  | "ForeignTargetEntry"
  | "MarkerMissing"
  | "MarkerInvalid"
  | "MarkerStale"
  | "MarkerConflict"
  | "MarkerReconcileRequired";

export type DoctorDiagnostic = Readonly<{
  code: DoctorDiagnosticCode;
  severity: DoctorSeverity;
  subject: string | null;
  recommendation: DoctorRecommendation;
  facts: Readonly<Record<string, unknown>>;
}>;

export type DoctorInspection = Readonly<{
  status: "healthy" | "attention" | "unregistered";
  targetId: string | null;
  generation: number | null;
  diagnostics: ReadonlyArray<DoctorDiagnostic>;
  dependencyObservations:
    ReadonlyArray<RegistryDependencyObservation>;
}>;

export type InspectDoctorTargetInput = Readonly<{
  home: SkiloomHomePaths;
  targetRoot: string;
}>;

export async function inspectDoctorTarget(
  input: InspectDoctorTargetInput
): Promise<Result<DoctorInspection, ProductError>> {
  const targetRoot = resolve(input.targetRoot);
  const marker = await readTargetStateMarkerFile(targetRoot);
  const markerTargetId =
    marker.ok ? marker.value?.targetId ?? null : null;
  const markerPresent =
    marker.ok ? marker.value !== null : true;

  if (!(await pathExists(input.home.registryPath))) {
    const diagnostics = marker.ok
      ? []
      : [
          diagnostic(
            "MarkerInvalid",
            "error",
            null,
            null,
            { errorCode: marker.error.code }
          )
        ];
    diagnostics.push(
      markerPresent
        ? diagnostic(
            "RegistryMissing",
            "error",
            null,
            marker.ok ? "recover" : null,
            {}
          )
        : diagnostic(
            "TargetUnregistered",
            "info",
            null,
            null,
            {}
          )
    );
    return inspection(
      null,
      null,
      diagnostics,
      []
    );
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(input.home.registryPath, {
      readOnly: true
    });
  } catch {
    return inspection(
      markerTargetId,
      null,
      [
        diagnostic(
          "RegistryIntegrityFailed",
          "error",
          null,
          "recover",
          { reason: "open-failed" }
        )
      ],
      []
    );
  }

  try {
    const diagnostics: DoctorDiagnostic[] = [];
    for (const issue of inspectRegistryConnection(database)) {
      diagnostics.push(
        issue.kind === "schema-mismatch"
          ? diagnostic(
              "RegistrySchemaMismatch",
              "error",
              null,
              null,
              {
                actualVersion: issue.actualVersion,
                currentVersion: issue.currentVersion
              }
            )
          : diagnostic(
              "RegistryIntegrityFailed",
              "error",
              null,
              "recover",
              { reason: issue.reason }
            )
      );
    }

    let locationTargetIds: ReadonlyArray<string> = [];
    try {
      locationTargetIds =
        targetIdsAtPath(database, targetRoot);
    } catch {
      diagnostics.push(
        diagnostic(
          "RegistryIntegrityFailed",
          "error",
          null,
          "recover",
          { reason: "target-lookup-failed" }
        )
      );
    }
    if (locationTargetIds.length > 1) {
      diagnostics.push(
        diagnostic(
          "RegistryIntegrityFailed",
          "error",
          null,
          "recover",
          {
            reason: "ambiguous-target-location",
            targetCount: locationTargetIds.length
          }
        )
      );
    }
    const targetId =
      locationTargetIds[0] ?? markerTargetId;
    if (targetId === null) {
      if (!marker.ok) {
        diagnostics.push(
          diagnostic(
            "MarkerInvalid",
            "error",
            null,
            null,
            { errorCode: marker.error.code }
          )
        );
      }
      diagnostics.push(
        diagnostic(
          "TargetUnregistered",
          "info",
          null,
          null,
          {}
        )
      );
      return inspection(
        null,
        null,
        diagnostics,
        []
      );
    }

    let state: RegistryTargetState | undefined;
    let stateReadFailed = false;
    try {
      state = readTargetRows(database, targetId);
    } catch {
      stateReadFailed = true;
      diagnostics.push(
        diagnostic(
          "RegistryIntegrityFailed",
          "error",
          null,
          "recover",
          { reason: "state-read-failed" }
        )
      );
    }
    if (state === undefined) {
      if (!stateReadFailed) {
        diagnostics.push(
          diagnostic(
            "RegistryMissing",
            "error",
            null,
            "recover",
            {}
          )
        );
      }
      return inspection(
        targetId,
        null,
        diagnostics,
        []
      );
    }

    let pendingOperations:
      ReturnType<typeof readPendingOperations> = [];
    try {
      pendingOperations =
        readPendingOperations(database);
    } catch {
      diagnostics.push(
        diagnostic(
          "RegistryIntegrityFailed",
          "error",
          null,
          "recover",
          { reason: "pending-read-failed" }
        )
      );
    }
    for (const pending of pendingOperations) {
      if (pending.targetId === state.targetId) {
        diagnostics.push(
          diagnostic(
            "PendingOperation",
            "warning",
            pending.operationId,
            "recover",
            {
              baseGeneration: pending.baseGeneration,
              nextGeneration: pending.nextGeneration
            }
          )
        );
      }
    }

    const locationMatches = state.locations.some(
      (location) =>
        resolve(location.path) === targetRoot
    );
    if (!locationMatches) {
      diagnostics.push(
        diagnostic(
          "TargetLocationMismatch",
          "error",
          null,
          "recover",
          {}
        )
      );
    }

    const targetPathPresent = await pathExists(targetRoot);
    if (!targetPathPresent) {
      diagnostics.push(
        diagnostic(
          "TargetPathMissing",
          "warning",
          null,
          "sync",
          {}
        )
      );
    }

    const plan = acceptedTargetPlan(state);
    let projectionsVerifiedExact = locationMatches;
    const storeHealthy = new Map<string, boolean>();

    for (const packageFact of state.resolvedPackages) {
      const verified = await verifyPackageStoreEntry(
        input.home,
        packageFact.contentDigest
      );
      const healthy = verified.ok;
      storeHealthy.set(
        packageFact.packageCoordinate,
        healthy
      );
      if (!healthy) {
        const missing =
          verified.error.code === "StoreEntryNotFound";
        diagnostics.push(
          diagnostic(
            missing
              ? "StoreEntryMissing"
              : "StoreEntryCorrupt",
            "error",
            packageFact.packageCoordinate,
            "repair",
            {
              storeError: verified.error.code
            }
          )
        );
        projectionsVerifiedExact = false;
      }
    }

    if (!plan.ok) {
      diagnostics.push(
        diagnostic(
          "AcceptedStateInvalid",
          "error",
          null,
          "recover",
          {
            errorCode: plan.error.code
          }
        )
      );
      projectionsVerifiedExact = false;
    } else {
      const planByPackage = new Map(
        plan.value.projections.map((projection) => [
          projection.packageCoordinate,
          projection
        ])
      );
      for (const projection of state.projections) {
        const planned = planByPackage.get(
          projection.packageCoordinate
        );
        if (planned === undefined) {
          diagnostics.push(
            diagnostic(
              "AcceptedStateInvalid",
              "error",
              projection.packageCoordinate,
              "recover",
              { reason: "projection-not-planned" }
            )
          );
          projectionsVerifiedExact = false;
          continue;
        }

        if (projection.ownership === "detached") {
          const exists = await pathExists(
            join(targetRoot, projection.activationName)
          );
          diagnostics.push(
            diagnostic(
              exists
                ? "DetachedOverridePresent"
                : "DetachedBindingBroken",
              exists ? "info" : "warning",
              projection.packageCoordinate,
              exists ? null : "rebind",
              {
                activationName:
                  projection.activationName
              }
            )
          );
          if (!exists) {
            projectionsVerifiedExact = false;
          }
          continue;
        }

        if (
          storeHealthy.get(
            projection.packageCoordinate
          ) === false
        ) {
          projectionsVerifiedExact = false;
          continue;
        }

        const verified = await verifyManagedProjection({
          home: input.home,
          targetRoot,
          expected: {
            projection: planned,
            materialization:
              projection.materialization
          }
        });
        if (verified.ok) {
          continue;
        }

        const missing =
          verified.error.code ===
          "ManagedProjectionMissing";
        diagnostics.push(
          diagnostic(
            missing
              ? "ManagedProjectionMissing"
              : "ManagedProjectionDrift",
            missing ? "warning" : "error",
            projection.packageCoordinate,
            missing ? "sync" : "repair",
            {
              activationName:
                projection.activationName,
              projectionError:
                verified.error.code
            }
          )
        );
        projectionsVerifiedExact = false;
      }
    }

    await inspectForeignEntries(
      targetRoot,
      state,
      diagnostics
    );

    const recovery = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: targetPathPresent,
        projectionsVerifiedExact
      },
      staleChoice: null
    });
    if (!recovery.ok) {
      diagnostics.push(
        diagnostic(
          "MarkerConflict",
          "error",
          null,
          "recover",
          {
            errorCode: recovery.error.code,
            reason:
              "facts" in recovery.error &&
              "reason" in recovery.error.facts
                ? recovery.error.facts.reason
                : null
          }
        )
      );
    } else {
      addMarkerDiagnostics(
        recovery.value.markerStatus,
        recovery.value.decision,
        diagnostics
      );
    }

    return inspection(
      state.targetId,
      state.generation,
      diagnostics,
      state.dependencyObservations
    );
  } finally {
    database.close();
  }
}

async function inspectForeignEntries(
  targetRoot: string,
  state: RegistryTargetState,
  diagnostics: DoctorDiagnostic[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(targetRoot, {
      withFileTypes: true
    });
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  const known = new Set(
    state.projections.map(
      (projection) => projection.activationName
    )
  );
  for (const entry of entries) {
    if (
      entry.name === TARGET_STATE_MARKER_FILENAME ||
      entry.name.startsWith(".skiloom-stage-") ||
      known.has(entry.name)
    ) {
      continue;
    }
    diagnostics.push(
      diagnostic(
        "ForeignTargetEntry",
        "info",
        entry.name,
        null,
        {
          kind: entry.isDirectory()
            ? "directory"
            : entry.isSymbolicLink()
              ? "symlink"
              : entry.isFile()
                ? "file"
                : "other"
        }
      )
    );
  }
}

function addMarkerDiagnostics(
  markerStatus: "valid" | "missing" | "invalid",
  decision: TargetRecoveryDecision,
  diagnostics: DoctorDiagnostic[]
): void {
  if (markerStatus === "invalid") {
    diagnostics.push(
      diagnostic(
        "MarkerInvalid",
        "warning",
        null,
        "repair",
        {}
      )
    );
  }

  switch (decision.kind) {
    case "current":
      return;
    case "repair-marker":
      if (markerStatus === "missing") {
        diagnostics.push(
          diagnostic(
            "MarkerMissing",
            "warning",
            null,
            "repair",
            {}
          )
        );
      }
      return;
    case "choice-required":
      diagnostics.push(
        diagnostic(
          "MarkerStale",
          "warning",
          null,
          "sync",
          {
            markerGeneration:
              decision.markerGeneration,
            registryGeneration:
              decision.registryGeneration
          }
        )
      );
      return;
    case "reconcile-to-registry":
      diagnostics.push(
        diagnostic(
          "MarkerReconcileRequired",
          "warning",
          null,
          "repair",
          { reason: decision.reason }
        )
      );
      return;
    case "dormant":
      return;
    case "sync-to-registry":
      diagnostics.push(
        diagnostic(
          "MarkerStale",
          "warning",
          null,
          "sync",
          {
            fromGeneration:
              decision.fromGeneration,
            toGeneration:
              decision.toGeneration
          }
        )
      );
      return;
    case "recover-candidate":
    case "fork-candidate":
      diagnostics.push(
        diagnostic(
          "MarkerConflict",
          "error",
          null,
          "recover",
          { decision: decision.kind }
        )
      );
      return;
  }
}

function inspection(
  targetId: string | null,
  generation: number | null,
  diagnostics: ReadonlyArray<DoctorDiagnostic>,
  dependencyObservations:
    ReadonlyArray<RegistryDependencyObservation>
): Result<DoctorInspection, ProductError> {
  const hasAttention = diagnostics.some(
    (entry) =>
      entry.severity === "warning" ||
      entry.severity === "error"
  );
  return {
    ok: true,
    value: {
      status:
        targetId === null
          ? hasAttention
            ? "attention"
            : "unregistered"
          : hasAttention
            ? "attention"
            : "healthy",
      targetId,
      generation,
      diagnostics: [...diagnostics].sort(compareDiagnostics),
      dependencyObservations
    }
  };
}

function diagnostic(
  code: DoctorDiagnosticCode,
  severity: DoctorSeverity,
  subject: string | null,
  recommendation: DoctorRecommendation,
  facts: Readonly<Record<string, unknown>>
): DoctorDiagnostic {
  return {
    code,
    severity,
    subject,
    recommendation,
    facts
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function compareDiagnostics(
  left: DoctorDiagnostic,
  right: DoctorDiagnostic
): number {
  return compareUtf8(
    [
      left.severity,
      left.code,
      left.subject ?? ""
    ].join("\0"),
    [
      right.severity,
      right.code,
      right.subject ?? ""
    ].join("\0")
  );
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
