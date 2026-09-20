import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../../native/skiloom-lock.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../../runtime/home.js";
import {
  executeRecoveryCandidate,
  type RecoveryCandidateMode,
  type RecoveryCandidateResult
} from "../../runtime/orchestration/lifecycle/recovery/candidate.js";
import type {
  LifecycleCandidatePlan
} from "../../runtime/orchestration/lifecycle-candidate.js";
import type {
  MachineRegistry
} from "../../runtime/registry/index.js";
import {
  createGitHubJsonFetchTransport,
  createGitHubRepositoryFetchTransport
} from "../../runtime/source/github/index.js";
import {
  createCliCandidateAcceptance,
  currentUserHome,
  formatReleaseRetargetRisk,
  presentDirectRequirement
} from "../candidate-acceptance.js";
import {
  parseCliCandidateOptions,
  type CliTargetedCandidateOptions
} from "../candidate/options.js";
import {
  formatCliCandidatePresentation,
  type CliCandidatePresentationFacts
} from "../candidate/presentation.js";
import {
  readCliStatus
} from "../status.js";
import type {
  ResolvedCliTarget
} from "../target-selector.js";

export type CliRecoveryInvocation =
  CliTargetedCandidateOptions &
  Readonly<{ mode: RecoveryCandidateMode }>;

export type CliRecoveryResult =
  CliCandidatePresentationFacts<
    "planned" | "declined" | "recovered" | "forked"
  > &
  Readonly<{
    mode: RecoveryCandidateMode;
    targetId: string;
    generation: number | null;
  }>;

export type CliRecoveryExecution = Readonly<{
  result: CliRecoveryResult;
  presentationRendered: boolean;
}>;

export type ParseCliRecoveryResult =
  | Readonly<{ ok: true; value: CliRecoveryInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliRecoveryArguments(
  mode: RecoveryCandidateMode,
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliRecoveryResult {
  const options = parseCliCandidateOptions(argv, json);
  return options.ok
    ? {
        ok: true,
        value: {
          ...options.value,
          mode
        }
      }
    : options;
}

export async function executeCliRecovery(
  input: CliRecoveryInvocation
): Promise<Result<CliRecoveryExecution, ProductError>> {
  const userHome = currentUserHome();
  const home = resolveSkiloomHomePaths(userHome);
  try {
    await mkdir(home.homeRoot, { recursive: true });
  } catch {
    return {
      ok: false,
      error: productError("SkiloomHomeUnavailable", {
        path: home.homeRoot
      })
    };
  }

  const helperExecutable =
    process.env.SKILOOM_LOCK_TEST_BINARY;
  if (helperExecutable === undefined) {
    return {
      ok: false,
      error: productError("UnsupportedPlatformCapability", {
        capability: "operation-lock",
        reason: "helper-missing"
      })
    };
  }

  const acquired = await acquireOperationLock({
    helperExecutable: resolve(helperExecutable),
    lockPath: home.operationLockPath
  });
  if (!acquired.ok) {
    return acquired;
  }

  const operated = await executeWhileLocked(
    input,
    home,
    userHome,
    acquired.value
  );
  const released = await acquired.value.release();
  if (operated.ok && !released.ok) {
    return released;
  }
  return operated;
}

async function executeWhileLocked(
  input: CliRecoveryInvocation,
  home: SkiloomHomePaths,
  userHome: string,
  lock: OperationLockSession
): Promise<Result<CliRecoveryExecution, ProductError>> {
  const status = await readCliStatus(input.target, userHome);
  if (!status.ok) {
    return status;
  }
  if (status.value.marker === null) {
    return {
      ok: false,
      error: productError("RecoveryMarkerRequired", {
        mode: input.mode,
        path: input.target.path
      })
    };
  }

  let registry: MachineRegistry | undefined;
  try {
    if (
      status.value.registry !== null ||
      recoveryNeedsRegistry(input)
    ) {
      const { openMachineRegistry } =
        await import("../../runtime/registry/index.js");
      const opened = await openMachineRegistry(home, lock);
      if (!opened.ok) {
        return opened;
      }
      registry = opened.value;
    }

    let presentationRendered = false;
    const acceptance = createCliCandidateAcceptance(
      input,
      {
        presentCandidate: (plan, projections) => {
          presentationRendered = true;
          process.stdout.write(
            formatRecoveryCandidate(
              input.target,
              input.mode,
              plan,
              projections
            )
          );
        },
        presentRetargets: (retargets) => {
          presentationRendered = true;
          process.stdout.write(
            formatReleaseRetargetRisk(retargets)
          );
        }
      }
    );

    const lifecycle = await executeRecoveryCandidate({
      mode: input.mode,
      home,
      targetRoot: input.target.path,
      marker: status.value.marker,
      lock,
      registry:
        registry ?? recoveryPlanOnlyRegistry(),
      repositoryTransport:
        createGitHubRepositoryFetchTransport(),
      transport: createGitHubJsonFetchTransport(),
      sourceCachePath: home.sourceCachePath,
      acceptCandidate:
        acceptance.acceptCandidateWithRetarget
    });
    if (!lifecycle.ok) {
      return lifecycle;
    }

    return {
      ok: true,
      value: {
        result: presentRecoveryResult(
          input.target,
          lifecycle.value
        ),
        presentationRendered
      }
    };
  } finally {
    registry?.close();
  }
}

function recoveryNeedsRegistry(
  input: CliRecoveryInvocation
): boolean {
  if (input.plan) {
    return false;
  }
  if (
    input.json ||
    input.nonInteractive ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true
  ) {
    return input.yes;
  }
  return true;
}

function presentRecoveryResult(
  target: ResolvedCliTarget,
  result: RecoveryCandidateResult
): CliRecoveryResult {
  return {
    status: result.status,
    mode: result.mode,
    target,
    targetId: result.targetId,
    generation:
      "state" in result
        ? result.state.generation
        : null,
    directRequirements:
      result.plan.directRequirements.map(
        presentDirectRequirement
      ),
    sources: result.plan.candidate.sourceBindings,
    packages: result.plan.candidate.packages,
    dependencyEdges:
      result.plan.candidate.dependencyEdges,
    comparison: result.plan.comparison,
    projections: result.projections
  };
}

function formatRecoveryCandidate(
  target: ResolvedCliTarget,
  mode: RecoveryCandidateMode,
  plan: LifecycleCandidatePlan,
  projections: CliRecoveryResult["projections"]
): string {
  return (
    "Recovery mode: " + mode + "\n" +
    formatCliCandidatePresentation({
      status: "candidate",
      target,
      directRequirements:
        plan.directRequirements.map(
          presentDirectRequirement
        ),
      sources: plan.candidate.sourceBindings,
      packages: plan.candidate.packages,
      dependencyEdges:
        plan.candidate.dependencyEdges,
      comparison: plan.comparison,
      projections
    })
  );
}

export function formatCliRecoveryResult(
  result: CliRecoveryResult
): string {
  return (
    "Recovery mode: " + result.mode + "\n" +
    "Target ID: " + result.targetId + "\n" +
    "Generation: " +
    (result.generation === null
      ? "not-committed"
      : result.generation) +
    "\n" +
    formatCliCandidatePresentation(result)
  );
}

function recoveryPlanOnlyRegistry(): MachineRegistry {
  const unexpected = (): never => {
    throw new Error(
      "plan-only recovery touched Machine Registry mutation"
    );
  };
  return {
    close() {},
    pragmas: unexpected,
    readTargetState: () => ({
      ok: true,
      value: undefined
    }),
    readPendingOperations: unexpected,
    beginPendingOperation: unexpected,
    beginPendingReconciliation: unexpected,
    completePendingOperation: unexpected,
    replaceDependencyObservations: unexpected,
    replaceTargetState: unexpected
  };
}
