import { parse as parseToml } from "smol-toml";

import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";
import {
  canonicalPackageCoordinate,
  compareUtf8,
  defaultPackageName,
  firstUnknownField,
  isCanonicalContentDigest,
  isCanonicalExactCommit,
  isCanonicalReleaseVersion,
  isCanonicalTargetId,
  isTomlTable,
  isValidPackageRoot,
  isValidPublicActivationName,
  parsePublicRequirementTable,
  requiredString,
  tomlString,
  writePublicRequirementTable,
  type PublicFormatIssue
} from "../public-format/common.js";
import type {
  TargetRecoveryDetachedBaseline,
  TargetRecoveryMarkerFacts,
  TargetRecoveryProjectionOverride,
  TargetRecoveryRequirement
} from "./recovery.js";

const FORMAT = "SKILOOM-STATE-V1";
const FUTURE_FORMAT_PATTERN = /^SKILOOM-STATE-V[0-9]+$/u;

export type InvalidTargetStateReason =
  | "invalid-toml"
  | "missing-field"
  | "unknown-field"
  | "invalid-field"
  | "duplicate-requirement"
  | "duplicate-projection-override"
  | "duplicate-detached"
  | "default-projection-override"
  | "contradictory-sparse-metadata";

export type InvalidTargetState = ProductError<
  "InvalidTargetState",
  Readonly<{
    reason: InvalidTargetStateReason;
    path: string;
  }>
>;

export type UnsupportedTargetStateVersion = ProductError<
  "UnsupportedTargetStateVersion",
  Readonly<{ format: string }>
>;

export type TargetStateMarkerParseError =
  | InvalidTargetState
  | UnsupportedTargetStateVersion;

export function parseTargetStateMarker(
  source: string
): Result<TargetRecoveryMarkerFacts, TargetStateMarkerParseError> {
  let parsed: unknown;
  try {
    parsed = parseToml(source, {
      integersAsBigInt: true,
      maxDepth: 100
    });
  } catch {
    return invalid("invalid-toml", "$");
  }
  if (!isTomlTable(parsed)) {
    return invalid("invalid-toml", "$");
  }

  const format = parsed.format;
  if (format === undefined) {
    return invalid("missing-field", "format");
  }
  if (typeof format !== "string") {
    return invalid("invalid-field", "format");
  }
  if (format !== FORMAT) {
    return FUTURE_FORMAT_PATTERN.test(format)
      ? {
          ok: false,
          error: productError("UnsupportedTargetStateVersion", {
            format
          })
        }
      : invalid("invalid-field", "format");
  }

  const unknown = firstUnknownField(parsed, [
    "format",
    "target-id",
    "generation",
    "requirements",
    "projection-overrides",
    "detached"
  ]);
  if (unknown !== undefined) {
    return invalid("unknown-field", unknown);
  }

  const targetId = parsed["target-id"];
  if (targetId === undefined) {
    return invalid("missing-field", "target-id");
  }
  if (
    typeof targetId !== "string" ||
    !isCanonicalTargetId(targetId)
  ) {
    return invalid("invalid-field", "target-id");
  }

  const generation = parsed.generation;
  if (generation === undefined) {
    return invalid("missing-field", "generation");
  }
  if (
    typeof generation !== "bigint" ||
    generation < 0n ||
    generation > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return invalid("invalid-field", "generation");
  }

  const requirements = parseRequirements(parsed.requirements);
  if (!requirements.ok) {
    return requirements;
  }
  const projectionOverrides = parseProjectionOverrides(
    parsed["projection-overrides"]
  );
  if (!projectionOverrides.ok) {
    return projectionOverrides;
  }
  const detached = parseDetached(parsed.detached);
  if (!detached.ok) {
    return detached;
  }

  return {
    ok: true,
    value: {
      targetId,
      generation: Number(generation),
      requirements: requirements.value,
      projectionOverrides: projectionOverrides.value,
      detached: detached.value
    }
  };
}

export function writeTargetStateMarker(
  facts: TargetRecoveryMarkerFacts
): string {
  const lines: string[] = [
    `format = ${tomlString(FORMAT)}`,
    `target-id = ${tomlString(facts.targetId)}`,
    `generation = ${facts.generation}`
  ];

  const requirements = [...facts.requirements].sort(
    compareRequirements
  );
  for (const requirement of requirements) {
    lines.push("", ...writePublicRequirementTable(requirement));
  }

  const overrides = [...facts.projectionOverrides]
    .filter((override) =>
      defaultPackageName(override.packageCoordinate) !==
        override.activationName
    )
    .sort((left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
    );
  for (const override of overrides) {
    lines.push(
      "",
      "[[projection-overrides]]",
      `package = ${tomlString(override.packageCoordinate)}`,
      `activation-name = ${tomlString(override.activationName)}`
    );
  }

  const detached = [...facts.detached].sort((left, right) =>
    compareUtf8(
      left.packageCoordinate,
      right.packageCoordinate
    )
  );
  for (const baseline of detached) {
    lines.push("", ...writeDetachedTable(baseline));
  }

  return lines.join("\n") + "\n";
}

function parseRequirements(
  value: unknown
): Result<
  ReadonlyArray<TargetRecoveryRequirement>,
  InvalidTargetState
> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return invalid("invalid-field", "requirements");
  }

  const result: TargetRecoveryRequirement[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `requirements[${index}]`;
    const parsed = parsePublicRequirementTable(value[index], path);
    if (!parsed.ok) {
      return invalidIssue(parsed.issue);
    }
    const key = `${parsed.value.kind}\u0000${parsed.value.coordinate}`;
    if (seen.has(key)) {
      return invalid("duplicate-requirement", path);
    }
    seen.add(key);
    result.push(parsed.value);
  }

  return {
    ok: true,
    value: result.sort(compareRequirements)
  };
}

function parseProjectionOverrides(
  value: unknown
): Result<
  ReadonlyArray<TargetRecoveryProjectionOverride>,
  InvalidTargetState
> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return invalid("invalid-field", "projection-overrides");
  }

  const result: TargetRecoveryProjectionOverride[] = [];
  const packages = new Set<string>();
  const activationNames = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `projection-overrides[${index}]`;
    const entry = value[index];
    if (!isTomlTable(entry)) {
      return invalid("invalid-field", path);
    }
    const unknown = firstUnknownField(entry, [
      "package",
      "activation-name"
    ]);
    if (unknown !== undefined) {
      return invalid("unknown-field", `${path}.${unknown}`);
    }

    const packageValue = requiredString(entry, "package", path);
    if (!packageValue.ok) {
      return invalidIssue(packageValue.issue);
    }
    const packageCoordinate = canonicalPackageCoordinate(
      packageValue.value
    );
    if (packageCoordinate === undefined) {
      return invalid("invalid-field", `${path}.package`);
    }

    const activation = requiredString(
      entry,
      "activation-name",
      path
    );
    if (!activation.ok) {
      return invalidIssue(activation.issue);
    }
    if (!isValidPublicActivationName(activation.value)) {
      return invalid(
        "invalid-field",
        `${path}.activation-name`
      );
    }
    if (
      defaultPackageName(packageCoordinate) ===
      activation.value
    ) {
      return invalid("default-projection-override", path);
    }
    if (packages.has(packageCoordinate)) {
      return invalid("duplicate-projection-override", path);
    }
    if (activationNames.has(activation.value)) {
      return invalid(
        "contradictory-sparse-metadata",
        `${path}.activation-name`
      );
    }

    packages.add(packageCoordinate);
    activationNames.add(activation.value);
    result.push({
      packageCoordinate,
      activationName: activation.value
    });
  }

  return {
    ok: true,
    value: result.sort((left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
    )
  };
}

function parseDetached(
  value: unknown
): Result<
  ReadonlyArray<TargetRecoveryDetachedBaseline>,
  InvalidTargetState
> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return invalid("invalid-field", "detached");
  }

  const result: TargetRecoveryDetachedBaseline[] = [];
  const packages = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `detached[${index}]`;
    const entry = value[index];
    if (!isTomlTable(entry)) {
      return invalid("invalid-field", path);
    }

    const source = requiredString(
      entry,
      "baseline-source",
      path
    );
    if (!source.ok) {
      return invalidIssue(source.issue);
    }
    const allowed =
      source.value === "github-release"
        ? [
            "package",
            "baseline-source",
            "baseline-version",
            "baseline-tag",
            "baseline-commit",
            "baseline-package-root",
            "baseline-content-digest"
          ]
        : source.value === "git"
          ? [
              "package",
              "baseline-source",
              "baseline-ref",
              "baseline-commit",
              "baseline-package-root",
              "baseline-content-digest"
            ]
          : null;
    if (allowed === null) {
      return invalid(
        "invalid-field",
        `${path}.baseline-source`
      );
    }
    const unknown = firstUnknownField(entry, allowed);
    if (unknown !== undefined) {
      return invalid("unknown-field", `${path}.${unknown}`);
    }

    const common = parseDetachedCommon(entry, path);
    if (!common.ok) {
      return common;
    }
    if (packages.has(common.value.packageCoordinate)) {
      return invalid("duplicate-detached", path);
    }
    packages.add(common.value.packageCoordinate);

    if (source.value === "github-release") {
      const version = requiredString(
        entry,
        "baseline-version",
        path
      );
      if (!version.ok) {
        return invalidIssue(version.issue);
      }
      if (!isCanonicalReleaseVersion(version.value)) {
        return invalid(
          "invalid-field",
          `${path}.baseline-version`
        );
      }
      const tag = requiredString(
        entry,
        "baseline-tag",
        path
      );
      if (!tag.ok) {
        return invalidIssue(tag.issue);
      }
      if (tag.value.length === 0) {
        return invalid(
          "invalid-field",
          `${path}.baseline-tag`
        );
      }
      result.push({
        packageCoordinate: common.value.packageCoordinate,
        sourceKind: "github-release",
        version: version.value,
        actualTag: tag.value,
        exactCommit: common.value.exactCommit,
        packageRoot: common.value.packageRoot,
        contentDigest: common.value.contentDigest
      });
    } else {
      const requestedRef = requiredString(
        entry,
        "baseline-ref",
        path
      );
      if (!requestedRef.ok) {
        return invalidIssue(requestedRef.issue);
      }
      if (requestedRef.value.length === 0) {
        return invalid(
          "invalid-field",
          `${path}.baseline-ref`
        );
      }
      result.push({
        packageCoordinate: common.value.packageCoordinate,
        sourceKind: "git",
        requestedRef: requestedRef.value,
        exactCommit: common.value.exactCommit,
        packageRoot: common.value.packageRoot,
        contentDigest: common.value.contentDigest
      });
    }
  }

  return {
    ok: true,
    value: result.sort((left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
    )
  };
}

function parseDetachedCommon(
  entry: Readonly<Record<string, unknown>>,
  path: string
): Result<
  Readonly<{
    packageCoordinate: string;
    exactCommit: string;
    packageRoot: string;
    contentDigest: string;
  }>,
  InvalidTargetState
> {
  const packageValue = requiredString(entry, "package", path);
  if (!packageValue.ok) {
    return invalidIssue(packageValue.issue);
  }
  const packageCoordinate = canonicalPackageCoordinate(
    packageValue.value
  );
  if (packageCoordinate === undefined) {
    return invalid("invalid-field", `${path}.package`);
  }

  const commit = requiredString(
    entry,
    "baseline-commit",
    path
  );
  if (!commit.ok) {
    return invalidIssue(commit.issue);
  }
  if (!isCanonicalExactCommit(commit.value)) {
    return invalid(
      "invalid-field",
      `${path}.baseline-commit`
    );
  }

  const packageRoot = requiredString(
    entry,
    "baseline-package-root",
    path
  );
  if (!packageRoot.ok) {
    return invalidIssue(packageRoot.issue);
  }
  if (!isValidPackageRoot(packageRoot.value)) {
    return invalid(
      "invalid-field",
      `${path}.baseline-package-root`
    );
  }

  const digest = requiredString(
    entry,
    "baseline-content-digest",
    path
  );
  if (!digest.ok) {
    return invalidIssue(digest.issue);
  }
  if (!isCanonicalContentDigest(digest.value)) {
    return invalid(
      "invalid-field",
      `${path}.baseline-content-digest`
    );
  }

  return {
    ok: true,
    value: {
      packageCoordinate,
      exactCommit: commit.value,
      packageRoot: packageRoot.value,
      contentDigest: digest.value
    }
  };
}

function writeDetachedTable(
  baseline: TargetRecoveryDetachedBaseline
): ReadonlyArray<string> {
  const lines = [
    "[[detached]]",
    `package = ${tomlString(baseline.packageCoordinate)}`,
    `baseline-source = ${tomlString(baseline.sourceKind)}`
  ];
  if (baseline.sourceKind === "github-release") {
    lines.push(
      `baseline-version = ${tomlString(baseline.version)}`,
      `baseline-tag = ${tomlString(baseline.actualTag)}`
    );
  } else {
    lines.push(
      `baseline-ref = ${tomlString(baseline.requestedRef)}`
    );
  }
  lines.push(
    `baseline-commit = ${tomlString(baseline.exactCommit)}`,
    `baseline-package-root = ${tomlString(baseline.packageRoot)}`,
    `baseline-content-digest = ${tomlString(baseline.contentDigest)}`
  );
  return lines;
}

function compareRequirements(
  left: TargetRecoveryRequirement,
  right: TargetRecoveryRequirement
): number {
  const kind = compareUtf8(left.kind, right.kind);
  return kind !== 0
    ? kind
    : compareUtf8(left.coordinate, right.coordinate);
}

function invalidIssue(
  issue: PublicFormatIssue
): Result<never, InvalidTargetState> {
  return invalid(issue.reason, issue.path);
}

function invalid(
  reason: InvalidTargetStateReason,
  path: string
): Result<never, InvalidTargetState> {
  return {
    ok: false,
    error: productError("InvalidTargetState", {
      reason,
      path
    })
  };
}
