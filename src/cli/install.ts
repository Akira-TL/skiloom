import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  isValidSkillName,
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../domain/errors/index.js";
import {
  parseReleaseRequirement
} from "../domain/requirement/index.js";
import type {
  DirectInstallRequirement
} from "../domain/resolver/index.js";
import type {
  TargetProjectionRename
} from "../domain/target/index.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../native/skiloom-lock.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../runtime/home.js";
import {
  addAcceptedTargetRoots
} from "../runtime/orchestration/lifecycle/add-root.js";
import type {
  LifecycleCandidatePlan
} from "../runtime/orchestration/lifecycle-candidate.js";
import {
  executeFirstAcceptedInstall
} from "../runtime/orchestration/lifecycle/first-install.js";
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
  readCliStatus
} from "./status.js";
import type {
  ResolvedCliTarget
} from "./target-selector.js";

export type CliInstallIntent = Readonly<{
  directRequirement: DirectInstallRequirement;
  requestedProjectionRename?: TargetProjectionRename;
}>;

export type CliInstallInvocation = Readonly<{
  intent: CliInstallIntent;
  target: ResolvedCliTarget;
  plan: boolean;
  yes: boolean;
  allowReleaseRetarget: boolean;
  nonInteractive: boolean;
  json: boolean;
}>;

export type CliInstallDirectRequirement =
  CliPresentedDirectRequirement;

export type CliInstallAcceptedState = Readonly<{
  targetId: string;
  generation: number;
  projections: ReadonlyArray<Readonly<{
    packageCoordinate: string;
    activationName: string;
    ownership: string;
  }>>;
}>;

export type CliInstallResult = Readonly<{
  status: "planned" | "declined" | "installed" | "applied" | "no-op";
  target: ResolvedCliTarget;
  directRequirements: ReadonlyArray<CliInstallDirectRequirement>;
  sources: LifecycleCandidatePlan["candidate"]["sourceBindings"];
  packages: LifecycleCandidatePlan["candidate"]["packages"];
  dependencyEdges: LifecycleCandidatePlan["candidate"]["dependencyEdges"];
  comparison: LifecycleCandidatePlan["comparison"];
  projectionRenames: ReadonlyArray<TargetProjectionRename>;
  acceptedState: CliInstallAcceptedState | null;
}>;

export type CliInstallExecution = Readonly<{
  result: CliInstallResult;
  presentationRendered: boolean;
}>;

type BuildCliInstallIntentInput = Readonly<{
  coordinate: string;
  version?: string;
  gitRef?: string;
  name?: string;
}>;

export function buildCliInstallIntent(
  input: BuildCliInstallIntentInput
):
  | Readonly<{ ok: true; value: CliInstallIntent }>
  | Readonly<{ ok: false; reason: string }> {
  if (input.version !== undefined && input.gitRef !== undefined) {
    return {
      ok: false,
      reason: "--version and --git are mutually exclusive"
    };
  }

  const packageCoordinate = parsePackageCoordinate(input.coordinate);
  const repositoryCoordinate = packageCoordinate.ok
    ? undefined
    : parseRepositoryCoordinate(input.coordinate);
  if (!packageCoordinate.ok && !repositoryCoordinate?.ok) {
    return {
      ok: false,
      reason: "install requires owner/repo or owner/repo/package"
    };
  }
  const repository = repositoryCoordinate?.ok
    ? repositoryCoordinate.value
    : undefined;

  if (
    input.name !== undefined &&
    (!packageCoordinate.ok || !isValidSkillName(input.name))
  ) {
    return {
      ok: false,
      reason: packageCoordinate.ok
        ? "invalid --name activation name"
        : "--name is only valid for Package coordinates"
    };
  }

  let versionRequirement: string | undefined;
  if (input.version !== undefined) {
    const parsed = parseReleaseRequirement(input.version);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: "invalid --version requirement"
      };
    }
    versionRequirement = parsed.value.canonical;
  }

  const directRequirement: DirectInstallRequirement =
    packageCoordinate.ok
      ? input.gitRef === undefined
        ? {
            kind: "package",
            coordinate: packageCoordinate.value,
            sourceKind: "github-release",
            ...(versionRequirement === undefined
              ? {}
              : { versionRequirement })
          }
        : {
            kind: "package",
            coordinate: packageCoordinate.value,
            sourceKind: "git",
            requestedRef: input.gitRef
          }
      : input.gitRef === undefined
        ? {
            kind: "repository",
            coordinate: repository!,
            sourceKind: "github-release",
            ...(versionRequirement === undefined
              ? {}
              : { versionRequirement })
          }
        : {
            kind: "repository",
            coordinate: repository!,
            sourceKind: "git",
            requestedRef: input.gitRef
          };

  return {
    ok: true,
    value: {
      directRequirement,
      ...(input.name === undefined
        ? {}
        : {
            requestedProjectionRename: {
              packageCoordinate:
                packageCoordinate.ok
                  ? packageCoordinate.value.canonical
                  : "",
              activationName: input.name
            }
          })
    }
  };
}

export async function executeCliInstall(
  input: CliInstallInvocation
): Promise<Result<CliInstallExecution, ProductError>> {
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
  input: CliInstallInvocation,
  home: SkiloomHomePaths,
  userHome: string,
  lock: OperationLockSession
): Promise<Result<CliInstallExecution, ProductError>> {
  const status = await readCliStatus(input.target, userHome);
  if (!status.ok) {
    return status;
  }
  if (
    status.value.registry === null &&
    status.value.marker !== null
  ) {
    return {
      ok: false,
      error: productError("InstallTargetRequiresRecovery", {
        path: input.target.path,
        targetId: status.value.marker.targetId
      })
    };
  }

  const existingTargetId =
    status.value.registry?.targetId;
  let registry: MachineRegistry | undefined;
  try {
    if (
      existingTargetId !== undefined ||
      freshInstallNeedsRegistry(input)
    ) {
      const { openMachineRegistry } =
        await import("../runtime/registry/index.js");
      const opened = await openMachineRegistry(home, lock);
      if (!opened.ok) {
        return opened;
      }
      registry = opened.value;
    }

    const transport = createGitHubJsonFetchTransport();
    const repositoryTransport =
      createGitHubRepositoryFetchTransport();
    let presentationRendered = false;
    const acceptance = createCliCandidateAcceptance(
      input,
      {
        presentCandidate: (plan) => {
          presentationRendered = true;
          process.stdout.write(
            formatInstallCandidate(
              input.target,
              input.intent,
              plan,
              "candidate"
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

    const lifecycle =
      existingTargetId === undefined
        ? await executeFirstAcceptedInstall({
            home,
            targetRoot: input.target.path,
            lock,
            registry: registry ?? planOnlyRegistry(),
            directRequirements: [
              input.intent.directRequirement
            ],
            repositoryTransport,
            transport,
            sourceCachePath: home.sourceCachePath,
            acceptCandidate:
              acceptance.acceptCandidateWithRetarget,
            ...(input.intent.requestedProjectionRename === undefined
              ? {}
              : {
                  requestedProjectionRename:
                    input.intent.requestedProjectionRename
                })
          })
        : await addAcceptedTargetRoots({
            home,
            targetId: existingTargetId,
            targetRoot: input.target.path,
            lock,
            registry: registry!,
            additions: [input.intent.directRequirement],
            repositoryTransport,
            transport,
            sourceCachePath: home.sourceCachePath,
            acceptCandidate:
              acceptance.acceptCandidateWithRetarget,
            ...(input.intent.requestedProjectionRename === undefined
              ? {}
              : {
                  requestedProjectionRename:
                    input.intent.requestedProjectionRename
                })
          });
    if (!lifecycle.ok) {
      return lifecycle;
    }

    return {
      ok: true,
      value: {
        result: lifecycleResult(
          input.target,
          input.intent,
          lifecycle.value.status,
          lifecycle.value.plan,
          "state" in lifecycle.value
            ? lifecycle.value.state
            : undefined
        ),
        presentationRendered
      }
    };
  } finally {
    registry?.close();
  }
}

function freshInstallNeedsRegistry(
  input: CliInstallInvocation
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

function lifecycleResult(
  target: ResolvedCliTarget,
  intent: CliInstallIntent,
  status: CliInstallResult["status"],
  plan: LifecycleCandidatePlan,
  state: RegistryTargetState | undefined
): CliInstallResult {
  return {
    status,
    target,
    directRequirements: plan.directRequirements.map(
      presentDirectRequirement
    ),
    sources: plan.candidate.sourceBindings,
    packages: plan.candidate.packages,
    dependencyEdges: plan.candidate.dependencyEdges,
    comparison: plan.comparison,
    projectionRenames:
      intent.requestedProjectionRename === undefined
        ? []
        : [intent.requestedProjectionRename],
    acceptedState:
      state === undefined
        ? null
        : {
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

export function formatCliInstallResult(
  result: CliInstallResult
): string {
  return formatInstallPresentation(
    result.target,
    result.status,
    result.directRequirements,
    result.sources,
    result.packages,
    result.comparison,
    result.projectionRenames
  );
}

function formatInstallCandidate(
  target: ResolvedCliTarget,
  intent: CliInstallIntent,
  plan: LifecycleCandidatePlan,
  status: string
): string {
  return formatInstallPresentation(
    target,
    status,
    plan.directRequirements.map(presentDirectRequirement),
    plan.candidate.sourceBindings,
    plan.candidate.packages,
    plan.comparison,
    intent.requestedProjectionRename === undefined
      ? []
      : [intent.requestedProjectionRename]
  );
}

function formatInstallPresentation(
  target: ResolvedCliTarget,
  status: string,
  requirements: ReadonlyArray<CliInstallDirectRequirement>,
  sources: LifecycleCandidatePlan["candidate"]["sourceBindings"],
  packages: LifecycleCandidatePlan["candidate"]["packages"],
  comparison: LifecycleCandidatePlan["comparison"],
  renames: ReadonlyArray<TargetProjectionRename>
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

  lines.push("Projection Renames:");
  if (renames.length === 0) {
    lines.push("- none");
  } else {
    for (const rename of renames) {
      lines.push(
        "- " + rename.packageCoordinate +
        " -> " + rename.activationName
      );
    }
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

  const retargets = comparison.sourceDeltas.filter(
    (delta) => delta.kind === "release-retarget"
  );
  lines.push("Warnings / Special Risks:");
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

function planOnlyRegistry(): MachineRegistry {
  const unexpected = (): never => {
    throw new Error(
      "plan-only fresh install touched Machine Registry"
    );
  };
  return {
    close() {},
    pragmas: unexpected,
    readTargetState: unexpected,
    readPendingOperations: unexpected,
    beginPendingOperation: unexpected,
    beginPendingReconciliation: unexpected,
    completePendingOperation: unexpected,
    replaceTargetState: unexpected
  };
}
