import process from "node:process";

import type {
  ProductError
} from "../../domain/errors/index.js";
import {
  formatDiagnosticFailure,
  formatDiagnosticWarning
} from "../diagnostics/index.js";
import type {
  SkillsMpSearchResult
} from "../../runtime/catalog/skillsmp.js";
import {
  formatCliBootstrapResult,
  type CliBootstrapResult
} from "../bootstrap/index.js";
import {
  formatCliDoctorResult,
  type CliDoctorResult
} from "../doctor/index.js";
import {
  formatCliInstallResult,
  type CliInstallResult
} from "../install.js";
import {
  formatCliLocalResult,
  type CliLocalResult
} from "../local/index.js";
import {
  formatCliMaintenanceResult,
  type CliMaintenanceResult
} from "../maintenance/index.js";
import {
  formatCliRecoveryResult,
  type CliRecoveryResult
} from "../recovery/index.js";
import {
  formatCliRemoveResult,
  type CliRemoveResult
} from "../remove/index.js";
import type {
  CliStatusResult
} from "../status.js";
import {
  formatCliExportResult,
  type CliExportResult
} from "../transfer/index.js";
import {
  formatCliImportResult,
  type CliImportResult
} from "../transfer/import.js";
import {
  formatCliUpdateResult,
  type CliUpdateResult
} from "../update.js";
import type {
  ValidateLocalPathResult
} from "../validate.js";

const CLI_SCHEMA = "SKILOOM-CLI-V1" as const;

type CliSuccess = Readonly<{
  schema: typeof CLI_SCHEMA;
  ok: true;
  command: string;
  result: unknown;
  warnings: ReadonlyArray<ProductError>;
}>;

type CliFailure = Readonly<{
  schema: typeof CLI_SCHEMA;
  ok: false;
  command: string;
  error: ProductError;
  warnings: ReadonlyArray<ProductError>;
}>;

export function renderSuccess(
  command: string,
  result:
    | ValidateLocalPathResult
    | CliStatusResult
    | CliDoctorResult
    | SkillsMpSearchResult
    | CliInstallResult
    | CliUpdateResult
    | CliRemoveResult
    | CliRecoveryResult
    | CliExportResult
    | CliImportResult
    | CliBootstrapResult
    | CliMaintenanceResult
    | CliLocalResult,
  json: boolean,
  warnings: ReadonlyArray<ProductError> = []
): void {
  if (json) {
    const output: CliSuccess = {
      schema: CLI_SCHEMA,
      ok: true,
      command,
      result,
      warnings
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
  if (command === "doctor") {
    process.stdout.write(
      formatCliDoctorResult(result as CliDoctorResult)
    );
    renderHumanWarnings(warnings);
    return;
  }
  if (command === "install") {
    process.stdout.write(
      formatCliInstallResult(result as CliInstallResult)
    );
    return;
  }
  if (command === "bootstrap") {
    process.stdout.write(
      formatCliBootstrapResult(result as CliBootstrapResult)
    );
    return;
  }
  if (command === "remove") {
    process.stdout.write(
      formatCliRemoveResult(result as CliRemoveResult)
    );
    return;
  }
  if (command === "export") {
    process.stdout.write(
      formatCliExportResult(result as CliExportResult)
    );
    renderHumanWarnings(warnings);
    return;
  }
  if (command === "import") {
    process.stdout.write(
      formatCliImportResult(result as CliImportResult)
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
      const source =
        candidate.githubRepository === null
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
  renderHumanWarnings(warnings);
}

export function renderFailure(
  command: string,
  error: ProductError,
  json: boolean,
  exitCode: number,
  warnings: ReadonlyArray<ProductError> = []
): void {
  if (json) {
    const output: CliFailure = {
      schema: CLI_SCHEMA,
      ok: false,
      command,
      error,
      warnings
    };
    process.stdout.write(
      JSON.stringify(output) + "\n"
    );
    return;
  }

  const diagnostic =
    formatDiagnosticFailure(error, exitCode);
  process.stderr.write(
    diagnostic === undefined
      ? `skiloom: ${error.code} (exit ${exitCode})\n`
      : diagnostic + "\n"
  );
  renderHumanWarnings(warnings);
}

function renderHumanWarnings(
  warnings: ReadonlyArray<ProductError>
): void {
  for (const warning of warnings) {
    const diagnostic =
      formatDiagnosticWarning(warning);
    process.stderr.write(
      diagnostic === undefined
        ? "Warning: " + warning.code + "\n"
        : diagnostic + "\n"
    );
  }
}
