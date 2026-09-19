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
  readCliStatus
} from "./status.js";
import type {
  ResolvedCliTarget
} from "./target-selector.js";

export type CliUpdateInvocation =
  CliTargetedCandidateOptions;

export type CliUpdateDirectRequirement =
  CliPresentedDirectRequirement;

export type CliUpdateResult = Readonly<{
  status: "planned" | "declined" | "updated" | "no-op";
  target: ResolvedCliTarget;
  directRequirements: ReadonlyArray<CliUpdateDirectRequirement>;
  sources: LifecycleCandidatePlan["candidate"]["sourceBindings"];
  packages: LifecycleCandidatePlan["candidate"]["packages"];
  dependencyEdges: LifecycleCandidatePlan["candidate"]["dependencyEdges"];
  comparison: LifecycleCandidatePlan["comparison"];
  projections: ReadonlyArray<Readonly<{
    packageCoordinate: string;
    activationName: string;
    ownership: "managed" | "detached";
  }>>;
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
        presentCandidate: (plan, projections) => {
          presentationRendered = true;
          process.stdout.write(
            formatUpdateCandidate(
              input.target,
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
  projections: CliUpdateResult["projections"]
): string {
  return formatUpdatePresentation(
    target,
    "candidate",
    plan.directRequirements.map(presentDirectRequirement),
    plan.candidate.sourceBindings,
    plan.candidate.packages,
    plan.candidate.dependencyEdges,
    plan.comparison,
    projections
  );
}

function lifecycleResult(
  target: ResolvedCliTarget,
  status: CliUpdateResult["status"],
  plan: LifecycleCandidatePlan,
  projections: CliUpdateResult["projections"],
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
  return formatUpdatePresentation(
    result.target,
    result.status,
    result.directRequirements,
    result.sources,
    result.packages,
    result.dependencyEdges,
    result.comparison,
    result.projections
  );
}

function formatUpdatePresentation(
  target: ResolvedCliTarget,
  status: string,
  requirements: ReadonlyArray<CliUpdateDirectRequirement>,
  sources: LifecycleCandidatePlan["candidate"]["sourceBindings"],
  packages: LifecycleCandidatePlan["candidate"]["packages"],
  dependencyEdges:
    LifecycleCandidatePlan["candidate"]["dependencyEdges"],
  comparison: LifecycleCandidatePlan["comparison"],
  projections: CliUpdateResult["projections"]
): string {
  const lines = [
    "Target: " + target.path,
    "Status: " + status,
    "Direct Install Requirements:"
  ];
  for (const requirement of requirements) {
    const source =
      requirement.sourceKind === "git"
        ? "git " + requirement.requestedRef
        : "github-release" +
          (requirement.versionRequirement === undefined
            ? ""
            : " " + requirement.versionRequirement);
    lines.push(
      "- " + requirement.kind + " " +
      requirement.coordinate + " " + source
    );
  }

  lines.push("Sources:");
  for (const source of sources) {
    lines.push(
      source.sourceKind === "git"
        ? "- " + source.repositoryCoordinate +
          " git " + source.requestedRef +
          " @ " + source.exactCommit
        : "- " + source.repositoryCoordinate +
          " github-release " + source.version +
          " (" + source.actualTag + ") @ " +
          source.exactCommit
    );
  }

  lines.push("Packages:");
  for (const packageFact of packages) {
    lines.push(
      "- " + packageFact.packageCoordinate +
      " " + packageFact.contentDigest
    );
  }

  lines.push("Dependency Edges:");
  if (dependencyEdges.length === 0) {
    lines.push("- none");
  } else {
    for (const edge of dependencyEdges) {
      lines.push(
        "- " + edge.sourcePackageCoordinate +
        " -> " + edge.targetPackageCoordinate
      );
    }
  }

  lines.push("Projections / Ownership:");
  for (const projection of projections) {
    lines.push(
      "- " + projection.packageCoordinate +
      " -> " + projection.activationName +
      " (" + projection.ownership + ")"
    );
  }

  lines.push("Changes:");
  const deltas = [
    ...comparison.sourceDeltas.map((delta) => delta.kind),
    ...comparison.packageDeltas.map((delta) => delta.kind),
    ...comparison.dependencyEdgeDeltas.map(
      (delta) => delta.kind
    )
  ];
  if (deltas.length === 0) {
    lines.push("- none");
  } else {
    for (const delta of deltas) {
      lines.push("- " + delta);
    }
  }

  lines.push("Warnings / Special Risks:");
  const retargets = comparison.sourceDeltas.filter(
    (delta) => delta.kind === "release-retarget"
  );
  if (retargets.length === 0) {
    lines.push("- none");
  } else {
    for (const retarget of retargets) {
      lines.push(
        "- release-retarget " +
        retarget.repositoryCoordinate
      );
    }
  }

  return lines.join("\n") + "\n";
}
