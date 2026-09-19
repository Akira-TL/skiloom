#!/usr/bin/env node

import process from "node:process";

import type { ProductError } from "../domain/errors/index.js";
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

type ParsedCommand = ParsedValidate;

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

function parseArguments(
  argv: ReadonlyArray<string>
):
  | Readonly<{ ok: true; value: ParsedCommand }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");
  const command = positional[0] ?? "";

  if (argv.filter((argument) => argument === "--json").length > 1) {
    return usage(command, json, "duplicate --json");
  }
  if (command !== "validate") {
    return usage(command, json, "unknown or missing command");
  }

  const options = argv.filter(
    (argument) =>
      argument.startsWith("-") &&
      argument !== "--json"
  );
  if (options.length > 0) {
    return usage(command, json, `unknown option: ${options[0]}`);
  }

  const operands = positional.slice(1);
  if (operands.length > 1) {
    return usage(command, json, "validate accepts at most one path");
  }

  return {
    ok: true,
    value: {
      command: "validate",
      path: operands[0] ?? process.cwd(),
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
  result: ValidateLocalPathResult,
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
    process.stdout.write(JSON.stringify(output) + "\n");
    return;
  }

  process.stdout.write(
    `Valid Skiloom package: ${result.path}\n`
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
    process.stdout.write(JSON.stringify(output) + "\n");
    return;
  }

  process.stderr.write(
    `skiloom: ${error.code} (exit ${exitCode})\n`
  );
}

process.exitCode = await main();
