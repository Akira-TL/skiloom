#!/usr/bin/env node

import process from "node:process";

import type { ProductError } from "../domain/errors/index.js";
import {
  catalogProviderWarnings,
  hostPresetWarnings
} from "./diagnostics/index.js";
import {
  executeCliBootstrap,
  parseCliBootstrapArguments,
  type CliBootstrapInvocation,
  type CliBootstrapResult
} from "./bootstrap/index.js";
import {
  executeCliDoctor,
  parseCliDoctorArguments,
  type CliDoctorInvocation
} from "./doctor/index.js";
import {
  searchSkillsMp
} from "../runtime/catalog/skillsmp.js";
import {
  executeCliInstall,
  parseCliInstallArguments,
  type CliInstallInvocation,
  type CliInstallResult
} from "./install.js";
import {
  executeCliRemove,
  parseCliRemoveArguments,
  type CliRemoveInvocation,
  type CliRemoveResult
} from "./remove/index.js";
import {
  executeCliRecovery,
  parseCliRecoveryArguments,
  type CliRecoveryInvocation,
  type CliRecoveryResult
} from "./recovery/index.js";
import {
  executeCliRepair,
  executeCliSync,
  parseCliRepairArguments,
  parseCliSyncArguments,
  type CliRepairInvocation,
  type CliSyncInvocation
} from "./maintenance/index.js";
import {
  executeCliLocalOperation,
  parseCliLocalArguments,
  type CliLocalInvocation,
  type CliLocalOperation
} from "./local/index.js";
import {
  executeCliObserve,
  parseCliObserveArguments,
  type CliObserveInvocation
} from "./observe/index.js";
import {
  renderFailure,
  renderSuccess
} from "./output/index.js";
import {
  parseCliSearchArguments
} from "./search/index.js";
import {
  parseCliStatusArguments,
  readCliStatus
} from "./status.js";
import type {
  ResolvedCliTarget
} from "./target-selector.js";
import {
  executeCliExport,
  parseCliExportArguments,
  type CliExportInvocation
} from "./transfer/index.js";
import {
  executeCliImport,
  parseCliImportArguments,
  type CliImportInvocation,
  type CliImportResult
} from "./transfer/import.js";
import {
  executeCliUpdate,
  parseCliUpdateArguments,
  type CliUpdateInvocation,
  type CliUpdateResult
} from "./update.js";
import {
  parseCliValidateArguments,
  validateLocalPath
} from "./validate.js";

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
type ParsedDoctor = CliDoctorInvocation & Readonly<{ command: "doctor" }>;

type ParsedSearch = Readonly<{
  command: "search";
  query: string;
  json: boolean;
}>;

type ParsedInstall =
  CliInstallInvocation & Readonly<{ command: "install" }>;
type ParsedUpdate =
  CliUpdateInvocation & Readonly<{ command: "update" }>;
type ParsedRemove =
  CliRemoveInvocation & Readonly<{ command: "remove" }>;
type ParsedRecovery =
  CliRecoveryInvocation & Readonly<{ command: "recover" | "fork" }>;
type ParsedSync = CliSyncInvocation & Readonly<{ command: "sync" }>;
type ParsedRepair = CliRepairInvocation & Readonly<{ command: "repair" }>;
type ParsedLocal =
  CliLocalInvocation & Readonly<{ command: CliLocalOperation }>;
type ParsedObserve =
  CliObserveInvocation & Readonly<{ command: "observe" }>;
type ParsedExport = CliExportInvocation & Readonly<{ command: "export" }>;
type ParsedImport = CliImportInvocation & Readonly<{ command: "import" }>;
type ParsedBootstrap =
  CliBootstrapInvocation & Readonly<{ command: "bootstrap" }>;

type ParsedCommand =
  | ParsedValidate
  | ParsedStatus
  | ParsedDoctor
  | ParsedSearch
  | ParsedInstall
  | ParsedUpdate
  | ParsedRemove
  | ParsedRecovery
  | ParsedSync
  | ParsedRepair
  | ParsedLocal
  | ParsedObserve
  | ParsedExport
  | ParsedImport
  | ParsedBootstrap;

type ParsedCandidate =
  | ParsedInstall
  | ParsedUpdate
  | ParsedRemove
  | ParsedRecovery
  | ParsedImport
  | ParsedBootstrap;

type CandidateCliResult =
  | CliInstallResult
  | CliUpdateResult
  | CliRemoveResult
  | CliRecoveryResult
  | CliImportResult
  | CliBootstrapResult;

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
    case "doctor":
      return runDoctor(parsed.value);
    case "search":
      return runSearch(parsed.value);
    case "install":
    case "update":
    case "remove":
    case "recover":
    case "fork":
    case "import":
    case "bootstrap":
      return runCandidate(parsed.value);
    case "sync":
    case "repair":
      return runMaintenance(parsed.value);
    case "export":
      return runExport(parsed.value);
    case "rename":
    case "detach":
    case "rebind":
    case "forget":
      return runLocal(parsed.value);
    case "observe":
      return runObserve(parsed.value);
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

async function runDoctor(command: ParsedDoctor): Promise<number> {
  const warnings = hostPresetWarnings(command.target);
  const inspected = await executeCliDoctor(command);
  if (!inspected.ok) {
    return renderOperationFailure(
      command.command,
      command.json,
      inspected.error,
      1,
      warnings
    );
  }
  renderSuccess(
    command.command,
    inspected.value,
    command.json,
    warnings
  );
  return 0;
}

async function runSearch(command: ParsedSearch): Promise<number> {
  const warnings = catalogProviderWarnings();
  const searched = await searchSkillsMp(command.query);
  if (!searched.ok) {
    return renderOperationFailure(
      command.command,
      command.json,
      searched.error,
      1,
      warnings
    );
  }
  renderSuccess(
    command.command,
    searched.value,
    command.json,
    warnings
  );
  return 0;
}

async function runCandidate(
  command: ParsedCandidate
): Promise<number> {
  const executed =
    command.command === "install"
      ? await executeCliInstall(command)
      : command.command === "bootstrap"
        ? await executeCliBootstrap(command)
        : command.command === "update"
        ? await executeCliUpdate(command)
        : command.command === "remove"
          ? await executeCliRemove(command)
          : command.command === "import"
            ? await executeCliImport(command)
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

async function runExport(command: ParsedExport): Promise<number> {
  const exported = await executeCliExport(command);
  if (!exported.ok) {
    return renderOperationFailure("export", command.json, exported.error, 1);
  }
  renderSuccess("export", exported.value.result, command.json, exported.value.warnings);
  return 0;
}

async function runLocal(command: ParsedLocal): Promise<number> {
  const operated = await executeCliLocalOperation(command);
  if (!operated.ok) {
    return renderOperationFailure(command.command, command.json, operated.error, 1);
  }
  renderSuccess(command.command, operated.value, command.json);
  return 0;
}

async function runObserve(
  command: ParsedObserve
): Promise<number> {
  const observed = await executeCliObserve(command);
  if (!observed.ok) {
    return renderOperationFailure(
      command.command,
      command.json,
      observed.error,
      1
    );
  }
  renderSuccess(
    command.command,
    observed.value,
    command.json
  );
  return 0;
}

async function runMaintenance(
  command: ParsedSync | ParsedRepair
): Promise<number> {
  const maintained =
    command.command === "sync"
      ? await executeCliSync(command)
      : await executeCliRepair(command);
  if (!maintained.ok) {
    return renderOperationFailure(
      command.command,
      command.json,
      maintained.error,
      1
    );
  }
  renderSuccess(
    command.command,
    maintained.value,
    command.json
  );
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
  exitCode: number,
  warnings: ReadonlyArray<ProductError> = []
): number {
  renderFailure(
    command,
    error,
    json,
    exitCode,
    warnings
  );
  return exitCode;
}

async function runStatus(command: ParsedStatus): Promise<number> {
  const warnings = hostPresetWarnings(command.target);
  const status = await readCliStatus(command.target);
  if (!status.ok) {
    return renderOperationFailure(
      command.command,
      command.json,
      status.error,
      1,
      warnings
    );
  }
  renderSuccess(
    command.command,
    status.value,
    command.json,
    warnings
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
    case "doctor":
      return parseDoctor(withoutJson.slice(1), json);
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
    case "export":
      return parseExport(withoutJson.slice(1), json);
    case "import":
      return parseImport(withoutJson.slice(1), json);
    case "bootstrap":
      return parseBootstrap(
        withoutJson.slice(1),
        json
      );
    case "observe":
      return parseObserve(
        withoutJson.slice(1),
        json
      );
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
  const parsed = parseCliValidateArguments(
    argv,
    process.cwd(),
    json
  );
  return parsed.ok
    ? {
        ok: true,
        value: {
          command: "validate",
          ...parsed.value
        }
      }
    : usage("validate", json, parsed.reason);
}

function parseDoctor(argv: ReadonlyArray<string>, json: boolean):
  | Readonly<{ ok: true; value: ParsedDoctor }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliDoctorArguments(argv, json);
  return parsed.ok
    ? { ok: true, value: { command: "doctor", ...parsed.value } }
    : usage("doctor", json, parsed.reason);
}

function parseSearch(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedSearch }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliSearchArguments(argv, json);
  return parsed.ok
    ? {
        ok: true,
        value: {
          command: "search",
          ...parsed.value
        }
      }
    : usage("search", json, parsed.reason);
}

function parseInstall(argv: ReadonlyArray<string>, json: boolean):
  | Readonly<{ ok: true; value: ParsedInstall }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliInstallArguments(argv, json);
  return parsed.ok
    ? { ok: true, value: { command: "install", ...parsed.value } }
    : usage("install", json, parsed.reason);
}

function parseUpdate(argv: ReadonlyArray<string>, json: boolean):
  | Readonly<{ ok: true; value: ParsedUpdate }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliUpdateArguments(argv, json);
  return parsed.ok
    ? { ok: true, value: { command: "update", ...parsed.value } }
    : usage("update", json, parsed.reason);
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

function parseExport(argv: ReadonlyArray<string>, json: boolean):
  | Readonly<{ ok: true; value: ParsedExport }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliExportArguments(argv, json);
  return parsed.ok
    ? { ok: true, value: { command: "export", ...parsed.value } }
    : usage("export", json, parsed.reason);
}

function parseImport(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedImport }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliImportArguments(argv, json);
  return parsed.ok
    ? { ok: true, value: { command: "import", ...parsed.value } }
    : usage("import", json, parsed.reason);
}

function parseBootstrap(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedBootstrap }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliBootstrapArguments(argv, json);
  return parsed.ok
    ? {
        ok: true,
        value: {
          command: "bootstrap",
          ...parsed.value
        }
      }
    : usage("bootstrap", json, parsed.reason);
}

function parseSync(argv: ReadonlyArray<string>, json: boolean):
  | Readonly<{ ok: true; value: ParsedSync }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliSyncArguments(argv, json);
  return parsed.ok
    ? { ok: true, value: { command: "sync", ...parsed.value } }
    : usage("sync", json, parsed.reason);
}

function parseRepair(argv: ReadonlyArray<string>, json: boolean):
  | Readonly<{ ok: true; value: ParsedRepair }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliRepairArguments(argv, json);
  return parsed.ok
    ? { ok: true, value: { command: "repair", ...parsed.value } }
    : usage("repair", json, parsed.reason);
}

function parseLocal(
  command: CliLocalOperation,
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedLocal }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliLocalArguments(command, argv, json);
  return parsed.ok
    ? { ok: true, value: { command, ...parsed.value } }
    : usage(command, json, parsed.reason);
}

function parseObserve(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedObserve }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliObserveArguments(argv, json);
  return parsed.ok
    ? {
        ok: true,
        value: {
          command: "observe",
          ...parsed.value
        }
      }
    : usage("observe", json, parsed.reason);
}

function parseStatus(argv: ReadonlyArray<string>, json: boolean):
  | Readonly<{ ok: true; value: ParsedStatus }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  const parsed = parseCliStatusArguments(argv, process.cwd());
  return parsed.ok
    ? {
        ok: true,
        value: { command: "status", target: parsed.value, json }
      }
    : usage("status", json, parsed.reason);
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

process.exitCode = await main();
