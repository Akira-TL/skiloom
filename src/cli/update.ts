import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

import {
  productError,
  type ProductError,
  type Result
} from "../domain/errors/index.js";
import type {
  DirectInstallRequirement
} from "../domain/resolver/index.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../native/skiloom-lock.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../runtime/home.js";
import {
  createNonInteractiveLifecycleAcceptance
} from "../runtime/orchestration/lifecycle/acceptance.js";
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
  readCliStatus
} from "./status.js";
import {
  resolveCliTarget,
  type ResolvedCliTarget
} from "./target-selector.js";

export type CliUpdateInvocation = Readonly<{
  target: ResolvedCliTarget;
  plan: boolean;
  yes: boolean;
  allowReleaseRetarget: boolean;
  nonInteractive: boolean;
  json: boolean;
}>;

export type CliUpdateDirectRequirement = Readonly<{
  kind: "package" | "repository";
  coordinate: string;
  sourceKind: "github-release" | "git";
  versionRequirement?: string;
  requestedRef?: string;
}>;

export type CliUpdateResult = Readonly<{
  status: "planned" | "declined" | "updated" | "no-op";
  target: ResolvedCliTarget;
  directRequirements: ReadonlyArray<CliUpdateDirectRequirement>;
  sources: LifecycleCandidatePlan["candidate"]["sourceBindings"];
  packages: LifecycleCandidatePlan["candidate"]["packages"];
  dependencyEdges: LifecycleCandidatePlan["candidate"]["dependencyEdges"];
  comparison: LifecycleCandidatePlan["comparison"];
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

export type ParseCliUpdateResult =
  | Readonly<{ ok: true; value: CliUpdateInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliUpdateArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliUpdateResult {
  let target: string | undefined;
  let host: string | undefined;
  let scope: string | undefined;
  let plan = false;
  let yes = false;
  let allowReleaseRetarget = false;
  let nonInteractive = false;
  const seenFlags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (
      option === "--plan" ||
      option === "--yes" ||
      option === "--allow-release-retarget" ||
      option === "--non-interactive"
    ) {
      if (seenFlags.has(option)) {
        return { ok: false, reason: "duplicate " + option };
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
      option !== "--scope"
    ) {
      return { ok: false, reason: "unknown option: " + option };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        reason: "missing value for " + option
      };
    }
    index += 1;

    if (option === "--target") {
      if (target !== undefined) {
        return { ok: false, reason: "duplicate --target" };
      }
      target = value;
    } else if (option === "--host") {
      if (host !== undefined) {
        return { ok: false, reason: "duplicate --host" };
      }
      host = value;
    } else {
      if (scope !== undefined) {
        return { ok: false, reason: "duplicate --scope" };
      }
      scope = value;
    }
  }

  const resolved = resolveCliTarget({
    cwd: process.cwd(),
    ...(target === undefined ? {} : { target }),
    ...(host === undefined ? {} : { host }),
    ...(scope === undefined ? {} : { scope })
  });
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  return {
    ok: true,
    value: {
      target: resolved.value,
      plan,
      yes,
      allowReleaseRetarget,
      nonInteractive,
      json
    }
  };
}

export async function executeCliUpdate(
  input: CliUpdateInvocation
): Promise<Result<CliUpdateResult, ProductError>> {
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
): Promise<Result<CliUpdateResult, ProductError>> {
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

    const authorization =
      createNonInteractiveLifecycleAcceptance({
        mode: input.plan ? "plan" : "apply",
        ordinaryApproval: input.yes,
        releaseRetargetApproval:
          input.allowReleaseRetarget
      });
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
      value: lifecycleResult(
        input.target,
        lifecycle.value.status,
        lifecycle.value.plan,
        lifecycle.value.state
      )
    };
  } finally {
    registry?.close();
  }
}

function lifecycleResult(
  target: ResolvedCliTarget,
  status: CliUpdateResult["status"],
  plan: LifecycleCandidatePlan,
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

function presentDirectRequirement(
  requirement: DirectInstallRequirement
): CliUpdateDirectRequirement {
  return requirement.sourceKind === "git"
    ? {
        kind: requirement.kind,
        coordinate: requirement.coordinate.canonical,
        sourceKind: "git",
        requestedRef: requirement.requestedRef
      }
    : {
        kind: requirement.kind,
        coordinate: requirement.coordinate.canonical,
        sourceKind: "github-release",
        ...(requirement.versionRequirement === undefined
          ? {}
          : {
              versionRequirement:
                requirement.versionRequirement
            })
      };
}

function currentUserHome(): string {
  return process.env.HOME ??
    process.env.USERPROFILE ??
    homedir();
}
