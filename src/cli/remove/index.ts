import { mkdir } from "node:fs/promises";
import process from "node:process";

import {
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import { resolveOperationLockHelperExecutable } from "../../native/operation-lock-helper.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../../native/skiloom-lock.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../../runtime/home.js";
import type {
  LifecycleCandidatePlan
} from "../../runtime/orchestration/lifecycle-candidate.js";
import type {
  DetachedContentChangeRisk
} from "../../runtime/orchestration/lifecycle/projection/risk.js";
import {
  removeAcceptedTargetRequirement,
  type RemoveDirectRequirementSelector
} from "../../runtime/orchestration/lifecycle/remove.js";
import type {
  MachineRegistry,
  RegistryTargetState
} from "../../runtime/registry/index.js";
import {
  acquireGitHubRepositorySnapshotWithSystemGit,
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
  resolveGitHubCredentialEnvironment
} from "../github-credential/index.js";
import {
  preflightCurrentTargetCopy,
  readCliStatus,
  requireCurrentTargetCopy
} from "../status.js";
import type {
  ResolvedCliTarget
} from "../target-selector.js";

export type CliRemoveInvocation =
  CliTargetedCandidateOptions &
  Readonly<{
    remove: RemoveDirectRequirementSelector;
  }>;

export type CliRemoveResult =
  CliCandidatePresentationFacts<
    "planned" | "declined" | "removed" | "no-op"
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

export type CliRemoveExecution = Readonly<{
  result: CliRemoveResult;
  presentationRendered: boolean;
}>;

export type ParseCliRemoveResult =
  | Readonly<{ ok: true; value: CliRemoveInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliRemoveArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliRemoveResult {
  const coordinate = argv[0];
  if (
    coordinate === undefined ||
    coordinate.startsWith("-")
  ) {
    return {
      ok: false,
      reason: "remove requires exactly one coordinate"
    };
  }

  const remove = parseRemoveSelector(coordinate);
  if (!remove.ok) {
    return remove;
  }
  const options = parseCliCandidateOptions(
    argv.slice(1),
    json
  );
  if (!options.ok) {
    return options;
  }
  return {
    ok: true,
    value: {
      ...options.value,
      remove: remove.value
    }
  };
}

export async function executeCliRemove(
  input: CliRemoveInvocation
): Promise<Result<CliRemoveExecution, ProductError>> {
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

  const helperExecutable = resolveOperationLockHelperExecutable();
  if (!helperExecutable.ok) {
    return {
      ok: false,
      error: helperExecutable.error
    };
  }

  const acquired = await acquireOperationLock({
    helperExecutable: helperExecutable.value,
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
  input: CliRemoveInvocation,
  home: SkiloomHomePaths,
  userHome: string,
  lock: OperationLockSession
): Promise<Result<CliRemoveExecution, ProductError>> {
  const status = await readCliStatus(input.target, userHome);
  if (!status.ok) {
    return status;
  }
  if (status.value.registry === null) {
    return {
      ok: false,
      error: productError("RemoveTargetUnavailable", {
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
      await import("../../runtime/registry/index.js");
    const opened = await openMachineRegistry(home, lock);
    if (!opened.ok) {
      return opened;
    }
    registry = opened.value;

    let presentationRendered = false;
    const acceptance = createCliCandidateAcceptance(
      input,
      {
        presentCandidate: (
          plan,
          projections,
          detachedContentRisks
        ) => {
          presentationRendered = true;
          process.stdout.write(
            formatRemoveCandidate(
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
    const lifecycle =
      await removeAcceptedTargetRequirement({
        home,
        targetId: status.value.registry.targetId,
        targetRoot: input.target.path,
        lock,
        registry,
        remove: input.remove,
        repositoryTransport:
          createGitHubRepositoryFetchTransport(),
        transport: createGitHubJsonFetchTransport(),
        gitTransport: acquireGitHubRepositorySnapshotWithSystemGit,
        sourceCachePath: home.sourceCachePath,
        ...(credential === undefined
          ? {}
          : { credential }),
        acceptCandidate:
          acceptance.acceptCandidateWithRetarget
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

function parseRemoveSelector(
  coordinate: string
):
  | Readonly<{
      ok: true;
      value: RemoveDirectRequirementSelector;
    }>
  | Readonly<{
      ok: false;
      reason: string;
    }> {
  const packageCoordinate =
    parsePackageCoordinate(coordinate);
  if (packageCoordinate.ok) {
    return {
      ok: true,
      value: {
        kind: "package",
        coordinate:
          packageCoordinate.value.canonical
      }
    };
  }

  const repositoryCoordinate =
    parseRepositoryCoordinate(coordinate);
  if (repositoryCoordinate.ok) {
    return {
      ok: true,
      value: {
        kind: "repository",
        coordinate:
          repositoryCoordinate.value.canonical
      }
    };
  }

  return {
    ok: false,
    reason:
      "remove requires owner/repo or owner/repo/package"
  };
}

function formatRemoveCandidate(
  target: ResolvedCliTarget,
  plan: LifecycleCandidatePlan,
  projections: CliRemoveResult["projections"],
  detachedContentRisks:
    CliRemoveResult["detachedContentRisks"]
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
  status: CliRemoveResult["status"],
  plan: LifecycleCandidatePlan,
  projections: CliRemoveResult["projections"],
  detachedContentRisks:
    CliRemoveResult["detachedContentRisks"],
  state: RegistryTargetState
): CliRemoveResult {
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

export function formatCliRemoveResult(
  result: CliRemoveResult
): string {
  return formatCliCandidatePresentation(result);
}
