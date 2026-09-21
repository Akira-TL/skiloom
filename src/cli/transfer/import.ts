import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import process from "node:process";

import type {
  ExactExportManifest
} from "../../domain/export-package/index.js";
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
  importExactPackage,
  mergeExactPackage
} from "../../runtime/import/index.js";
import type {
  MachineRegistry,
  RegistryTargetStateInput
} from "../../runtime/registry/index.js";
import {
  confirmCliQuestion,
  currentUserHome,
  isInteractiveCli
} from "../candidate-acceptance.js";
import {
  parseCliStatusArguments,
  preflightCurrentTargetCopy,
  readCliStatus,
  requireCurrentTargetCopy
} from "../status.js";
import type {
  ResolvedCliTarget
} from "../target-selector.js";
import {
  sanitizeTransferError
} from "./index.js";

export type CliImportInvocation = Readonly<{
  file: string;
  merge: boolean;
  plan: boolean;
  yes: boolean;
  nonInteractive: boolean;
  target: ResolvedCliTarget;
  json: boolean;
}>;

export type CliImportResult = Readonly<{
  status: "planned" | "declined" | "imported" | "merged";
  file: string;
  mode: ExactExportManifest["mode"];
  merge: boolean;
  generation: number;
  directRequirements:
    RegistryTargetStateInput["directRequirements"];
  sources: RegistryTargetStateInput["resolvedSources"];
  packages: RegistryTargetStateInput["resolvedPackages"];
  dependencyEdges:
    RegistryTargetStateInput["dependencyEdges"];
  projections: ReadonlyArray<Readonly<{
    packageCoordinate: string;
    activationName: string;
    ownership: "managed" | "detached";
  }>>;
}>;

export type CliImportExecution = Readonly<{
  result: CliImportResult;
  presentationRendered: boolean;
}>;

export type ParseCliImportResult =
  | Readonly<{ ok: true; value: CliImportInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliImportArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliImportResult {
  const file = argv[0];
  if (file === undefined || file.startsWith("-")) {
    return {
      ok: false,
      reason: "import requires exactly one file"
    };
  }

  let merge = false;
  let plan = false;
  let yes = false;
  let nonInteractive = false;
  const seen = new Set<string>();
  const targetArgs: string[] = [];

  for (const argument of argv.slice(1)) {
    if (
      argument === "--merge" ||
      argument === "--plan" ||
      argument === "--yes" ||
      argument === "--non-interactive"
    ) {
      if (seen.has(argument)) {
        return {
          ok: false,
          reason: "duplicate " + argument
        };
      }
      seen.add(argument);
      if (argument === "--merge") {
        merge = true;
      } else if (argument === "--plan") {
        plan = true;
      } else if (argument === "--yes") {
        yes = true;
      } else {
        nonInteractive = true;
      }
      continue;
    }
    targetArgs.push(argument);
  }

  const target = parseCliStatusArguments(
    targetArgs,
    process.cwd()
  );
  if (!target.ok) {
    return target;
  }
  return {
    ok: true,
    value: {
      file,
      merge,
      plan,
      yes,
      nonInteractive,
      target: target.value,
      json
    }
  };
}

export async function executeCliImport(
  input: CliImportInvocation
): Promise<Result<CliImportExecution, ProductError>> {
  const userHome = currentUserHome();
  if (input.merge) {
    const current = await preflightCurrentTargetCopy(
      input.target,
      userHome
    );
    if (!current.ok) {
      return transferFailure(current.error);
    }
  }
  const home = resolveSkiloomHomePaths(userHome);
  try {
    await mkdir(home.homeRoot, { recursive: true });
  } catch {
    return transferFailure(
      productError("SkiloomHomeUnavailable", {})
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolve(input.file));
  } catch {
    return transferFailure(
      productError("ExactImportReadFailed", {
        file: basename(input.file)
      })
    );
  }

  const helperExecutable =
    process.env.SKILOOM_LOCK_TEST_BINARY;
  if (helperExecutable === undefined) {
    return transferFailure(
      productError("UnsupportedPlatformCapability", {
        capability: "operation-lock",
        reason: "helper-missing"
      })
    );
  }
  const acquired = await acquireOperationLock({
    helperExecutable: resolve(helperExecutable),
    lockPath: home.operationLockPath
  });
  if (!acquired.ok) {
    return transferFailure(acquired.error);
  }

  const imported = await executeImportWhileLocked(
    input,
    bytes,
    home,
    userHome,
    acquired.value
  );
  const released = await acquired.value.release();
  if (imported.ok && !released.ok) {
    return transferFailure(released.error);
  }
  return imported.ok
    ? imported
    : transferFailure(imported.error);
}

async function executeImportWhileLocked(
  input: CliImportInvocation,
  bytes: Uint8Array,
  home: SkiloomHomePaths,
  userHome: string,
  lock: OperationLockSession
): Promise<Result<CliImportExecution, ProductError>> {
  const status = await readCliStatus(input.target, userHome);
  if (!status.ok) {
    return status;
  }

  if (input.merge) {
    if (status.value.registry === null) {
      return {
        ok: false,
        error: productError(
          "ExactImportMergeTargetUnavailable",
          {
            reason:
              status.value.marker === null
                ? "target-not-registered"
                : "recovery-required"
          }
        )
      };
    }
    const current = requireCurrentTargetCopy(status.value);
    if (!current.ok) {
      return current;
    }
  } else {
    if (status.value.registry !== null) {
      return {
        ok: false,
        error: productError(
          "ExactImportMergeRequired",
          {}
        )
      };
    }
    if (status.value.marker !== null) {
      return {
        ok: false,
        error: productError(
          "ExactImportTargetRequiresRecovery",
          {}
        )
      };
    }
  }

  const targetId = input.merge
    ? status.value.registry!.targetId
    : randomUUID();
  const plannedGeneration = input.merge
    ? status.value.registry!.generation + 1
    : 1;

  const plannedRegistry = await openImportRegistry(
    home,
    lock,
    input.merge
  );
  if (!plannedRegistry.ok) {
    return plannedRegistry;
  }

  let plan;
  try {
    plan = await planExactImport({
      input,
      bytes,
      home,
      lock,
      registry: plannedRegistry.value,
      targetId
    });
  } finally {
    plannedRegistry.value.close();
  }
  if (!plan.ok) {
    return plan;
  }

  const plannedResult = presentImportCandidate(
    input,
    plan.value.manifest,
    plan.value.candidate,
    plannedGeneration,
    "planned"
  );
  if (input.plan) {
    return {
      ok: true,
      value: {
        result: plannedResult,
        presentationRendered: false
      }
    };
  }

  const interactive = isInteractiveCli(input);
  if (!input.yes && !interactive) {
    return {
      ok: false,
      error: productError("InteractionRequired", {
        reason: "ordinary-approval-required",
        repositories: []
      })
    };
  }

  let presentationRendered = false;
  if (!input.yes && interactive) {
    process.stdout.write(
      formatCliImportResult(plannedResult)
    );
    presentationRendered = true;

    if (
      input.merge &&
      !await confirmCliQuestion(
        "Merge this import into the existing Target? [y/N] "
      )
    ) {
      return {
        ok: true,
        value: {
          result: {
            ...plannedResult,
            status: "declined"
          },
          presentationRendered
        }
      };
    }

    if (
      !await confirmCliQuestion(
        "Apply this complete state? [y/N] "
      )
    ) {
      return {
        ok: true,
        value: {
          result: {
            ...plannedResult,
            status: "declined"
          },
          presentationRendered
        }
      };
    }
  }

  const registry = await openImportRegistry(
    home,
    lock,
    true
  );
  if (!registry.ok) {
    return registry;
  }
  try {
    const applied = await applyExactImport({
      input,
      bytes,
      home,
      lock,
      registry: registry.value,
      targetId
    });
    if (!applied.ok) {
      return applied;
    }
    return {
      ok: true,
      value: {
        result: presentImportCandidate(
          input,
          applied.value.manifest,
          applied.value.candidate,
          applied.value.state.generation,
          applied.value.status
        ),
        presentationRendered
      }
    };
  } finally {
    registry.value.close();
  }
}

type NormalizedImportCandidate = Readonly<{
  manifest: ExactExportManifest;
  candidate: RegistryTargetStateInput;
}>;

type NormalizedAppliedImport = NormalizedImportCandidate &
  Readonly<{
    status: "imported" | "merged";
    state: Readonly<{ generation: number }>;
  }>;

async function planExactImport(input: Readonly<{
  input: CliImportInvocation;
  bytes: Uint8Array;
  home: SkiloomHomePaths;
  lock: OperationLockSession;
  registry: MachineRegistry;
  targetId: string;
}>): Promise<Result<NormalizedImportCandidate, ProductError>> {
  if (input.input.merge) {
    const planned = await mergeExactPackage({
      home: input.home,
      targetId: input.targetId,
      targetRoot: input.input.target.path,
      lock: input.lock,
      registry: input.registry,
      bytes: input.bytes,
      authorizeMerge: () => true,
      acceptSources: () => false
    });
    return planned.ok
      ? {
          ok: true,
          value: {
            manifest: planned.value.manifest,
            candidate: planned.value.candidate
          }
        }
      : planned;
  }

  const planned = await importExactPackage({
    home: input.home,
    targetRoot: input.input.target.path,
    lock: input.lock,
    registry: input.registry,
    bytes: input.bytes,
    acceptSources: () => false,
    createTargetId: () => input.targetId
  });
  return planned.ok
    ? {
        ok: true,
        value: {
          manifest: planned.value.manifest,
          candidate: planned.value.candidate
        }
      }
    : planned;
}

async function applyExactImport(input: Readonly<{
  input: CliImportInvocation;
  bytes: Uint8Array;
  home: SkiloomHomePaths;
  lock: OperationLockSession;
  registry: MachineRegistry;
  targetId: string;
}>): Promise<Result<NormalizedAppliedImport, ProductError>> {
  if (input.input.merge) {
    const merged = await mergeExactPackage({
      home: input.home,
      targetId: input.targetId,
      targetRoot: input.input.target.path,
      lock: input.lock,
      registry: input.registry,
      bytes: input.bytes,
      authorizeMerge: () => true,
      acceptSources: () => true
    });
    if (!merged.ok) {
      return merged;
    }
    if (merged.value.status !== "merged") {
      return acceptanceFailed();
    }
    return {
      ok: true,
      value: {
        status: "merged",
        manifest: merged.value.manifest,
        candidate: merged.value.candidate,
        state: merged.value.state
      }
    };
  }

  const imported = await importExactPackage({
    home: input.home,
    targetRoot: input.input.target.path,
    lock: input.lock,
    registry: input.registry,
    bytes: input.bytes,
    acceptSources: () => true,
    createTargetId: () => input.targetId
  });
  if (!imported.ok) {
    return imported;
  }
  if (imported.value.status !== "imported") {
    return acceptanceFailed();
  }
  return {
    ok: true,
    value: {
      status: "imported",
      manifest: imported.value.manifest,
      candidate: imported.value.candidate,
      state: imported.value.state
    }
  };
}

async function openImportRegistry(
  home: SkiloomHomePaths,
  lock: OperationLockSession,
  allowCreate: boolean
): Promise<Result<MachineRegistry, ProductError>> {
  if (!allowCreate && !(await pathExists(home.registryPath))) {
    return {
      ok: true,
      value: planOnlyRegistry()
    };
  }
  const { openMachineRegistry } =
    await import("../../runtime/registry/index.js");
  return openMachineRegistry(home, lock);
}

function planOnlyRegistry(): MachineRegistry {
  const unexpected = (): never => {
    throw new Error(
      "plan-only import touched Machine Registry mutation"
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
    observeTargetLocation: unexpected,
    replaceDependencyObservations: unexpected,
    replaceTargetState: unexpected
  };
}

function presentImportCandidate(
  input: CliImportInvocation,
  manifest: ExactExportManifest,
  candidate: RegistryTargetStateInput,
  generation: number,
  status: CliImportResult["status"]
): CliImportResult {
  return {
    status,
    file: basename(input.file),
    mode: manifest.mode,
    merge: input.merge,
    generation,
    directRequirements: candidate.directRequirements,
    sources: candidate.resolvedSources,
    packages: candidate.resolvedPackages,
    dependencyEdges: candidate.dependencyEdges,
    projections: candidate.projections.map(
      (projection) => ({
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName,
        ownership: projection.ownership
      })
    )
  };
}

export function formatCliImportResult(
  result: CliImportResult
): string {
  const lines = [
    "Import: " + result.file,
    "Status: " + result.status,
    "Mode: " + result.mode,
    "Merge: " + (result.merge ? "yes" : "no"),
    "Generation: " + result.generation,
    "Direct Install Requirements:"
  ];
  for (const requirement of result.directRequirements) {
    lines.push(
      "- " + requirement.kind + " " +
      requirement.coordinate + " " +
      requirement.sourceKind
    );
  }
  lines.push("Sources:");
  for (const source of result.sources) {
    lines.push(
      "- " + source.repositoryCoordinate +
      " " + source.sourceKind +
      " @ " + source.exactCommit
    );
  }
  lines.push("Packages:");
  for (const packageFact of result.packages) {
    lines.push("- " + packageFact.packageCoordinate);
  }
  lines.push("Dependency Edges:");
  if (result.dependencyEdges.length === 0) {
    lines.push("- none");
  } else {
    for (const edge of result.dependencyEdges) {
      lines.push(
        "- " + edge.fromPackage +
        " -> " + edge.toPackage
      );
    }
  }
  lines.push("Projections / Ownership:");
  for (const projection of result.projections) {
    lines.push(
      "- " + projection.packageCoordinate +
      " -> " + projection.activationName +
      " (" + projection.ownership + ")"
    );
  }
  return lines.join("\n") + "\n";
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

function acceptanceFailed(): Result<never, ProductError> {
  return {
    ok: false,
    error: productError(
      "ExactImportSourceAcceptanceFailed",
      {}
    )
  };
}

function transferFailure(
  error: ProductError
): Result<never, ProductError> {
  return {
    ok: false,
    error: sanitizeTransferError(error)
  };
}
