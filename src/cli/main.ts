#!/usr/bin/env node

import process from "node:process";

import type { ProductError } from "../domain/errors/index.js";
import {
  readCliStatus,
  type CliStatusResult
} from "./status.js";
import {
  resolveCliTarget,
  type ResolvedCliTarget
} from "./target-selector.js";
import {
  validateLocalPath,
  type ValidateLocalPathResult
} from "./validate.js";

const CLI_SCHEMA = "SKILOOM-CLI-V1" as const;

type CliWarning = Readonly<Record<string, unknown>>;

type CliSuccess = Readonly<{
  schema: typeof CLI_SCHEMA;
  ok: true;
  command: string;
  result: unknown;
  warnings: ReadonlyArray<CliWarning>;
}>;

type CliFailure = Readonly<{
  schema: typeof CLI_SCHEMA;
  ok: false;
  command: string;
  error: ProductError;
  warnings: ReadonlyArray<CliWarning>;
}>;

type ParsedValidate = Readonly<{
  command: "validate";
  path: string;
  json: boolean;
}>;

type ParsedStatus = Readonly<{
  command: "status";
  target: ResolvedCliTarget;
  json: boolean;
}>;

type ParsedCommand =
  | ParsedValidate
  | ParsedStatus;

type UsageFailure = Readonly<{
  command: string;
  json: boolean;
  error: ProductError<
    "InvalidArguments",
    Readonly<{ reason: string }>
  >;
}>;

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) {
    renderFailure(
      parsed.value.command,
      parsed.value.error,
      parsed.value.json,
      2
    );
    return 2;
  }

  switch (parsed.value.command) {
    case "validate":
      return runValidate(parsed.value);
    case "status":
      return runStatus(parsed.value);
  }
}

async function runValidate(
  command: ParsedValidate
): Promise<number> {
  const validated = await validateLocalPath(command.path);
  if (!validated.ok) {
    renderFailure(
      command.command,
      validated.error,
      command.json,
      1
    );
    return 1;
  }

  renderSuccess(
    command.command,
    validated.value,
    command.json
  );
  return 0;
}

async function runStatus(
  command: ParsedStatus
): Promise<number> {
  const status = await readCliStatus(command.target);
  if (!status.ok) {
    renderFailure(
      command.command,
      status.error,
      command.json,
      1
    );
    return 1;
  }

  renderSuccess(
    command.command,
    status.value,
    command.json
  );
  return 0;
}

function parseArguments(
  argv: ReadonlyArray<string>
):
  | Readonly<{ ok: true; value: ParsedCommand }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const jsonCount = argv.filter(
    (argument) => argument === "--json"
  ).length;
  const json = jsonCount > 0;
  const withoutJson = argv.filter(
    (argument) => argument !== "--json"
  );
  const command = withoutJson[0] ?? "";

  if (jsonCount > 1) {
    return usage(command, json, "duplicate --json");
  }

  switch (command) {
    case "validate":
      return parseValidate(
        withoutJson.slice(1),
        json
      );
    case "status":
      return parseStatus(
        withoutJson.slice(1),
        json
      );
    default:
      return usage(
        command,
        json,
        "unknown or missing command"
      );
  }
}

function parseValidate(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedValidate }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const option = argv.find((argument) =>
    argument.startsWith("-")
  );
  if (option !== undefined) {
    return usage(
      "validate",
      json,
      `unknown option: ${option}`
    );
  }
  if (argv.length > 1) {
    return usage(
      "validate",
      json,
      "validate accepts at most one path"
    );
  }

  return {
    ok: true,
    value: {
      command: "validate",
      path: argv[0] ?? process.cwd(),
      json
    }
  };
}

function parseStatus(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedStatus }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  let target: string | undefined;
  let host: string | undefined;
  let scope: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (
      option !== "--target" &&
      option !== "--host" &&
      option !== "--scope"
    ) {
      return usage(
        "status",
        json,
        `unknown option: ${option}`
      );
    }
    const value = argv[index + 1];
    if (
      value === undefined ||
      value.startsWith("--")
    ) {
      return usage(
        "status",
        json,
        `missing value for ${option}`
      );
    }
    index += 1;

    if (option === "--target") {
      if (target !== undefined) {
        return usage(
          "status",
          json,
          "duplicate --target"
        );
      }
      target = value;
    } else if (option === "--host") {
      if (host !== undefined) {
        return usage(
          "status",
          json,
          "duplicate --host"
        );
      }
      host = value;
    } else {
      if (scope !== undefined) {
        return usage(
          "status",
          json,
          "duplicate --scope"
        );
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
    return usage(
      "status",
      json,
      resolved.reason
    );
  }

  return {
    ok: true,
    value: {
      command: "status",
      target: resolved.value,
      json
    }
  };
}

function usage(
  command: string,
  json: boolean,
  reason: string
): Readonly<{ ok: false; value: UsageFailure }> {
  return {
    ok: false,
    value: {
      command,
      json,
      error: {
        code: "InvalidArguments",
        facts: { reason }
      }
    }
  };
}

function renderSuccess(
  command: string,
  result: ValidateLocalPathResult | CliStatusResult,
  json: boolean
): void {
  if (json) {
    const output: CliSuccess = {
      schema: CLI_SCHEMA,
      ok: true,
      command,
      result,
      warnings: []
    };
    process.stdout.write(
      JSON.stringify(output) + "\n"
    );
    return;
  }

  if (command === "validate") {
    process.stdout.write(
      `Valid Skiloom package: ${(result as ValidateLocalPathResult).path}\n`
    );
    return;
  }

  const status = result as CliStatusResult;
  process.stdout.write(
    `Target: ${status.target.path}\n` +
      `Registry: ${status.registry === null ? "unregistered" : status.registry.targetId}\n` +
      `Marker: ${status.marker === null ? "absent" : status.marker.targetId}\n`
  );
}

function renderFailure(
  command: string,
  error: ProductError,
  json: boolean,
  exitCode: number
): void {
  if (json) {
    const output: CliFailure = {
      schema: CLI_SCHEMA,
      ok: false,
      command,
      error,
      warnings: []
    };
    process.stdout.write(
      JSON.stringify(output) + "\n"
    );
    return;
  }

  process.stderr.write(
    `skiloom: ${error.code} (exit ${exitCode})\n`
  );
}

process.exitCode = await main();
