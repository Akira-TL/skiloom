#!/usr/bin/env node

import process from "node:process";

import type { ProductError } from "../domain/errors/index.js";
import {
  searchSkillsMp,
  type SkillsMpSearchResult
} from "../runtime/catalog/skillsmp.js";
import {
  executeCliInstall,
  formatCliInstallResult,
  parseCliInstallArguments,
  type CliInstallIntent,
  type CliInstallResult
} from "./install.js";
import {
  executeCliRemove,
  formatCliRemoveResult,
  parseCliRemoveArguments,
  type CliRemoveInvocation,
  type CliRemoveResult
} from "./remove/index.js";
import {
  executeCliRecovery,
  formatCliRecoveryResult,
  parseCliRecoveryArguments,
  type CliRecoveryInvocation,
  type CliRecoveryResult
} from "./recovery/index.js";
import {
  executeCliRepair,
  executeCliSync,
  formatCliMaintenanceResult,
  parseCliRepairArguments,
  parseCliSyncArguments,
  type CliMaintenanceResult,
  type CliRepairInvocation,
  type CliSyncInvocation
} from "./maintenance/index.js";
import {
  executeCliLocalOperation,
  formatCliLocalResult,
  parseCliLocalArguments,
  type CliLocalInvocation,
  type CliLocalOperation,
  type CliLocalResult
} from "./local/index.js";
import {
  parseCliStatusArguments,
  readCliStatus,
  type CliStatusResult
} from "./status.js";
import type {
  ResolvedCliTarget
} from "./target-selector.js";
import {
  executeCliUpdate,
  formatCliUpdateResult,
  parseCliUpdateArguments,
  type CliUpdateInvocation,
  type CliUpdateResult
} from "./update.js";
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

type ParsedSearch = Readonly<{
  command: "search";
  query: string;
  json: boolean;
}>;

type ParsedInstall = Readonly<{
  command: "install";
  intent: CliInstallIntent;
  target: ResolvedCliTarget;
  plan: boolean;
  yes: boolean;
  allowReleaseRetarget: boolean;
  nonInteractive: boolean;
  json: boolean;
}>;

type ParsedUpdate = CliUpdateInvocation &
  Readonly<{ command: "update" }>;

type ParsedRemove = CliRemoveInvocation & Readonly<{ command: "remove" }>;
type ParsedRecovery = CliRecoveryInvocation & Readonly<{ command: "recover" | "fork" }>;
type ParsedSync = CliSyncInvocation & Readonly<{ command: "sync" }>;
type ParsedRepair = CliRepairInvocation & Readonly<{ command: "repair" }>;
type ParsedLocal = CliLocalInvocation &
  Readonly<{ command: CliLocalOperation }>;

type ParsedCommand =
  | ParsedValidate
  | ParsedStatus
  | ParsedSearch
  | ParsedInstall
  | ParsedUpdate
  | ParsedRemove
  | ParsedRecovery
  | ParsedSync
  | ParsedRepair
  | ParsedLocal;

type ParsedCandidate =
  | ParsedInstall
  | ParsedUpdate
  | ParsedRemove
  | ParsedRecovery;

type CandidateCliResult =
  | CliInstallResult
  | CliUpdateResult
  | CliRemoveResult
  | CliRecoveryResult;

type CandidateCliExecution = Readonly<{
  result: CandidateCliResult;
  presentationRendered: boolean;
}>;

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
    case "search":
      return runSearch(parsed.value);
    case "install":
    case "update":
    case "remove":
    case "recover":
    case "fork":
      return runCandidate(parsed.value);
    case "sync":
      return runSync(parsed.value);
    case "repair":
      return runRepair(parsed.value);
    case "rename":
    case "detach":
    case "rebind":
    case "forget":
      return runLocal(parsed.value);
  }
}

async function runValidate(command: ParsedValidate): Promise<number> {
  const validated = await validateLocalPath(command.path);
  if (!validated.ok) {
    return renderOperationFailure(
      command.command,
      command.json,
      validated.error,
      1
    );
  }
  renderSuccess(command.command, validated.value, command.json);
  return 0;
}

async function runSearch(command: ParsedSearch): Promise<number> {
  const searched = await searchSkillsMp(command.query);
  if (!searched.ok) {
    return renderOperationFailure(
      command.command,
      command.json,
      searched.error,
      1
    );
  }
  renderSuccess(command.command, searched.value, command.json);
  return 0;
}

async function runCandidate(
  command: ParsedCandidate
): Promise<number> {
  const executed =
    command.command === "install"
      ? await executeCliInstall(command)
      : command.command === "update"
        ? await executeCliUpdate(command)
        : command.command === "remove"
          ? await executeCliRemove(command)
          : await executeCliRecovery(command);
  return executed.ok
    ? renderCandidateSuccess(
        command.command,
        command.json,
        executed.value
      )
    : renderCandidateFailure(
        command.command,
        command.json,
        executed.error
      );
}

async function runSync(command: ParsedSync): Promise<number> {
  return runMaintenance(
    command.command,
    command.json,
    executeCliSync(command)
  );
}

async function runRepair(command: ParsedRepair): Promise<number> {
  return runMaintenance(
    command.command,
    command.json,
    executeCliRepair(command)
  );
}

async function runLocal(command: ParsedLocal): Promise<number> {
  const operated = await executeCliLocalOperation(command);
  if (!operated.ok) {
    return renderOperationFailure(
      command.command,
      command.json,
      operated.error,
      1
    );
  }
  renderSuccess(command.command, operated.value, command.json);
  return 0;
}

async function runMaintenance(
  command: "sync" | "repair",
  json: boolean,
  pending: Promise<
    | Readonly<{ ok: true; value: CliMaintenanceResult }>
    | Readonly<{ ok: false; error: ProductError }>
  >
): Promise<number> {
  const maintained = await pending;
  if (!maintained.ok) {
    return renderOperationFailure(
      command,
      json,
      maintained.error,
      1
    );
  }
  renderSuccess(command, maintained.value, json);
  return 0;
}

function renderCandidateSuccess(
  command: string,
  json: boolean,
  execution: CandidateCliExecution
): number {
  const exitCode =
    execution.result.status === "declined" ? 3 : 0;
  if (execution.presentationRendered && !json) {
    process.stdout.write(
      "Status: " + execution.result.status + "\n"
    );
  } else {
    renderSuccess(command, execution.result, json);
  }
  return exitCode;
}

function renderCandidateFailure(
  command: string,
  json: boolean,
  error: ProductError
): number {
  return renderOperationFailure(
    command,
    json,
    error,
    error.code === "InteractionRequired" ? 3 : 1
  );
}

function renderOperationFailure(
  command: string,
  json: boolean,
  error: ProductError,
  exitCode: number
): number {
  renderFailure(command, error, json, exitCode);
  return exitCode;
}

async function runStatus(command: ParsedStatus): Promise<number> {
  const status = await readCliStatus(command.target);
  if (!status.ok) {
    return renderOperationFailure(
      command.command,
      command.json,
      status.error,
      1
    );
  }
  renderSuccess(command.command, status.value, command.json);
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
    case "search":
      return parseSearch(
        withoutJson.slice(1),
        json
      );
    case "install":
      return parseInstall(
        withoutJson.slice(1),
        json
      );
    case "update":
      return parseUpdate(withoutJson.slice(1), json);
    case "remove":
      return parseRemove(withoutJson.slice(1), json);
    case "recover":
      return parseRecovery(
        "recover",
        withoutJson.slice(1),
        json
      );
    case "fork":
      return parseRecovery(
        "fork",
        withoutJson.slice(1),
        json
      );
    case "sync":
      return parseSync(withoutJson.slice(1), json);
    case "repair":
      return parseRepair(withoutJson.slice(1), json);
    case "rename":
    case "detach":
    case "rebind":
    case "forget":
      return parseLocal(
        command,
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

function parseSearch(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedSearch }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const query = argv[0];
  if (
    argv.length !== 1 ||
    query === undefined ||
    query.startsWith("-")
  ) {
    return usage(
      "search",
      json,
      "search requires exactly one query"
    );
  }
  if (query.trim().length === 0) {
    return usage(
      "search",
      json,
      "search query must not be empty"
    );
  }

  return {
    ok: true,
    value: {
      command: "search",
      query,
      json
    }
  };
}

function parseInstall(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedInstall }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliInstallArguments(argv, json);
  if (!parsed.ok) {
    return usage("install", json, parsed.reason);
  }
  return {
    ok: true,
    value: {
      command: "install",
      ...parsed.value
    }
  };
}

function parseUpdate(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedUpdate }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliUpdateArguments(argv, json);
  if (!parsed.ok) {
    return usage("update", json, parsed.reason);
  }
  return {
    ok: true,
    value: {
      command: "update",
      ...parsed.value
    }
  };
}

function parseRemove(argv: ReadonlyArray<string>, json: boolean):
  | Readonly<{ ok: true; value: ParsedRemove }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliRemoveArguments(argv, json);
  if (!parsed.ok) {
    return usage("remove", json, parsed.reason);
  }
  return {
    ok: true,
    value: {
      command: "remove",
      ...parsed.value
    }
  };
}

function parseRecovery(
  command: "recover" | "fork",
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedRecovery }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliRecoveryArguments(command, argv, json);
  return parsed.ok
    ? { ok: true, value: { command, ...parsed.value } }
    : usage(command, json, parsed.reason);
}

function parseSync(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedSync }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliSyncArguments(argv, json);
  if (!parsed.ok) {
    return usage("sync", json, parsed.reason);
  }
  return {
    ok: true,
    value: {
      command: "sync",
      ...parsed.value
    }
  };
}

function parseRepair(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedRepair }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliRepairArguments(argv, json);
  if (!parsed.ok) {
    return usage("repair", json, parsed.reason);
  }
  return {
    ok: true,
    value: {
      command: "repair",
      ...parsed.value
    }
  };
}

function parseLocal(
  command: CliLocalOperation,
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedLocal }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliLocalArguments(
    command,
    argv,
    json
  );
  if (!parsed.ok) {
    return usage(command, json, parsed.reason);
  }
  return {
    ok: true,
    value: {
      command,
      ...parsed.value
    }
  };
}

function parseStatus(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedStatus }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliStatusArguments(
    argv,
    process.cwd()
  );
  if (!parsed.ok) {
    return usage("status", json, parsed.reason);
  }
  return {
    ok: true,
    value: {
      command: "status",
      target: parsed.value,
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
  result:
    | ValidateLocalPathResult
    | CliStatusResult
    | SkillsMpSearchResult
    | CliInstallResult
    | CliUpdateResult
    | CliRemoveResult
    | CliRecoveryResult
    | CliMaintenanceResult
    | CliLocalResult,
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
  if (command === "install") {
    process.stdout.write(
      formatCliInstallResult(result as CliInstallResult)
    );
    return;
  }
  if (command === "remove") {
    process.stdout.write(
      formatCliRemoveResult(result as CliRemoveResult)
    );
    return;
  }
  if (command === "recover" || command === "fork") {
    process.stdout.write(
      formatCliRecoveryResult(result as CliRecoveryResult)
    );
    return;
  }
  if (command === "sync" || command === "repair") {
    process.stdout.write(
      formatCliMaintenanceResult(
        result as CliMaintenanceResult
      )
    );
    return;
  }
  if (
    command === "rename" ||
    command === "detach" ||
    command === "rebind" ||
    command === "forget"
  ) {
    process.stdout.write(
      formatCliLocalResult(result as CliLocalResult)
    );
    return;
  }
  if (command === "update") {
    process.stdout.write(
      formatCliUpdateResult(result as CliUpdateResult)
    );
    return;
  }
  if (command === "search") {
    const search = result as SkillsMpSearchResult;
    for (const candidate of search.candidates) {
      const source = candidate.githubRepository === null
        ? "display-only"
        : candidate.githubRepository;
      process.stdout.write(
        `[SkillsMP] ${candidate.name} — ${source}\n`
      );
    }
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
