import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import {
  writeExactExportPackage,
  type ExactExportFileFrame,
  type ExactExportManifest,
  type ExactExportParseError
} from "../../domain/export-package/index.js";
import type {
  TargetPlanError
} from "../../domain/target/index.js";
import {
  writeTargetStateMarker
} from "../../domain/target/state-marker.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../home.js";
import type {
  MachineRegistry,
  RegistryTargetState
} from "../registry/index.js";
import {
  verifyPackageStoreEntry,
  type PackageStoreError
} from "../store.js";
import {
  inspectTargetRecovery,
  targetStateMarkerFactsFromRegistryState,
  type InspectTargetRecoveryError,
  type InvalidRegistryTargetMarkerFacts
} from "../target-state-recovery.js";
import {
  readTargetStateMarkerFile
} from "../target-state-marker.js";
import {
  verifyManagedProjection,
  type ManagedProjectionVerificationError
} from "../target-projection/index.js";
import {
  acceptedTargetPlan
} from "../orchestration/lifecycle/recovery/target.js";
import type {
  InterruptedLifecycleRecoveryConflict
} from "../orchestration/lifecycle/recovery/index.js";
import {
  writeExactExportFile,
  type ExactExportFileWriteError
} from "./file.js";

export type ExactExportTargetNotFound = ProductError<
  "ExactExportTargetNotFound",
  Readonly<{ targetId: string }>
>;

export type ExactExportTargetNotReconciled = ProductError<
  "ExactExportTargetNotReconciled",
  Readonly<{
    targetId: string;
    reason:
      | "target-missing"
      | "pending-operation"
      | "marker-not-current";
    subject: string | null;
  }>
>;

export type ExactExportWarning = ProductError<
  "DetachedOverrideBytesOmitted",
  Readonly<{
    packageCoordinate: string;
    activationName: string;
  }>
>;

export type ExportManagedDependenciesError =
  | OperationLockLost
  | ExactExportTargetNotFound
  | ExactExportTargetNotReconciled
  | InspectTargetRecoveryError
  | InvalidRegistryTargetMarkerFacts
  | TargetPlanError
  | InterruptedLifecycleRecoveryConflict
  | ManagedProjectionVerificationError
  | PackageStoreError
  | ExactExportParseError
  | ExactExportFileWriteError;

export type ExportManagedDependenciesResult = Readonly<{
  destinationPath: string;
  manifest: ExactExportManifest;
  warnings: ReadonlyArray<ExactExportWarning>;
}>;

export async function exportManagedDependencies(
  input: Readonly<{
    home: SkiloomHomePaths;
    targetId: string;
    targetRoot: string;
    destinationPath: string;
    lock: OperationLockSession;
    registry: MachineRegistry;
  }>
): Promise<
  Result<
    ExportManagedDependenciesResult,
    ExportManagedDependenciesError
  >
> {
  const initiallyHeld = input.lock.checkHeld();
  if (!initiallyHeld.ok) {
    return initiallyHeld;
  }

  const pending = input.registry.readPendingOperations();
  if (!pending.ok) {
    return pending;
  }
  const pendingForTarget = pending.value.find(
    (entry) => entry.targetId === input.targetId
  );
  if (pendingForTarget !== undefined) {
    return notReconciled(
      input.targetId,
      "pending-operation",
      pendingForTarget.operationId
    );
  }

  const stateRead = input.registry.readTargetState(
    input.targetId
  );
  if (!stateRead.ok) {
    return stateRead;
  }
  if (stateRead.value === undefined) {
    return {
      ok: false,
      error: productError("ExactExportTargetNotFound", {
        targetId: input.targetId
      })
    };
  }
  const state = stateRead.value;
  const targetRoot = resolve(input.targetRoot);
  if (!(await targetDirectoryExists(targetRoot))) {
    return notReconciled(
      input.targetId,
      "target-missing",
      targetRoot
    );
  }

  const plan = acceptedTargetPlan(state);
  if (!plan.ok) {
    return plan;
  }
  const planByPackage = new Map(
    plan.value.projections.map((projection) => [
      projection.packageCoordinate,
      projection
    ])
  );

  for (const registryProjection of [...state.projections].sort(
    (left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
  )) {
    if (registryProjection.ownership === "detached") {
      continue;
    }
    const projection = planByPackage.get(
      registryProjection.packageCoordinate
    );
    if (projection === undefined) {
      return notReconciled(
        input.targetId,
        "marker-not-current",
        registryProjection.packageCoordinate
      );
    }
    const verified = await verifyManagedProjection({
      home: input.home,
      targetRoot,
      expected: {
        projection,
        materialization:
          registryProjection.materialization
      }
    });
    if (!verified.ok) {
      return verified;
    }

    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }
  }

  const recovery = await inspectTargetRecovery({
    targetRoot,
    registryState: state,
    target: {
      pathPresent: true,
      projectionsVerifiedExact: true
    },
    staleChoice: null
  });
  if (!recovery.ok) {
    return recovery;
  }
  if (recovery.value.decision.kind !== "current") {
    return notReconciled(
      input.targetId,
      "marker-not-current",
      recovery.value.decision.kind
    );
  }

  const markerRead = await readTargetStateMarkerFile(
    targetRoot
  );
  if (!markerRead.ok) {
    return markerRead;
  }
  if (markerRead.value === null) {
    return notReconciled(
      input.targetId,
      "marker-not-current",
      "missing-marker"
    );
  }
  const expectedMarker =
    targetStateMarkerFactsFromRegistryState(state);
  if (!expectedMarker.ok) {
    return expectedMarker;
  }
  if (
    writeTargetStateMarker(markerRead.value) !==
    writeTargetStateMarker(expectedMarker.value)
  ) {
    return notReconciled(
      input.targetId,
      "marker-not-current",
      "marker-content-mismatch"
    );
  }

  const built = await buildDependenciesPackage(
    input.home,
    state,
    input.lock
  );
  if (!built.ok) {
    return built;
  }

  const encoded = writeExactExportPackage({
    manifest: built.value.manifest,
    frames: built.value.frames
  });
  if (!encoded.ok) {
    return encoded;
  }

  const written = await writeExactExportFile({
    destinationPath: input.destinationPath,
    bytes: encoded.value,
    lock: input.lock
  });
  if (!written.ok) {
    return written;
  }

  return {
    ok: true,
    value: {
      destinationPath: written.value,
      manifest: built.value.manifest,
      warnings: detachedWarnings(state)
    }
  };
}

async function buildDependenciesPackage(
  home: SkiloomHomePaths,
  state: RegistryTargetState,
  lock: OperationLockSession
): Promise<
  Result<
    Readonly<{
      manifest: ExactExportManifest;
      frames: ReadonlyArray<ExactExportFileFrame>;
    }>,
    OperationLockLost | PackageStoreError
  >
> {
  const frames: ExactExportFileFrame[] = [];
  const seenDigests = new Set<string>();

  for (const packageFact of [...state.resolvedPackages].sort(
    (left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
  )) {
    const held = lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    const store = await verifyPackageStoreEntry(
      home,
      packageFact.contentDigest
    );
    if (!store.ok) {
      return store;
    }
    if (!seenDigests.has(packageFact.contentDigest)) {
      seenDigests.add(packageFact.contentDigest);
      const payloadId = `package:${packageFact.contentDigest}`;
      for (const entry of store.value.snapshot.entries) {
        frames.push({
          payloadId,
          path: entry.path,
          executable: entry.executable,
          content: Uint8Array.from(entry.content)
        });
      }
    }
  }

  return {
    ok: true,
    value: {
      manifest: manifestFromRegistry(state),
      frames
    }
  };
}

function manifestFromRegistry(
  state: RegistryTargetState
): ExactExportManifest {
  return {
    format: "SKILOOM-EXPORT-V1",
    mode: "dependencies",
    requirements: state.directRequirements,
    sources: state.resolvedSources.map((source) =>
      source.sourceKind === "github-release"
        ? {
            repositoryCoordinate:
              source.repositoryCoordinate,
            sourceKind: "github-release" as const,
            version: source.version,
            actualTag: source.actualTag,
            exactCommit: source.exactCommit,
            immutable: source.immutable
          }
        : {
            repositoryCoordinate:
              source.repositoryCoordinate,
            sourceKind: "git" as const,
            exactCommit: source.exactCommit
          }
    ),
    packages: state.resolvedPackages.map((entry) => ({
      packageCoordinate: entry.packageCoordinate,
      packageRoot: entry.packageRoot,
      contentDigest: entry.contentDigest,
      payloadId: `package:${entry.contentDigest}`
    })),
    dependencies: state.dependencyEdges.map((entry) => ({
      fromPackageCoordinate: entry.fromPackage,
      toPackageCoordinate: entry.toPackage
    })),
    projections: state.projections.map((entry) => ({
      packageCoordinate: entry.packageCoordinate,
      activationName: entry.activationName
    })),
    detached: [],
    userSkills: []
  };
}

function detachedWarnings(
  state: RegistryTargetState
): ReadonlyArray<ExactExportWarning> {
  const projectionByPackage = new Map(
    state.projections.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  return [...state.detachedBaselines]
    .sort((left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
    )
    .map((baseline) =>
      productError("DetachedOverrideBytesOmitted", {
        packageCoordinate: baseline.packageCoordinate,
        activationName:
          projectionByPackage.get(
            baseline.packageCoordinate
          )?.activationName ?? ""
      })
    );
}

async function targetDirectoryExists(
  targetRoot: string
): Promise<boolean> {
  try {
    const stat = await lstat(targetRoot);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function notReconciled(
  targetId: string,
  reason: ExactExportTargetNotReconciled["facts"]["reason"],
  subject: string | null
): Result<never, ExactExportTargetNotReconciled> {
  return {
    ok: false,
    error: productError("ExactExportTargetNotReconciled", {
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
