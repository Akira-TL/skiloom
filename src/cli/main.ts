#!/usr/bin/env node

import process from "node:process";

import type { ProductError } from "../domain/errors/index.js";
import {
  searchSkillsMp,
  type SkillsMpSearchResult
} from "../runtime/catalog/skillsmp.js";
import {
  buildCliInstallIntent,
  executeCliInstall,
  formatCliInstallResult,
  type CliInstallIntent,
  type CliInstallResult
} from "./install.js";
import {
  readCliStatus,
  type CliStatusResult
} from "./status.js";
import {
  resolveCliTarget,
  type ResolvedCliTarget
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

type ParsedCommand =
  | ParsedValidate
  | ParsedStatus
  | ParsedSearch
  | ParsedInstall
  | ParsedUpdate;

type CandidateCliResult =
  | CliInstallResult
  | CliUpdateResult;

type CandidateCliExecution = Readonly<{
  result: CandidateCliResult;
  presentationRendered: boolean;
}>;

type CliTargetOption =
  | "--target"
  | "--host"
  | "--scope";

type CliTargetOptions = Readonly<{
  target?: string;
  host?: string;
  scope?: string;
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
      return runInstall(parsed.value);
    case "update":
      return runUpdate(parsed.value);
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

async function runInstall(command: ParsedInstall): Promise<number> {
  const installed = await executeCliInstall(command);
  return installed.ok
    ? renderCandidateSuccess(
        command.command,
        command.json,
        installed.value
      )
    : renderCandidateFailure(
        command.command,
        command.json,
        installed.error
      );
}

async function runUpdate(command: ParsedUpdate): Promise<number> {
  const updated = await executeCliUpdate(command);
  return updated.ok
    ? renderCandidateSuccess(
        command.command,
        command.json,
        updated.value
      )
    : renderCandidateFailure(
        command.command,
        command.json,
        updated.error
      );
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
  const coordinate = argv[0];
  if (
    coordinate === undefined ||
    coordinate.startsWith("-")
  ) {
    return usage(
      "install",
      json,
      "install requires exactly one coordinate"
    );
  }

  let targetOptions: CliTargetOptions = {};
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
        return usage(
          "install",
          json,
          "duplicate " + option
        );
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
      !isCliTargetOption(option) &&
      option !== "--version" &&
      option !== "--git" &&
      option !== "--name"
    ) {
      return usage(
        "install",
        json,
        "unknown option: " + option
      );
    }

    const value = argv[index + 1];
    if (
      value === undefined ||
      value.startsWith("--")
    ) {
      return usage(
        "install",
        json,
        "missing value for " + option
      );
    }
    index += 1;

    if (isCliTargetOption(option)) {
      const updated = addCliTargetOption(
        targetOptions,
        option,
        value
      );
      if (!updated.ok) {
        return usage(
          "install",
          json,
          updated.reason
        );
      }
      targetOptions = updated.value;
    } else if (option === "--version") {
      if (version !== undefined) {
        return usage(
          "install",
          json,
          "duplicate --version"
        );
      }
      version = value;
    } else if (option === "--git") {
      if (gitRef !== undefined) {
        return usage(
          "install",
          json,
          "duplicate --git"
        );
      }
      gitRef = value;
    } else {
      if (name !== undefined) {
        return usage(
          "install",
          json,
          "duplicate --name"
        );
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
    return usage(
      "install",
      json,
      intent.reason
    );
  }

  const resolved = resolveCliTargetOptions(
    targetOptions
  );
  if (!resolved.ok) {
    return usage(
      "install",
      json,
      resolved.reason
    );
  }

  return {
    ok: true,
    value: {
      command: "install",
      intent: intent.value,
      target: resolved.value,
      plan,
      yes,
      allowReleaseRetarget,
      nonInteractive,
      json
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

function parseStatus(
  argv: ReadonlyArray<string>,
  json: boolean
):
  | Readonly<{ ok: true; value: ParsedStatus }>
  | Readonly<{ ok: false; value: UsageFailure }> {
  let targetOptions: CliTargetOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (!isCliTargetOption(option)) {
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

    const updated = addCliTargetOption(
      targetOptions,
      option,
      value
    );
    if (!updated.ok) {
      return usage(
        "status",
        json,
        updated.reason
      );
    }
    targetOptions = updated.value;
  }

  const resolved = resolveCliTargetOptions(
    targetOptions
  );
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

function isCliTargetOption(
  option: string
): option is CliTargetOption {
  return (
    option === "--target" ||
    option === "--host" ||
    option === "--scope"
  );
}

function addCliTargetOption(
  current: CliTargetOptions,
  option: CliTargetOption,
  value: string
):
  | Readonly<{ ok: true; value: CliTargetOptions }>
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

function resolveCliTargetOptions(
  options: CliTargetOptions
): ReturnType<typeof resolveCliTarget> {
  return resolveCliTarget({
    cwd: process.cwd(),
    ...options
  });
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
    | CliUpdateResult,
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
