import process from "node:process";

import type {
  ProductError,
  Result
} from "../../domain/errors/index.js";
import {
  inspectDoctorTarget,
  type DoctorInspection
} from "../../runtime/doctor/index.js";
import {
  resolveSkiloomHomePaths
} from "../../runtime/home.js";
import {
  currentUserHome
} from "../candidate-acceptance.js";
import {
  parseCliStatusArguments
} from "../status.js";
import type {
  ResolvedCliTarget
} from "../target-selector.js";

export type CliDoctorInvocation = Readonly<{
  target: ResolvedCliTarget;
  json: boolean;
}>;

export type CliDoctorResult =
  DoctorInspection &
  Readonly<{
    target: ResolvedCliTarget;
  }>;

export type ParseCliDoctorResult =
  | Readonly<{ ok: true; value: CliDoctorInvocation }>
  | Readonly<{ ok: false; reason: string }>;

export function parseCliDoctorArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliDoctorResult {
  const target = parseCliStatusArguments(
    argv,
    process.cwd()
  );
  return target.ok
    ? {
        ok: true,
        value: {
          target: target.value,
          json
        }
      }
    : target;
}

export async function executeCliDoctor(
  input: CliDoctorInvocation
): Promise<Result<CliDoctorResult, ProductError>> {
  const inspected = await inspectDoctorTarget({
    home: resolveSkiloomHomePaths(currentUserHome()),
    targetRoot: input.target.path
  });
  return inspected.ok
    ? {
        ok: true,
        value: {
          ...inspected.value,
          target: input.target
        }
      }
    : inspected;
}

export function formatCliDoctorResult(
  result: CliDoctorResult
): string {
  const lines = [
    "Target: " + result.target.path,
    "Status: " + result.status,
    "Diagnostics:"
  ];

  if (result.diagnostics.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of result.diagnostics) {
      lines.push(
        "- [" + entry.severity + "] " +
        entry.code +
        (entry.subject === null
          ? ""
          : " — " + entry.subject) +
        (entry.recommendation === null
          ? ""
          : " — recommended: skiloom " +
            entry.recommendation)
      );
    }
  }

  lines.push("Dependency observations:");
  if (result.dependencyObservations.length === 0) {
    lines.push("- none");
  } else {
    for (const observation of result.dependencyObservations) {
      lines.push(
        "- " + observation.packageCoordinate +
        " — " + observation.kind +
        " " + observation.name +
        ": " + observation.status
      );
    }
  }

  return lines.join("\n") + "\n";
}
