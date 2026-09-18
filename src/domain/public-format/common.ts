import { TomlDate } from "smol-toml";

import {
  isValidSkillName,
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../coordinate/index.js";
import {
  parseReleaseRequirement,
  parseReleaseVersion
} from "../requirement/index.js";
import type {
  TargetRecoveryRequirement
} from "../target/recovery.js";

export type PublicFormatIssueReason =
  | "missing-field"
  | "unknown-field"
  | "invalid-field";

export type PublicFormatIssue = Readonly<{
  reason: PublicFormatIssueReason;
  path: string;
}>;

export type PublicRequirementParseResult =
  | Readonly<{
      ok: true;
      value: TargetRecoveryRequirement;
    }>
  | Readonly<{
      ok: false;
      issue: PublicFormatIssue;
    }>;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function parsePublicRequirementTable(
  value: unknown,
  path: string
): PublicRequirementParseResult {
  if (!isTomlTable(value)) {
    return issue("invalid-field", path);
  }

  const kind = requiredString(value, "kind", path);
  if (!kind.ok) {
    return kind;
  }
  if (kind.value !== "package" && kind.value !== "repository") {
    return issue("invalid-field", `${path}.kind`);
  }

  const coordinate = requiredString(value, "coordinate", path);
  if (!coordinate.ok) {
    return coordinate;
  }
  const canonicalCoordinate =
    kind.value === "package"
      ? canonicalPackageCoordinate(coordinate.value)
      : canonicalRepositoryCoordinate(coordinate.value);
  if (canonicalCoordinate === undefined) {
    return issue("invalid-field", `${path}.coordinate`);
  }

  const source = requiredString(value, "source", path);
  if (!source.ok) {
    return source;
  }

  if (source.value === "github-release") {
    const unknown = firstUnknownField(value, [
      "kind",
      "coordinate",
      "source",
      "version"
    ]);
    if (unknown !== undefined) {
      return issue("unknown-field", `${path}.${unknown}`);
    }

    let versionRequirement: string | null = null;
    if (value.version !== undefined) {
      if (typeof value.version !== "string") {
        return issue("invalid-field", `${path}.version`);
      }
      const parsed = parseReleaseRequirement(value.version);
      if (!parsed.ok || parsed.value.canonical !== value.version) {
        return issue("invalid-field", `${path}.version`);
      }
      versionRequirement = parsed.value.canonical;
    }

    return {
      ok: true,
      value: {
        kind: kind.value,
        coordinate: canonicalCoordinate,
        sourceKind: "github-release",
        versionRequirement
      }
    };
  }

  if (source.value === "git") {
    const unknown = firstUnknownField(value, [
      "kind",
      "coordinate",
      "source",
      "ref"
    ]);
    if (unknown !== undefined) {
      return issue("unknown-field", `${path}.${unknown}`);
    }
    const requestedRef = requiredString(value, "ref", path);
    if (!requestedRef.ok) {
      return requestedRef;
    }
    if (requestedRef.value.length === 0) {
      return issue("invalid-field", `${path}.ref`);
    }

    return {
      ok: true,
      value: {
        kind: kind.value,
        coordinate: canonicalCoordinate,
        sourceKind: "git",
        requestedRef: requestedRef.value
      }
    };
  }

  return issue("invalid-field", `${path}.source`);
}

export function writePublicRequirementTable(
  requirement: TargetRecoveryRequirement
): ReadonlyArray<string> {
  const lines = [
    "[[requirements]]",
    `kind = ${tomlString(requirement.kind)}`,
    `coordinate = ${tomlString(requirement.coordinate)}`,
    `source = ${tomlString(requirement.sourceKind)}`
  ];
  if (requirement.sourceKind === "github-release") {
    if (requirement.versionRequirement !== null) {
      lines.push(
        `version = ${tomlString(requirement.versionRequirement)}`
      );
    }
  } else {
    lines.push(`ref = ${tomlString(requirement.requestedRef)}`);
  }
  return lines;
}

export function canonicalPackageCoordinate(
  value: string
): string | undefined {
  const parsed = parsePackageCoordinate(value);
  return parsed.ok && parsed.value.canonical === value
    ? parsed.value.canonical
    : undefined;
}

export function canonicalRepositoryCoordinate(
  value: string
): string | undefined {
  const parsed = parseRepositoryCoordinate(value);
  return parsed.ok && parsed.value.canonical === value
    ? parsed.value.canonical
    : undefined;
}

export function defaultPackageName(
  packageCoordinate: string
): string | undefined {
  const parsed = parsePackageCoordinate(packageCoordinate);
  return parsed.ok && parsed.value.canonical === packageCoordinate
    ? parsed.value.packageName
    : undefined;
}

export function isCanonicalTargetId(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

export function isCanonicalExactCommit(value: string): boolean {
  return COMMIT_PATTERN.test(value);
}

export function isCanonicalContentDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

export function isCanonicalReleaseVersion(value: string): boolean {
  const parsed = parseReleaseVersion(value);
  return parsed.ok && parsed.value.canonical === value;
}

export function isValidPublicActivationName(
  value: string
): boolean {
  return isValidSkillName(value);
}

export function isValidPackageRoot(value: string): boolean {
  if (value === ".") {
    return true;
  }
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".."
  );
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

export function isTomlTable(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof TomlDate)
  );
}

export function firstUnknownField(
  value: Readonly<Record<string, unknown>>,
  allowedFields: ReadonlyArray<string>
): string | undefined {
  const allowed = new Set(allowedFields);
  return Object.keys(value)
    .filter((field) => !allowed.has(field))
    .sort(compareUtf8)[0];
}

export function requiredString(
  value: Readonly<Record<string, unknown>>,
  field: string,
  path: string
):
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; issue: PublicFormatIssue }> {
  if (!(field in value)) {
    return issue("missing-field", `${path}.${field}`);
  }
  if (typeof value[field] !== "string") {
    return issue("invalid-field", `${path}.${field}`);
  }
  return {
    ok: true,
    value: value[field] as string
  };
}

export function issue(
  reason: PublicFormatIssueReason,
  path: string
): Readonly<{ ok: false; issue: PublicFormatIssue }> {
  return {
    ok: false,
    issue: { reason, path }
  };
}
