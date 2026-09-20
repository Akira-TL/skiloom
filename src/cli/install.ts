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
  acceptedInstallNoOp,
  planOnlyInstallRegistry
} from "./install/bootstrap-no-op.js";
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
import {
  resolveCliTarget,
  type ResolvedCliTarget
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

export type CliInstallExecutionPolicy = Readonly<{
  noOpWhenDirectRequirementExists?: boolean;
}>;

type BuildCliInstallIntentInput = Readonly<{
  coordinate: string;
  version?: string;
  gitRef?: string;
  name?: string;
}>;

type CliInstallTargetOptions = Readonly<{
  target?: string;
  host?: string;
  scope?: string;
}>;

export type ParseCliInstallResult =
  | Readonly<{ ok: true; value: CliInstallInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliInstallArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliInstallResult {
  const coordinate = argv[0];
  if (
    coordinate === undefined ||
    coordinate.startsWith("-")
  ) {
    return {
      ok: false,
      reason: "install requires exactly one coordinate"
    };
  }

  let targetOptions: CliInstallTargetOptions = {};
  let version: string | undefined;
  let gitRef: string | undefined;
  let name: string | undefined;
  let plan = false;
  let yes = false;
  let allowReleaseRetarget = false;
  let nonInteractive = false;
  const seenFlags = new Set<string>();

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (
      option === "--plan" ||
      option === "--yes" ||
      option === "--allow-release-retarget" ||
      option === "--non-interactive"
    ) {
      if (seenFlags.has(option)) {
        return {
          ok: false,
          reason: "duplicate " + option
        };
      }
      seenFlags.add(option);
      if (option === "--plan") {
        plan = true;
      } else if (option === "--yes") {
        yes = true;
      } else if (option === "--allow-release-retarget") {
        allowReleaseRetarget = true;
      } else {
        nonInteractive = true;
      }
      continue;
    }

    if (
      option !== "--target" &&
      option !== "--host" &&
      option !== "--scope" &&
      option !== "--version" &&
      option !== "--git" &&
      option !== "--name"
    ) {
      return {
        ok: false,
        reason: "unknown option: " + option
      };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        reason: "missing value for " + option
      };
    }
    index += 1;

    if (
      option === "--target" ||
      option === "--host" ||
      option === "--scope"
    ) {
      const updated = addInstallTargetOption(
        targetOptions,
        option,
        value
      );
      if (!updated.ok) {
        return updated;
      }
      targetOptions = updated.value;
    } else if (option === "--version") {
      if (version !== undefined) {
        return { ok: false, reason: "duplicate --version" };
      }
      version = value;
    } else if (option === "--git") {
      if (gitRef !== undefined) {
        return { ok: false, reason: "duplicate --git" };
      }
      gitRef = value;
    } else {
      if (name !== undefined) {
        return { ok: false, reason: "duplicate --name" };
      }
      name = value;
    }
  }

  const intent = buildCliInstallIntent({
    coordinate,
    ...(version === undefined ? {} : { version }),
    ...(gitRef === undefined ? {} : { gitRef }),
    ...(name === undefined ? {} : { name })
  });
  if (!intent.ok) {
    return intent;
  }

  const target = resolveCliTarget({
    cwd: process.cwd(),
    ...targetOptions
  });
  if (!target.ok) {
    return { ok: false, reason: target.reason };
  }

  return {
    ok: true,
    value: {
      intent: intent.value,
      target: target.value,
      plan,
      yes,
      allowReleaseRetarget,
      nonInteractive,
      json
    }
  };
}

function addInstallTargetOption(
  current: CliInstallTargetOptions,
  option: "--target" | "--host" | "--scope",
  value: string
):
  | Readonly<{ ok: true; value: CliInstallTargetOptions }>
  | Readonly<{ ok: false; reason: string }> {
  const key =
    option === "--target"
      ? "target"
      : option === "--host"
        ? "host"
        : "scope";
  if (current[key] !== undefined) {
    return {
      ok: false,
      reason: "duplicate " + option
    };
  }
  return {
    ok: true,
    value: {
      ...current,
      [key]: value
    }
  };
}

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
  input: CliInstallInvocation,
  policy: CliInstallExecutionPolicy = {}
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
    acquired.value,
    policy
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
  lock: OperationLockSession,
  policy: CliInstallExecutionPolicy
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

    if (
      policy.noOpWhenDirectRequirementExists === true &&
      existingTargetId !== undefined &&
      registry !== undefined &&
      input.intent.requestedProjectionRename === undefined
    ) {
      const noOp = acceptedInstallNoOp(
        registry,
        existingTargetId,
        input.intent.directRequirement
      );
      if (!noOp.ok) {
        return noOp;
      }
      if (noOp.value !== null) {
        return {
          ok: true,
          value: {
            result: lifecycleResult(
              input.target,
              input.intent,
              "no-op",
              noOp.value.plan,
              noOp.value.state
            ),
            presentationRendered: false
          }
        };
      }
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
            registry: registry ?? planOnlyInstallRegistry(),
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
