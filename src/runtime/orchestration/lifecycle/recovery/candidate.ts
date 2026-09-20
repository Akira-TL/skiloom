import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  isCanonicalTargetId
} from "../../../../domain/public-format/common.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../../domain/errors/index.js";
import {
  decideTargetRecovery,
  type TargetRecoveryIntent,
  type TargetRecoveryMarkerFacts
} from "../../../../domain/target/recovery.js";
import type {
  OperationLockSession
} from "../../../../native/skiloom-lock.js";
import type {
  SkiloomHomePaths
} from "../../../home.js";
import type {
  MachineRegistry,
  RegistryTargetState
} from "../../../registry/index.js";
import type {
  GitHubJsonTransport,
  GitHubRepositoryTransport
} from "../../../source/github/index.js";
import {
  computeLifecycleCandidate,
  type LifecycleCandidatePlan
} from "../../lifecycle-candidate.js";
import {
  cleanupPendingTargetStaging,
  prepareTargetReconciliation
} from "../../target-reconcile.js";
import {
  acquireLifecycleCandidatePackageSnapshots,
  buildMarkerFacts,
  planLifecycleTarget,
  publishLifecycleCandidateSnapshots
} from "../apply.js";
import {
  resolveLifecycleCandidateAcceptance,
  type LifecycleCandidateAcceptanceCallback
} from "../acceptance.js";
import {
  syncLifecycleMarker
} from "../marker/index.js";
import {
  registryRequirementsToDomain
} from "../requirements.js";
import type {
  LifecycleCandidateProjection
} from "../projection/plan.js";
import {
  recoveryDetachedContentChangeRisks,
  type DetachedContentChangeRisk
} from "../projection/risk.js";
import {
  prepareRecoveryTarget
} from "./candidate-target.js";

export type RecoveryCandidateMode = "recover" | "fork";

export type RecoveryCandidateNotAllowed = ProductError<
  "RecoveryCandidateNotAllowed",
  Readonly<{
    mode: RecoveryCandidateMode;
    targetId: string;
    reason:
      | "registry-present"
      | "registry-missing"
      | "target-current"
      | "invalid-new-target-id";
  }>
>;

export type RecoveryCandidateResult =
  | Readonly<{
      status: "planned" | "declined";
      mode: RecoveryCandidateMode;
      targetId: string;
      plan: LifecycleCandidatePlan;
      projections: ReadonlyArray<LifecycleCandidateProjection>;
      detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
    }>
  | Readonly<{
      status: "recovered" | "forked";
      mode: RecoveryCandidateMode;
      targetId: string;
      plan: LifecycleCandidatePlan;
      projections: ReadonlyArray<LifecycleCandidateProjection>;
      detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
      state: RegistryTargetState;
      marker: TargetRecoveryMarkerFacts;
    }>;

export type ExecuteRecoveryCandidateInput = Readonly<{
  mode: RecoveryCandidateMode;
  home: SkiloomHomePaths;
  targetRoot: string;
  marker: TargetRecoveryMarkerFacts;
  lock: OperationLockSession;
  registry: MachineRegistry;
  repositoryTransport: GitHubRepositoryTransport;
  transport: GitHubJsonTransport;
  acceptCandidate: LifecycleCandidateAcceptanceCallback;
  credential?: string;
  signal?: AbortSignal;
  sourceCachePath?: string;
  createTargetId?: () => string;
  createOperationId?: () => string;
}>;

export async function executeRecoveryCandidate(
  input: ExecuteRecoveryCandidateInput
): Promise<Result<RecoveryCandidateResult, ProductError>> {
  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  const currentRead = input.registry.readTargetState(
    input.marker.targetId
  );
  if (!currentRead.ok) {
    return currentRead;
  }
  const selected = selectRecoveryIntent(
    input,
    currentRead.value
  );
  if (!selected.ok) {
    return selected;
  }

  const requirements = registryRequirementsToDomain(
    input.marker.targetId,
    selected.value.intent.requirements
  );
  if (!requirements.ok) {
    return requirements;
  }

  const planned = await computeLifecycleCandidate({
    directRequirements: requirements.value,
    ...(input.mode === "fork" &&
    currentRead.value !== undefined
      ? { currentState: currentRead.value }
      : {}),
    repositoryTransport: input.repositoryTransport,
    transport: input.transport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential }),
    ...(input.signal === undefined
      ? {}
      : { signal: input.signal }),
    ...(input.sourceCachePath === undefined
      ? {}
      : { sourceCachePath: input.sourceCachePath })
  });
  if (!planned.ok) {
    return planned;
  }
  const candidatePlan: LifecycleCandidatePlan = {
    ...planned.value,
    noChange: false
  };

  const candidatePackages = new Set(
    candidatePlan.candidate.packages.map(
      (entry) => entry.packageCoordinate
    )
  );
  const renames = selected.value.intent.projectionOverrides
    .filter((entry) =>
      candidatePackages.has(entry.packageCoordinate)
    );
  const desiredPlan = planLifecycleTarget(
    candidatePlan.directRequirements,
    candidatePlan.candidate,
    renames
  );
  if (!desiredPlan.ok) {
    return desiredPlan;
  }

  const snapshots =
    await acquireLifecycleCandidatePackageSnapshots(
      input,
      candidatePlan.candidate
    );
  if (!snapshots.ok) {
    return snapshots;
  }

  const prepared = await prepareRecoveryTarget({
    home: input.home,
    targetRoot: resolve(input.targetRoot),
    targetId: selected.value.targetId,
    markerIntent: selected.value.intent,
    candidatePlan,
    desiredPlan: desiredPlan.value,
    snapshots: snapshots.value
  });
  if (!prepared.ok) {
    return prepared;
  }
  const detachedContentRisks =
    recoveryDetachedContentChangeRisks(
      selected.value.intent.detached,
      candidatePlan,
      prepared.value.projections
    );

  let acceptance;
  try {
    acceptance = resolveLifecycleCandidateAcceptance(
      await input.acceptCandidate(
        candidatePlan,
        prepared.value.projections,
        detachedContentRisks
      )
    );
  } catch {
    return {
      ok: false,
      error: productError(
        "LifecycleInstallAcceptanceFailed",
        {}
      )
    };
  }
  if (!acceptance.ok) {
    return acceptance;
  }
  if (
    acceptance.value === "plan" ||
    acceptance.value === "no-op"
  ) {
    return {
      ok: true,
      value: {
        status: "planned",
        mode: input.mode,
        targetId: selected.value.targetId,
        plan: candidatePlan,
        projections: prepared.value.projections,
        detachedContentRisks
      }
    };
  }
  if (acceptance.value === "decline") {
    return {
      ok: true,
      value: {
        status: "declined",
        mode: input.mode,
        targetId: selected.value.targetId,
        plan: candidatePlan,
        projections: prepared.value.projections,
        detachedContentRisks
      }
    };
  }

  const heldAfterAcceptance = input.lock.checkHeld();
  if (!heldAfterAcceptance.ok) {
    return heldAfterAcceptance;
  }

  const published = await publishLifecycleCandidateSnapshots(
    input.home,
    input.lock,
    snapshots.value
  );
  if (!published.ok) {
    return published;
  }

  const operationId =
    (input.createOperationId ?? randomUUID)();
  const reconciliation =
    await prepareTargetReconciliation({
      home: input.home,
      targetRoot: resolve(input.targetRoot),
      operationId,
      lock: input.lock,
      registry: input.registry,
      desiredPlan: prepared.value.desiredPlan,
      preflight: prepared.value.preflight,
      currentProjections:
        prepared.value.currentProjections,
      nextState: prepared.value.nextState,
      deferPendingCompletion: true
    });
  if (!reconciliation.ok) {
    return reconciliation;
  }

  const committed =
    await reconciliation.value.commitAcceptedState();
  if (!committed.ok) {
    return committed;
  }
  const reconciled =
    await committed.value.reconcileLiveTarget();
  if (!reconciled.ok) {
    return reconciled;
  }

  const marker = buildMarkerFacts(
    reconciled.value,
    prepared.value.desiredPlan
  );
  const markerSynced = await syncLifecycleMarker({
    targetRoot: resolve(input.targetRoot),
    marker
  });
  if (!markerSynced.ok) {
    return markerSynced;
  }

  const cleaned = await cleanupPendingTargetStaging({
    targetId: reconciled.value.targetId,
    targetRoot: resolve(input.targetRoot),
    lock: input.lock,
    registry: input.registry
  });
  if (!cleaned.ok) {
    return cleaned;
  }

  return {
    ok: true,
    value: {
      status:
        input.mode === "recover"
          ? "recovered"
          : "forked",
      mode: input.mode,
      targetId: selected.value.targetId,
      plan: candidatePlan,
      projections: prepared.value.projections,
      detachedContentRisks,
      state: reconciled.value,
      marker
    }
  };
}

function selectRecoveryIntent(
  input: ExecuteRecoveryCandidateInput,
  current: RegistryTargetState | undefined
): Result<
  Readonly<{
    targetId: string;
    intent: TargetRecoveryIntent;
  }>,
  ProductError
> {
  const targetRoot = resolve(input.targetRoot);

  if (input.mode === "recover") {
    if (current !== undefined) {
      return notAllowed(
        input.mode,
        input.marker.targetId,
        "registry-present"
      );
    }
    const decision = decideTargetRecovery({
      registry: null,
      marker: input.marker,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: false
      },
      staleChoice: null
    });
    if (!decision.ok) {
      return decision;
    }
    if (decision.value.kind !== "recover-candidate") {
      return notAllowed(
        input.mode,
        input.marker.targetId,
        "registry-present"
      );
    }
    return {
      ok: true,
      value: {
        targetId: decision.value.targetId,
        intent: decision.value.intent
      }
    };
  }

  if (current === undefined) {
    return notAllowed(
      input.mode,
      input.marker.targetId,
      "registry-missing"
    );
  }

  const newTargetId =
    (input.createTargetId ?? randomUUID)();
  if (
    newTargetId === input.marker.targetId ||
    !isCanonicalTargetId(newTargetId)
  ) {
    return notAllowed(
      input.mode,
      input.marker.targetId,
      "invalid-new-target-id"
    );
  }

  const registeredHere = current.locations.some(
    (location) =>
      resolve(location.path) === targetRoot
  );
  if (registeredHere) {
    return notAllowed(
      input.mode,
      input.marker.targetId,
      "target-current"
    );
  }

  if (input.marker.generation > current.generation) {
    const ahead = decideTargetRecovery({
      registry: {
        targetId: current.targetId,
        generation: current.generation
      },
      marker: input.marker,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: false
      },
      staleChoice: null
    });
    return ahead.ok
      ? notAllowed(
          input.mode,
          input.marker.targetId,
          "target-current"
        )
      : ahead;
  }

  if (input.marker.generation < current.generation) {
    const decision = decideTargetRecovery({
      registry: {
        targetId: current.targetId,
        generation: current.generation
      },
      marker: input.marker,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: false
      },
      staleChoice: {
        kind: "fork",
        newTargetId
      }
    });
    if (!decision.ok) {
      return decision;
    }
    if (decision.value.kind !== "fork-candidate") {
      return notAllowed(
        input.mode,
        input.marker.targetId,
        "target-current"
      );
    }
    return {
      ok: true,
      value: {
        targetId: decision.value.targetId,
        intent: decision.value.intent
      }
    };
  }

  return {
    ok: true,
    value: {
      targetId: newTargetId,
      intent: {
        requirements: input.marker.requirements,
        projectionOverrides:
          input.marker.projectionOverrides,
        detached: input.marker.detached
      }
    }
  };
}

function notAllowed(
  mode: RecoveryCandidateMode,
  targetId: string,
  reason: RecoveryCandidateNotAllowed["facts"]["reason"]
): Result<never, RecoveryCandidateNotAllowed> {
  return {
    ok: false,
    error: productError("RecoveryCandidateNotAllowed", {
      mode,
      targetId,
      reason
    })
  };
}
