import { spawn } from "node:child_process";
import process from "node:process";

import {
  matchesHostSoftwareRequirement,
  parseHostSoftwareRequirement,
  type HostSoftwareRequirement
} from "../../domain/host-observation/index.js";
import {
  parsePackageMetadata
} from "../../domain/package/index.js";
import {
  restrictedChildProcessEnvironment
} from "../child-process/environment.js";
import type {
  PackageSnapshot
} from "../../domain/snapshot/index.js";
import type {
  RegistryDependencyObservation
} from "../registry/model.js";

export type HostObservationStatus =
  | "unknown"
  | "satisfied"
  | "missing"
  | "incompatible"
  | "blocked";

export type HostProbeId =
  | "node"
  | "npm"
  | "git"
  | "gh"
  | "python";

export const SUPPORTED_HOST_SOFTWARE_PROBES: ReadonlyArray<HostProbeId> = [
  "node",
  "npm",
  "git",
  "gh",
  "python"
];

export type HostObservationDiagnosticCode =
  | "UnsupportedHostSoftwareProbe"
  | "InvalidHostSoftwareRequirement"
  | "UnparseableHostSoftwareVersion";

export type HostObservationDiagnostic = Readonly<{
  code: HostObservationDiagnosticCode;
  facts: Readonly<Record<string, string>>;
}>;

export type PackageHostObservationDiagnostic = Readonly<{
  code:
    | HostObservationDiagnosticCode
    | "InvalidHostObservationMetadata";
  packageCoordinate: string;
  facts: Readonly<Record<string, string>>;
}>;

export type PackageHostObservationResult = Readonly<{
  observations: ReadonlyArray<RegistryDependencyObservation>;
  diagnostics: ReadonlyArray<PackageHostObservationDiagnostic>;
}>;

export type HostProbeExecutionRequest = Readonly<{
  executable: string;
  args: ReadonlyArray<string>;
}>;

export type HostProbeExecutionResult =
  | Readonly<{
      kind: "exited";
      code: number;
      stdout: string;
      stderr: string;
    }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "blocked" }>;

export type HostProbeExecutor = (
  request: HostProbeExecutionRequest
) => Promise<HostProbeExecutionResult>;

export type HostSoftwareProbeResult = Readonly<{
  name: string;
  requirement: string;
  status: HostObservationStatus;
  detectedVersion: string | null;
  location: string | null;
  note: string | null;
  diagnostic: HostObservationDiagnostic | null;
}>;

type HostProbeSpec = Readonly<{
  executables: () => ReadonlyArray<string>;
  args: ReadonlyArray<string>;
  parseVersion: (output: string) => string | undefined;
}>;

const PROBES: Readonly<Record<HostProbeId, HostProbeSpec>> = {
  node: {
    executables: () => [process.execPath],
    args: ["--version"],
    parseVersion: (output) =>
      firstVersion(output, /(?:^|\s)v(\d+(?:\.\d+)*)/u)
  },
  npm: {
    executables: () => ["npm"],
    args: ["--version"],
    parseVersion: (output) =>
      firstVersion(output, /(?:^|\s)(\d+(?:\.\d+)*)(?:\s|$)/u)
  },
  git: {
    executables: () => ["git"],
    args: ["--version"],
    parseVersion: (output) =>
      firstVersion(output, /git version (\d+(?:\.\d+)*)/iu)
  },
  gh: {
    executables: () => ["gh"],
    args: ["--version"],
    parseVersion: (output) =>
      firstVersion(output, /gh version (\d+(?:\.\d+)*)/iu)
  },
  python: {
    executables: () =>
      process.platform === "win32"
        ? ["python", "py"]
        : ["python3", "python"],
    args: ["--version"],
    parseVersion: (output) =>
      firstVersion(output, /Python (\d+(?:\.\d+)*)/iu)
  }
};

export async function observePackageCommonSoftware(
  input: Readonly<{
    packageCoordinate: string;
    packageContentDigest: string;
    snapshot: PackageSnapshot;
    execute?: HostProbeExecutor;
  }>
): Promise<PackageHostObservationResult> {
  const manifestEntry = input.snapshot.entries.find(
    (entry) => entry.path === "skiloom-package.toml"
  );
  if (manifestEntry === undefined) {
    return {
      observations: [],
      diagnostics: []
    };
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true })
      .decode(manifestEntry.content);
  } catch {
    return {
      observations: [],
      diagnostics: [
        {
          code: "InvalidHostObservationMetadata",
          packageCoordinate: input.packageCoordinate,
          facts: { reason: "invalid-utf8" }
        }
      ]
    };
  }

  const metadata = parsePackageMetadata(source);
  if (!metadata.ok) {
    return {
      observations: [],
      diagnostics: [
        {
          code: "InvalidHostObservationMetadata",
          packageCoordinate: input.packageCoordinate,
          facts: { errorCode: metadata.error.code }
        }
      ]
    };
  }

  const observations: RegistryDependencyObservation[] = [];
  const diagnostics: PackageHostObservationDiagnostic[] = [];
  const entries = Object.entries(metadata.value.software)
    .sort(([left], [right]) => compareUtf8(left, right));

  for (const [name, requirement] of entries) {
    const observed = await probeHostSoftware({
      name,
      requirement,
      ...(input.execute === undefined
        ? {}
        : { execute: input.execute })
    });
    observations.push({
      packageCoordinate: input.packageCoordinate,
      packageContentDigest: input.packageContentDigest,
      kind: "software",
      name,
      status: observed.status,
      detectedVersion: observed.detectedVersion,
      location: observed.location,
      note: observed.note
    });
    if (observed.diagnostic !== null) {
      diagnostics.push({
        code: observed.diagnostic.code,
        packageCoordinate: input.packageCoordinate,
        facts: observed.diagnostic.facts
      });
    }
  }

  return {
    observations,
    diagnostics
  };
}

export async function probeHostSoftware(
  input: Readonly<{
    name: string;
    requirement: string;
    execute?: HostProbeExecutor;
  }>
): Promise<HostSoftwareProbeResult> {
  const requirement = parseHostSoftwareRequirement(input.requirement);
  if (!requirement.ok) {
    return observation(
      input,
      "unknown",
      null,
      null,
      {
        code: "InvalidHostSoftwareRequirement",
        facts: {
          name: input.name,
          requirement: input.requirement
        }
      }
    );
  }

  if (!isHostProbeId(input.name)) {
    return observation(
      input,
      "unknown",
      null,
      null,
      {
        code: "UnsupportedHostSoftwareProbe",
        facts: {
          name: input.name,
          requirement: input.requirement
        }
      }
    );
  }

  return executeBuiltInProbe(
    input,
    requirement.value,
    PROBES[input.name],
    input.execute ?? executeHostProbe
  );
}

async function executeBuiltInProbe(
  input: Readonly<{ name: string; requirement: string }>,
  requirement: HostSoftwareRequirement,
  spec: HostProbeSpec,
  execute: HostProbeExecutor
): Promise<HostSoftwareProbeResult> {
  for (const executable of spec.executables()) {
    const result = await execute({
      executable,
      args: spec.args
    });
    if (result.kind === "missing") {
      continue;
    }
    if (result.kind === "blocked" || result.code !== 0) {
      return observation(
        input,
        "blocked",
        null,
        null,
        null
      );
    }

    const output = [result.stdout, result.stderr]
      .filter((value) => value.length > 0)
      .join("\n");
    const version = spec.parseVersion(output);

    if (requirement.kind === "presence") {
      return observation(
        input,
        "satisfied",
        version ?? null,
        executable,
        null
      );
    }
    if (version === undefined) {
      return observation(
        input,
        "unknown",
        null,
        executable,
        {
          code: "UnparseableHostSoftwareVersion",
          facts: {
            name: input.name,
            requirement: input.requirement
          }
        }
      );
    }

    const matched = matchesHostSoftwareRequirement(
      requirement,
      version
    );
    if (!matched.ok) {
      return observation(
        input,
        "unknown",
        version,
        executable,
        {
          code: "UnparseableHostSoftwareVersion",
          facts: {
            name: input.name,
            requirement: input.requirement,
            version
          }
        }
      );
    }

    return observation(
      input,
      matched.value ? "satisfied" : "incompatible",
      version,
      executable,
      null
    );
  }

  return observation(
    input,
    "missing",
    null,
    null,
    null
  );
}

function observation(
  input: Readonly<{ name: string; requirement: string }>,
  status: HostObservationStatus,
  detectedVersion: string | null,
  location: string | null,
  diagnostic: HostObservationDiagnostic | null
): HostSoftwareProbeResult {
  return {
    name: input.name,
    requirement: input.requirement,
    status,
    detectedVersion,
    location,
    note: null,
    diagnostic
  };
}

function isHostProbeId(value: string): value is HostProbeId {
  return Object.prototype.hasOwnProperty.call(PROBES, value);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

function firstVersion(
  output: string,
  pattern: RegExp
): string | undefined {
  return pattern.exec(output)?.[1];
}

async function executeHostProbe(
  request: HostProbeExecutionRequest
): Promise<HostProbeExecutionResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        request.executable,
        [...request.args],
        {
          shell: false,
          detached: false,
          windowsHide: true,
          env: restrictedChildProcessEnvironment(process.env),
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
    } catch {
      resolve({ kind: "blocked" });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve(
        error.code === "ENOENT" || error.code === "ENOTDIR"
          ? { kind: "missing" }
          : { kind: "blocked" }
      );
    });
    child.once("close", (code) => {
      resolve({
        kind: "exited",
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}
