import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  productError,
  type ProductError,
  type Result
} from "../domain/errors/index.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../native/skiloom-lock.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../runtime/home.js";
import type {
  LifecycleCandidatePlan
} from "../runtime/orchestration/lifecycle-candidate.js";
import type {
  DetachedContentChangeRisk
} from "../runtime/orchestration/lifecycle/projection/risk.js";
import {
  updateAcceptedTarget
} from "../runtime/orchestration/lifecycle/update.js";
import type {
  MachineRegistry,
  RegistryTargetState
} from "../runtime/registry/index.js";
import {
  createGitHubJsonFetchTransport,
  createGitHubRepositoryFetchTransport
} from "../runtime/source/github/index.js";
import {
  createCliCandidateAcceptance,
  currentUserHome,
  formatReleaseRetargetRisk,
  presentDirectRequirement,
  type CliPresentedDirectRequirement
} from "./candidate-acceptance.js";
import {
  parseCliCandidateOptions,
  type CliTargetedCandidateOptions
} from "./candidate/options.js";
import {
  formatCliCandidatePresentation,
  type CliCandidatePresentationFacts
} from "./candidate/presentation.js";
import {
  resolveGitHubCredentialEnvironment
} from "./github-credential/index.js";
import {
  preflightCurrentTargetCopy,
  readCliStatus,
  requireCurrentTargetCopy
} from "./status.js";
import type {
  ResolvedCliTarget
} from "./target-selector.js";

export type CliUpdateInvocation =
  CliTargetedCandidateOptions;

export type CliUpdateDirectRequirement =
  CliPresentedDirectRequirement;

export type CliUpdateResult =
  CliCandidatePresentationFacts<
    "planned" | "declined" | "updated" | "no-op"
  > &
  Readonly<{
    detachedContentRisks: ReadonlyArray<DetachedContentChangeRisk>;
    acceptedState: Readonly<{
      targetId: string;
      generation: number;
      projections: ReadonlyArray<Readonly<{
        packageCoordinate: string;
        activationName: string;
        ownership: string;
      }>>;
    }>;
  }>;

export type CliUpdateExecution = Readonly<{
  result: CliUpdateResult;
  presentationRendered: boolean;
}>;

export type ParseCliUpdateResult =
  | Readonly<{ ok: true; value: CliUpdateInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliUpdateArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliUpdateResult {
  return parseCliCandidateOptions(argv, json);
}

export async function executeCliUpdate(
  input: CliUpdateInvocation
): Promise<Result<CliUpdateExecution, ProductError>> {
  const userHome = currentUserHome();
  const current = await preflightCurrentTargetCopy(
    input.target,
    userHome
  );
  if (!current.ok) {
    return current;
  }
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
  input: CliUpdateInvocation,
  home: SkiloomHomePaths,
  userHome: string,
  lock: OperationLockSession
): Promise<Result<CliUpdateExecution, ProductError>> {
  const status = await readCliStatus(input.target, userHome);
  if (!status.ok) {
    return status;
  }
  if (status.value.registry === null) {
    return {
      ok: false,
      error: productError("UpdateTargetUnavailable", {
        path: input.target.path,
        reason:
          status.value.marker === null
            ? "target-not-registered"
            : "recovery-required"
      })
    };
  }
  const current = requireCurrentTargetCopy(status.value);
  if (!current.ok) {
    return current;
  }

  let registry: MachineRegistry | undefined;
  try {
    const { openMachineRegistry } =
      await import("../runtime/registry/index.js");
    const opened = await openMachineRegistry(home, lock);
    if (!opened.ok) {
      return opened;
    }
    registry = opened.value;

    let presentationRendered = false;
    const authorization = createCliCandidateAcceptance(
      input,
      {
        presentCandidate: (
          plan,
          projections,
          detachedContentRisks
        ) => {
          presentationRendered = true;
          process.stdout.write(
            formatUpdateCandidate(
              input.target,
              plan,
              projections,
              detachedContentRisks
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
    const credential =
      resolveGitHubCredentialEnvironment(process.env);
    const lifecycle = await updateAcceptedTarget({
      home,
      targetId: status.value.registry.targetId,
      targetRoot: input.target.path,
      lock,
      registry,
      repositoryTransport:
        createGitHubRepositoryFetchTransport(),
      transport: createGitHubJsonFetchTransport(),
      sourceCachePath: home.sourceCachePath,
      ...(credential === undefined
        ? {}
        : { credential }),
      acceptCandidate: authorization.acceptCandidate,
      authorizeReleaseRetarget:
        authorization.authorizeReleaseRetarget
    });
    if (!lifecycle.ok) {
      return lifecycle;
    }

    return {
      ok: true,
      value: {
        result: lifecycleResult(
          input.target,
          lifecycle.value.status,
          lifecycle.value.plan,
          lifecycle.value.projections,
          lifecycle.value.detachedContentRisks,
          lifecycle.value.state
        ),
        presentationRendered
      }
    };
  } finally {
    registry?.close();
  }
}

function formatUpdateCandidate(
  target: ResolvedCliTarget,
  plan: LifecycleCandidatePlan,
  projections: CliUpdateResult["projections"],
  detachedContentRisks:
    CliUpdateResult["detachedContentRisks"]
): string {
  return formatCliCandidatePresentation({
    target,
    status: "candidate",
    directRequirements:
      plan.directRequirements.map(presentDirectRequirement),
    sources: plan.candidate.sourceBindings,
    packages: plan.candidate.packages,
    dependencyEdges: plan.candidate.dependencyEdges,
    comparison: plan.comparison,
    projections,
    detachedContentRisks
  });
}

function lifecycleResult(
  target: ResolvedCliTarget,
  status: CliUpdateResult["status"],
  plan: LifecycleCandidatePlan,
  projections: CliUpdateResult["projections"],
  detachedContentRisks:
    CliUpdateResult["detachedContentRisks"],
  state: RegistryTargetState
): CliUpdateResult {
  return {
    status,
    target,
    directRequirements:
      plan.directRequirements.map(presentDirectRequirement),
    sources: plan.candidate.sourceBindings,
    packages: plan.candidate.packages,
    dependencyEdges: plan.candidate.dependencyEdges,
    comparison: plan.comparison,
    projections,
    detachedContentRisks,
    acceptedState: {
      targetId: state.targetId,
      generation: state.generation,
      projections: state.projections.map((projection) => ({
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName,
        ownership: projection.ownership
      }))
    }
  };
}

export function formatCliUpdateResult(
  result: CliUpdateResult
): string {
  return formatCliCandidatePresentation(result);
}
