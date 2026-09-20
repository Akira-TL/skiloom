import type {
  ProductError,
  Result
} from "../../domain/errors/index.js";
import {
  buildCliInstallIntent,
  executeCliInstall,
  formatCliInstallResult,
  type CliInstallExecution,
  type CliInstallResult
} from "../install.js";
import {
  parseCliCandidateOptions,
  type CliTargetedCandidateOptions
} from "../candidate/options.js";

const OFFICIAL_ROUTER =
  "akira-tl/skiloom/skiloom";

export type CliBootstrapInvocation =
  CliTargetedCandidateOptions;

export type CliBootstrapResult =
  CliInstallResult;

export type CliBootstrapExecution =
  CliInstallExecution;

export type ParseCliBootstrapResult =
  | Readonly<{
      ok: true;
      value: CliBootstrapInvocation;
    }>
  | Readonly<{
      ok: false;
      reason: string;
    }>;

export function parseCliBootstrapArguments(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliBootstrapResult {
  return parseCliCandidateOptions(argv, json);
}

export async function executeCliBootstrap(
  input: CliBootstrapInvocation
): Promise<
  Result<CliBootstrapExecution, ProductError>
> {
  const intent = buildCliInstallIntent({
    coordinate: OFFICIAL_ROUTER
  });
  if (!intent.ok) {
    return {
      ok: false,
      error: {
        code: "InvalidBootstrapRouter",
        facts: { reason: intent.reason }
      }
    };
  }

  return executeCliInstall(
    {
      intent: intent.value,
      ...input
    },
    {
      noOpWhenDirectRequirementExists: true
    }
  );
}

export function formatCliBootstrapResult(
  result: CliBootstrapResult
): string {
  return formatCliInstallResult(result);
}
