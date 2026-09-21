import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  parsePackageCoordinate
} from "../../domain/coordinate/index.js";
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
  SPECIAL_OBSERVATION_STATUSES,
  updateSpecialObservation,
  type SpecialObservationAction,
  type SpecialObservationStatus
} from "../../runtime/orchestration/dependency-observation/index.js";
import type {
  MachineRegistry,
  RegistryDependencyObservation
} from "../../runtime/registry/index.js";
import {
  currentUserHome
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

const MAX_OBSERVATION_NAME_LENGTH = 128;
const MAX_OBSERVATION_NOTE_LENGTH = 2048;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type CliObserveInvocation = Readonly<{
  target: ResolvedCliTarget;
  packageCoordinate: string;
  name: string;
  action: SpecialObservationAction;
  json: boolean;
}>;

export type CliObserveResult = Readonly<{
  status: "recorded" | "updated" | "cleared" | "no-op";
  target: ResolvedCliTarget;
  targetId: string;
  generation: number;
  packageCoordinate: string;
  name: string;
  observation: RegistryDependencyObservation | null;
}>;

export type ParseCliObserveResult =
  | Readonly<{ ok: true; value: CliObserveInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliObserveArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliObserveResult {
  const packageText = argv[0];
  const name = argv[1];
  if (
    packageText === undefined ||
    packageText.startsWith("-")
  ) {
    return {
      ok: false,
      reason: "observe requires a Package coordinate"
    };
  }
  const packageCoordinate = parsePackageCoordinate(packageText);
  if (!packageCoordinate.ok) {
    return {
      ok: false,
      reason: "observe requires owner/repo/package"
    };
  }
  if (name === undefined || !validObservationName(name)) {
    return {
      ok: false,
      reason: "observe requires a valid observation name"
    };
  }

  let status: SpecialObservationStatus | undefined;
  let note: string | undefined;
  let clear = false;
  const targetArgs: string[] = [];
  const seen = new Set<string>();

  for (let index = 2; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option === "--clear") {
      if (seen.has(option)) {
        return { ok: false, reason: "duplicate --clear" };
      }
      seen.add(option);
      clear = true;
      continue;
    }

    if (
      option !== "--status" &&
      option !== "--note" &&
      option !== "--target" &&
      option !== "--host" &&
      option !== "--scope"
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
      targetArgs.push(option, value);
      continue;
    }

    if (seen.has(option)) {
      return {
        ok: false,
        reason: "duplicate " + option
      };
    }
    seen.add(option);
    if (option === "--status") {
      if (!isSpecialObservationStatus(value)) {
        return {
          ok: false,
          reason: "invalid --status"
        };
      }
      status = value;
    } else {
      if (!validObservationNote(value)) {
        return {
          ok: false,
          reason: "invalid --note"
        };
      }
      note = value;
    }
  }

  if (clear === (status !== undefined)) {
    return {
      ok: false,
      reason:
        "observe requires exactly one of --status or --clear"
    };
  }
  if (clear && note !== undefined) {
    return {
      ok: false,
      reason: "--note is not valid with --clear"
    };
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
      target: target.value,
      packageCoordinate: packageCoordinate.value.canonical,
      name,
      action: clear
        ? { kind: "clear" }
        : {
            kind: "set",
            status: status!,
            note: note ?? null
          },
      json
    }
  };
}

export async function executeCliObserve(
  input: CliObserveInvocation
): Promise<Result<CliObserveResult, ProductError>> {
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

  const operated = await executeObserveWhileLocked(
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

async function executeObserveWhileLocked(
  input: CliObserveInvocation,
  home: SkiloomHomePaths,
  userHome: string,
  lock: OperationLockSession
): Promise<Result<CliObserveResult, ProductError>> {
  const status = await readCliStatus(input.target, userHome);
  if (!status.ok) {
    return status;
  }
  if (
    status.value.registry === null ||
    status.value.marker === null
  ) {
    return {
      ok: false,
      error: productError("ObservationTargetUnavailable", {
        path: input.target.path,
        reason:
          status.value.registry === null
            ? status.value.marker === null
              ? "target-not-registered"
              : "recovery-required"
            : "marker-missing"
      })
    };
  }
  const current = requireCurrentTargetCopy(status.value);
  if (!current.ok) {
    return current;
  }
  if (
    status.value.marker.targetId !==
      status.value.registry.targetId ||
    status.value.marker.generation !==
      status.value.registry.generation
  ) {
    return {
      ok: false,
      error: productError("ObservationTargetUnavailable", {
        path: input.target.path,
        reason: "marker-stale"
      })
    };
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

    const observed = await updateSpecialObservation({
      registry,
      targetId: status.value.registry.targetId,
      packageCoordinate: input.packageCoordinate,
      name: input.name,
      action: input.action
    });
    if (!observed.ok) {
      return observed;
    }

    return {
      ok: true,
      value: {
        status: observed.value.status,
        target: input.target,
        targetId: observed.value.state.targetId,
        generation: observed.value.state.generation,
        packageCoordinate: input.packageCoordinate,
        name: input.name,
        observation: observed.value.observation
      }
    };
  } finally {
    registry?.close();
  }
}

export function formatCliObserveResult(
  result: CliObserveResult
): string {
  const lines = [
    "Target: " + result.target.path,
    "Status: " + result.status,
    "Target ID: " + result.targetId,
    "Generation: " + result.generation,
    "Package: " + result.packageCoordinate,
    "Observation: " + result.name
  ];
  if (result.observation !== null) {
    lines.push(
      "Observation Status: " + result.observation.status
    );
    if (result.observation.note !== null) {
      lines.push("Note: " + result.observation.note);
    }
  }
  return lines.join("\n") + "\n";
}

function isSpecialObservationStatus(
  value: string
): value is SpecialObservationStatus {
  return (
    SPECIAL_OBSERVATION_STATUSES as ReadonlyArray<string>
  ).includes(value);
}

function validObservationName(value: string): boolean {
  return validObservationText(
    value,
    MAX_OBSERVATION_NAME_LENGTH
  );
}

function validObservationNote(value: string): boolean {
  return validObservationText(
    value,
    MAX_OBSERVATION_NOTE_LENGTH
  );
}

function validObservationText(
  value: string,
  maximumLength: number
): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !CONTROL_CHARACTER.test(value)
  );
}
