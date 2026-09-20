import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { productError } from "../../domain/errors/index.js";
import { renderFailure } from "../output/index.js";

export type CliHelpSpec = Readonly<{
  usage: string;
  summary: string;
  options: ReadonlyArray<string>;
}>;

const TARGET_OPTIONS = [
  "--target <path>",
  "--host codex|claude|gemini|opencode",
  "--scope workspace|user"
] as const;

const CANDIDATE_OPTIONS = [
  ...TARGET_OPTIONS,
  "--plan",
  "--yes",
  "--allow-release-retarget",
  "--non-interactive",
  "--json"
] as const;

export const CLI_HELP_SPECS = {
  search: {
    usage: "skiloom search <query> [--json]",
    summary: "Search the discovery Catalog.",
    options: ["--json"]
  },
  status: {
    usage: "skiloom status [target-options] [--json]",
    summary: "Show a quick Target and Registry summary.",
    options: [...TARGET_OPTIONS, "--json"]
  },
  doctor: {
    usage: "skiloom doctor [target-options] [--json]",
    summary: "Run read-only Target diagnostics.",
    options: [...TARGET_OPTIONS, "--json"]
  },
  validate: {
    usage: "skiloom validate [path] [--json]",
    summary: "Validate local Skill package metadata.",
    options: ["--json"]
  },
  install: {
    usage:
      "skiloom install <coordinate> [--version <requirement> | --git <ref>] [options]",
    summary: "Install or retarget one direct requirement.",
    options: [
      "--version <requirement>",
      "--git <ref>",
      "--name <activation-name>",
      ...CANDIDATE_OPTIONS
    ]
  },
  update: {
    usage: "skiloom update [options]",
    summary: "Re-resolve the complete accepted Target.",
    options: [...CANDIDATE_OPTIONS]
  },
  remove: {
    usage: "skiloom remove <coordinate> [options]",
    summary: "Remove one direct requirement and recompute reachability.",
    options: [...CANDIDATE_OPTIONS]
  },
  rename: {
    usage: "skiloom rename <package> <activation-name> [target-options] [--json]",
    summary: "Rename one managed projection.",
    options: [...TARGET_OPTIONS, "--json"]
  },
  sync: {
    usage: "skiloom sync [target-options] [--json]",
    summary: "Replay the accepted exact Target state.",
    options: [...TARGET_OPTIONS, "--json"]
  },
  repair: {
    usage: "skiloom repair [target-options] [--json]",
    summary: "Repair accepted exact Store and managed Target state.",
    options: [...TARGET_OPTIONS, "--json"]
  },
  detach: {
    usage: "skiloom detach <package> [target-options] [--json]",
    summary: "Transfer one managed projection to user ownership.",
    options: [...TARGET_OPTIONS, "--json"]
  },
  rebind: {
    usage: "skiloom rebind <package> <activation-name> [target-options] [--json]",
    summary: "Rebind a broken detached projection.",
    options: [...TARGET_OPTIONS, "--json"]
  },
  forget: {
    usage: "skiloom forget <package> [target-options] [--json]",
    summary: "Forget one detached logical binding.",
    options: [...TARGET_OPTIONS, "--json"]
  },
  observe: {
    usage:
      "skiloom observe <package> <name> (--status <status> [--note <text>] | --clear) [target-options] [--json]",
    summary: "Record or clear one machine-local special dependency observation.",
    options: [
      "--status unknown|satisfied|missing|incompatible|blocked",
      "--note <text>",
      "--clear",
      ...TARGET_OPTIONS,
      "--json"
    ]
  },
  recover: {
    usage: "skiloom recover [options]",
    summary: "Re-resolve a Target from its recovery marker.",
    options: [...CANDIDATE_OPTIONS]
  },
  fork: {
    usage: "skiloom fork [options]",
    summary: "Create a new Target identity from a stale copied Target.",
    options: [...CANDIDATE_OPTIONS]
  },
  export: {
    usage: "skiloom export <file> [--full] [target-options] [--json]",
    summary: "Export an exact reproducible Target package.",
    options: ["--full", ...TARGET_OPTIONS, "--json"]
  },
  import: {
    usage: "skiloom import <file> [options]",
    summary: "Import or merge an exact reproducible Target package.",
    options: [
      "--merge",
      "--plan",
      "--yes",
      "--non-interactive",
      ...TARGET_OPTIONS,
      "--json"
    ]
  },
  bootstrap: {
    usage: "skiloom bootstrap [options]",
    summary: "Install the first-party Skiloom Router into one Target.",
    options: [...CANDIDATE_OPTIONS]
  }
} as const satisfies Readonly<Record<string, CliHelpSpec>>;

export type CanonicalCliCommand = keyof typeof CLI_HELP_SPECS;

export const CANONICAL_CLI_COMMANDS = Object.freeze(
  Object.keys(CLI_HELP_SPECS) as CanonicalCliCommand[]
);

export async function runCliMeta(
  argv: ReadonlyArray<string>
): Promise<number | null> {
  const json = argv.includes("--json");
  const first = argv[0];

  if (argv.length === 0) {
    process.stdout.write(formatTopLevelHelp());
    return 0;
  }

  if (first === "--help" || first === "-h") {
    if (json) {
      return invalidMeta(first, true);
    }
    process.stdout.write(formatTopLevelHelp());
    return 0;
  }

  if (first === "--version" || first === "-V") {
    if (json) {
      return invalidMeta(first, true);
    }
    const version = await readSkiloomPackageVersion();
    if (version === null) {
      renderFailure(
        "version",
        productError("CliPackageVersionUnavailable", {}),
        false,
        1
      );
      return 1;
    }
    process.stdout.write("skiloom " + version + "\n");
    return 0;
  }

  if (
    isCanonicalCliCommand(first) &&
    argv.slice(1).some(
      (argument) => argument === "--help" || argument === "-h"
    )
  ) {
    if (json) {
      return invalidMeta(first, true);
    }
    process.stdout.write(formatCommandHelp(first));
    return 0;
  }

  return null;
}

export function formatTopLevelHelp(): string {
  const lines = [
    "Usage:",
    "  skiloom <command> [options]",
    "  skiloom --help",
    "  skiloom --version",
    "",
    "Commands:"
  ];
  for (const command of CANONICAL_CLI_COMMANDS) {
    lines.push(
      "  " + command.padEnd(10) + " " +
      CLI_HELP_SPECS[command].summary
    );
  }
  lines.push(
    "",
    "Run `skiloom <command> --help` for command usage.",
    ""
  );
  return lines.join("\n");
}

export function formatCommandHelp(
  command: CanonicalCliCommand
): string {
  const spec = CLI_HELP_SPECS[command];
  const lines = [
    "Usage:",
    "  " + spec.usage,
    "",
    spec.summary,
    "",
    "Options:",
    "  --help, -h"
  ];
  for (const option of spec.options) {
    lines.push("  " + option);
  }
  lines.push("");
  return lines.join("\n");
}

export async function readSkiloomPackageVersion(
  startPath: string = fileURLToPath(import.meta.url)
): Promise<string | null> {
  let directory = dirname(resolve(startPath));
  const root = parse(directory).root;

  while (true) {
    const candidate = join(directory, "package.json");
    try {
      const source = await readFile(candidate, "utf8");
      const parsed = JSON.parse(source) as unknown;
      if (
        isRecord(parsed) &&
        parsed.name === "skiloom" &&
        typeof parsed.version === "string" &&
        parsed.version.length > 0
      ) {
        return parsed.version;
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        return null;
      }
    }

    if (directory === root) {
      return null;
    }
    directory = dirname(directory);
  }
}

function isCanonicalCliCommand(
  value: string | undefined
): value is CanonicalCliCommand {
  return (
    value !== undefined &&
    Object.prototype.hasOwnProperty.call(CLI_HELP_SPECS, value)
  );
}

function invalidMeta(command: string, json: boolean): number {
  renderFailure(
    command,
    productError("InvalidArguments", {
      reason: "help/version meta output is not available with --json"
    }),
    json,
    2
  );
  return 2;
}

function isRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
