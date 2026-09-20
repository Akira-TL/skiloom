import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parseRepositoryCoordinate
} from "../../domain/coordinate/index.js";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import {
  buildPackageSnapshot,
  type PackageSnapshot
} from "../../domain/snapshot/index.js";
import type {
  TargetPlan
} from "../../domain/target/index.js";
import {
  preflightTargetOwnership,
  type TargetOwnedProjection,
  type TargetOwnershipAction,
  type TargetOwnershipPreflight,
  type TargetPathObservation
} from "../../domain/target/preflight.js";
import type {
  OperationLockSession
} from "../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../home.js";
import type {
  MachineRegistry,
  RegistryResolvedPackage,
  RegistryTargetState,
  RegistryTargetStateInput
} from "../registry/index.js";
import {
  repairPackageStoreEntry,
  verifyPackageStoreEntry
} from "../store.js";
import {
  observePackageCommonSoftware
} from "../host-observation/index.js";
import {
  acquireCachedExactGitHubRepositorySnapshot,
  acquireExactGitHubRepositorySnapshot,
  buildGitHubResolverRepositorySnapshot,
  type GitHubJsonTransport
} from "../source/github/index.js";
import {
  repairManagedProjection,
  verifyManagedProjection
} from "../target-projection/index.js";
import {
  syncAcceptedTargetState,
  type LocalLifecycleError
} from "./local-lifecycle.js";
import {
  buildMarkerFacts
} from "./lifecycle/apply.js";
import {
  acceptedTargetPlan
} from "./lifecycle/recovery/target.js";
import {
  readTargetStateMarkerFile
} from "../target-state-marker.js";

export type ExactStateTargetUnavailable = ProductError<
  "ExactStateTargetUnavailable",
  Readonly<{
    targetId: string;
    reason:
      | "target-not-found"
      | "projection-count-mismatch"
      | "projection-not-found";
    subject: string;
  }>
>;

export type ExactRepairSnapshotMismatch = ProductError<
  "ExactRepairSnapshotMismatch",
  Readonly<{
    packageCoordinate: string;
    reason:
      | "missing-source"
      | "invalid-repository"
      | "missing-package"
      | "package-root-mismatch"
      | "content-digest-mismatch";
  }>
>;

export type SyncExactAcceptedTargetError =
  | LocalLifecycleError
  | ExactStateTargetUnavailable
  | ProductError;

export type RepairExactAcceptedTargetError =
  | SyncExactAcceptedTargetError
  | ExactRepairSnapshotMismatch;

export type SyncExactAcceptedTargetResult = Readonly<{
  status: "no-op" | "synchronized";
  state: RegistryTargetState;
  actions: ReadonlyArray<TargetOwnershipAction>;
}>;

export type SyncExactAcceptedTargetInput = Readonly<{
  home: SkiloomHomePaths;
  targetId: string;
  targetRoot: string;
  lock: OperationLockSession;
  registry: MachineRegistry;
  createOperationId?: () => string;
}>;

export type RepairExactAcceptedTargetInput =
  SyncExactAcceptedTargetInput &
  Readonly<{
    transport: GitHubJsonTransport;
    sourceCachePath?: string;
    credential?: string;
    signal?: AbortSignal;
  }>;

export type RepairExactAcceptedTargetResult = Readonly<{
  status: "no-op" | "repaired";
  state: RegistryTargetState;
  actions: ReadonlyArray<TargetOwnershipAction>;
  repairedPackages: ReadonlyArray<string>;
  repairedProjections: ReadonlyArray<string>;
}>;

export async function syncExactAcceptedTarget(
  input: SyncExactAcceptedTargetInput
): Promise<
  Result<
    SyncExactAcceptedTargetResult,
    SyncExactAcceptedTargetError
  >
> {
  const prepared = await prepareAcceptedTarget(input);
  if (!prepared.ok) {
    return prepared;
  }

  const synced = await syncPreparedTarget(
    input,
    prepared.value
  );
  if (!synced.ok) {
    return synced;
  }

  const observations = await refreshSoftwareObservations(
    input,
    synced.value
  );
  if (!observations.ok) {
    return observations;
  }

  return {
    ok: true,
    value: {
      status:
        requiresConvergence(prepared.value.preflight.actions) ||
        !prepared.value.markerCurrent
          ? "synchronized"
          : "no-op",
      state: observations.value,
      actions: prepared.value.preflight.actions
    }
  };
}

export async function repairExactAcceptedTarget(
  input: RepairExactAcceptedTargetInput
): Promise<
  Result<
    RepairExactAcceptedTargetResult,
    RepairExactAcceptedTargetError
  >
> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const read = input.registry.readTargetState(input.targetId);
  if (!read.ok) {
    return read;
  }
  if (read.value === undefined) {
    return unavailable(
      input.targetId,
      "target-not-found",
      input.targetId
    );
  }

  const repairedPackages: string[] = [];
  for (const packageFact of read.value.resolvedPackages) {
    const verified = await verifyPackageStoreEntry(
      input.home,
      packageFact.contentDigest
    );
    if (verified.ok) {
      continue;
    }
    if (
      verified.error.code !== "StoreEntryNotFound" &&
      verified.error.code !== "CorruptStoreEntry"
    ) {
      return verified;
    }

    const snapshot = await acquireAcceptedPackageSnapshot(
      input,
      read.value,
      packageFact
    );
    if (!snapshot.ok) {
      return snapshot;
    }
    const repaired = await repairPackageStoreEntry(
      input.home,
      packageFact.contentDigest,
      snapshot.value
    );
    if (!repaired.ok) {
      return repaired;
    }
    repairedPackages.push(packageFact.packageCoordinate);
  }

  const repairedProjections =
    await repairManagedTargetDrift(input, read.value);
  if (!repairedProjections.ok) {
    return repairedProjections;
  }

  const prepared = await prepareAcceptedTarget(input);
  if (!prepared.ok) {
    return prepared;
  }
  const synced = await syncPreparedTarget(
    input,
    prepared.value
  );
  if (!synced.ok) {
    return synced;
  }

  return {
    ok: true,
    value: {
      status:
        repairedPackages.length > 0 ||
        repairedProjections.value.length > 0 ||
        requiresConvergence(prepared.value.preflight.actions) ||
        !prepared.value.markerCurrent
          ? "repaired"
          : "no-op",
      state: synced.value,
      actions: prepared.value.preflight.actions,
      repairedPackages,
      repairedProjections: repairedProjections.value
    }
  };
}

async function syncPreparedTarget(
  input: SyncExactAcceptedTargetInput,
  prepared: PreparedAcceptedTarget
): Promise<Result<RegistryTargetState, LocalLifecycleError>> {
  return syncAcceptedTargetState({
    home: input.home,
    targetRoot: resolve(input.targetRoot),
    operationId: (input.createOperationId ?? randomUUID)(),
    lock: input.lock,
    registry: input.registry,
    desiredPlan: prepared.plan,
    preflight: prepared.preflight,
    currentProjections: prepared.currentProjections,
    acceptedState: registryStateInput(prepared.state)
  });
}

async function refreshSoftwareObservations(
  input: SyncExactAcceptedTargetInput,
  state: RegistryTargetState
): Promise<Result<RegistryTargetState, ProductError>> {
  const observations = [];
  for (const packageFact of state.resolvedPackages) {
    const verified = await verifyPackageStoreEntry(
      input.home,
      packageFact.contentDigest
    );
    if (!verified.ok) {
      return verified;
    }
    const observed = await observePackageCommonSoftware({
      packageCoordinate: packageFact.packageCoordinate,
      packageContentDigest: packageFact.contentDigest,
      snapshot: verified.value.snapshot
    });
    observations.push(...observed.observations);
  }

  return input.registry.replaceDependencyObservations(
    state.targetId,
    "software",
    observations
  );
}

async function repairManagedTargetDrift(
  input: RepairExactAcceptedTargetInput,
  state: RegistryTargetState
): Promise<Result<ReadonlyArray<string>, ProductError>> {
  const plan = acceptedTargetPlan(state);
  if (!plan.ok) {
    return plan;
  }
  const current = currentOwnedProjections(
    state,
    plan.value
  );
  if (!current.ok) {
    return current;
  }

  const repaired: string[] = [];
  for (const owned of current.value) {
    if (owned.ownership === "detached") {
      continue;
    }

    const verified = await verifyManagedProjection({
      home: input.home,
      targetRoot: resolve(input.targetRoot),
      expected: {
        projection: owned.projection,
        materialization: owned.materialization
      }
    });
    if (verified.ok) {
      continue;
    }
    if (verified.error.code === "ManagedProjectionMissing") {
      continue;
    }

    const stillHeld = input.lock.checkHeld();
    if (!stillHeld.ok) {
      return stillHeld;
    }
    const repairedProjection =
      await repairManagedProjection({
        home: input.home,
        targetRoot: resolve(input.targetRoot),
        projection: owned.projection,
        materialization: owned.materialization,
        current: {
          projection: owned.projection,
          materialization: owned.materialization
        }
      });
    if (!repairedProjection.ok) {
      return repairedProjection;
    }
    repaired.push(owned.projection.packageCoordinate);
  }

  return {
    ok: true,
    value: repaired.sort(compareUtf8)
  };
}

async function acquireAcceptedPackageSnapshot(
  input: RepairExactAcceptedTargetInput,
  state: RegistryTargetState,
  packageFact: RegistryResolvedPackage
): Promise<Result<PackageSnapshot, ProductError>> {
  const source = state.resolvedSources.find(
    (entry) =>
      entry.repositoryCoordinate ===
      packageFact.repositoryCoordinate
  );
  if (source === undefined) {
    return repairMismatch(
      packageFact.packageCoordinate,
      "missing-source"
    );
  }

  const repository = parseRepositoryCoordinate(
    source.repositoryCoordinate
  );
  if (!repository.ok) {
    return repairMismatch(
      packageFact.packageCoordinate,
      "invalid-repository"
    );
  }

  const request = {
    repository: repository.value,
    exactCommit: source.exactCommit,
    transport: input.transport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential }),
    ...(input.signal === undefined
      ? {}
      : { signal: input.signal })
  };
  const acquired =
    input.sourceCachePath === undefined
      ? await acquireExactGitHubRepositorySnapshot(request)
      : await acquireCachedExactGitHubRepositorySnapshot({
          ...request,
          cacheRoot: input.sourceCachePath
        });
  if (!acquired.ok) {
    return acquired;
  }

  const repositorySnapshot =
    buildGitHubResolverRepositorySnapshot(acquired.value);
  if (!repositorySnapshot.ok) {
    return repositorySnapshot;
  }
  const discovered = repositorySnapshot.value.packages.find(
    (entry) =>
      entry.coordinate.canonical ===
      packageFact.packageCoordinate
  );
  if (discovered === undefined) {
    return repairMismatch(
      packageFact.packageCoordinate,
      "missing-package"
    );
  }
  if (discovered.packageRoot !== packageFact.packageRoot) {
    return repairMismatch(
      packageFact.packageCoordinate,
      "package-root-mismatch"
    );
  }
  if (discovered.contentDigest !== packageFact.contentDigest) {
    return repairMismatch(
      packageFact.packageCoordinate,
      "content-digest-mismatch"
    );
  }

  const snapshot = buildPackageSnapshot({
    packageRoot: discovered.packageRoot,
    discoveredPackageRoots:
      repositorySnapshot.value.packages.map(
        (entry) => entry.packageRoot
      ),
    entries: acquired.value.entries
  });
  if (!snapshot.ok) {
    return snapshot;
  }
  if (snapshot.value.contentDigest !== packageFact.contentDigest) {
    return repairMismatch(
      packageFact.packageCoordinate,
      "content-digest-mismatch"
    );
  }
  return snapshot;
}

function repairMismatch(
  packageCoordinate: string,
  reason: ExactRepairSnapshotMismatch["facts"]["reason"]
): Result<never, ExactRepairSnapshotMismatch> {
  return {
    ok: false,
    error: productError("ExactRepairSnapshotMismatch", {
      packageCoordinate,
      reason
    })
  };
}

type PreparedAcceptedTarget = Readonly<{
  state: RegistryTargetState;
  plan: TargetPlan;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  preflight: TargetOwnershipPreflight;
  markerCurrent: boolean;
}>;

async function prepareAcceptedTarget(
  input: SyncExactAcceptedTargetInput
): Promise<Result<PreparedAcceptedTarget, ProductError>> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const read = input.registry.readTargetState(input.targetId);
  if (!read.ok) {
    return read;
  }
  if (read.value === undefined) {
    return {
      ok: false,
      error: productError("ExactStateTargetUnavailable", {
        targetId: input.targetId,
        reason: "target-not-found",
        subject: input.targetId
      })
    };
  }
  const state = read.value;

  const plan = acceptedTargetPlan(state);
  if (!plan.ok) {
    return plan;
  }
  const current = currentOwnedProjections(state, plan.value);
  if (!current.ok) {
    return current;
  }
  const observed = await observeCurrentTarget(
    input.home,
    resolve(input.targetRoot),
    current.value
  );
  if (!observed.ok) {
    return observed;
  }
  const preflight = preflightTargetOwnership({
    desiredPlan: plan.value,
    currentProjections: current.value,
    observedPaths: observed.value
  });
  if (!preflight.ok) {
    return preflight;
  }
  const markerCurrent = await acceptedMarkerCurrent(
    resolve(input.targetRoot),
    state,
    plan.value
  );
  if (!markerCurrent.ok) {
    return markerCurrent;
  }

  return {
    ok: true,
    value: {
      state,
      plan: plan.value,
      currentProjections: current.value,
      preflight: preflight.value,
      markerCurrent: markerCurrent.value
    }
  };
}

function currentOwnedProjections(
  state: RegistryTargetState,
  plan: PreparedAcceptedTarget["plan"]
): Result<
  ReadonlyArray<TargetOwnedProjection>,
  ExactStateTargetUnavailable
> {
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

async function observeCurrentTarget(
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

async function acceptedMarkerCurrent(
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

function registryStateInput(
  state: RegistryTargetState
): RegistryTargetStateInput {
  return {
    targetId: state.targetId,
    locations: state.locations,
    directRequirements: state.directRequirements,
    resolvedSources: state.resolvedSources,
    resolvedPackages: state.resolvedPackages,
    dependencyEdges: state.dependencyEdges,
    projections: state.projections,
    detachedBaselines: state.detachedBaselines,
    dependencyObservations: state.dependencyObservations
  };
}

function requiresConvergence(
  actions: ReadonlyArray<TargetOwnershipAction>
): boolean {
  return actions.some(
    (action) =>
      action.action === "materialize" ||
      action.action === "replace" ||
      action.action === "remove" ||
      action.action === "drop-missing"
  );
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

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

function unavailable(
  targetId: string,
  reason: ExactStateTargetUnavailable["facts"]["reason"],
  subject: string
): Result<never, ExactStateTargetUnavailable> {
  return {
    ok: false,
    error: productError("ExactStateTargetUnavailable", {
      targetId,
      reason,
      subject
    })
  };
}
