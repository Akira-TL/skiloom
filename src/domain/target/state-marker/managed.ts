import {
  canonicalPackageCoordinate,
  compareUtf8,
  firstUnknownField,
  isCanonicalContentDigest,
  isTomlTable,
  isValidPackageRoot,
  isValidPublicActivationName,
  requiredString,
  tomlString
} from "../../public-format/common.js";
import type {
  TargetRecoveryManagedBaseline
} from "../recovery.js";

export type ManagedMarkerIssue = Readonly<{
  reason:
    | "missing-field"
    | "unknown-field"
    | "invalid-field"
    | "duplicate-managed"
    | "contradictory-sparse-metadata";
  path: string;
}>;

export type ParseManagedMarkerResult =
  | Readonly<{
      ok: true;
      value: ReadonlyArray<TargetRecoveryManagedBaseline>;
    }>
  | Readonly<{
      ok: false;
      issue: ManagedMarkerIssue;
    }>;

export function parseManagedMarker(
  value: unknown
): ParseManagedMarkerResult {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return issue("invalid-field", "managed");
  }

  const result: TargetRecoveryManagedBaseline[] = [];
  const packages = new Set<string>();
  const activationNames = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const path = `managed[${index}]`;
    const entry = value[index];
    if (!isTomlTable(entry)) {
      return issue("invalid-field", path);
    }

    const unknown = firstUnknownField(entry, [
      "package",
      "activation-name",
      "materialization",
      "baseline-package-root",
      "baseline-content-digest",
      "baseline-transform-json"
    ]);
    if (unknown !== undefined) {
      return issue(
        "unknown-field",
        `${path}.${unknown}`
      );
    }

    const packageValue = requiredString(
      entry,
      "package",
      path
    );
    if (!packageValue.ok) {
      return { ok: false, issue: packageValue.issue };
    }
    const packageCoordinate = canonicalPackageCoordinate(
      packageValue.value
    );
    if (packageCoordinate === undefined) {
      return issue("invalid-field", `${path}.package`);
    }

    const activation = requiredString(
      entry,
      "activation-name",
      path
    );
    if (!activation.ok) {
      return { ok: false, issue: activation.issue };
    }
    if (!isValidPublicActivationName(activation.value)) {
      return issue(
        "invalid-field",
        `${path}.activation-name`
      );
    }

    const materializationValue = requiredString(
      entry,
      "materialization",
      path
    );
    if (!materializationValue.ok) {
      return {
        ok: false,
        issue: materializationValue.issue
      };
    }
    const materialization =
      materializationValue.value === "symlink" ||
      materializationValue.value === "junction" ||
      materializationValue.value === "copy"
        ? materializationValue.value
        : null;
    if (materialization === null) {
      return issue(
        "invalid-field",
        `${path}.materialization`
      );
    }

    const packageRoot = requiredString(
      entry,
      "baseline-package-root",
      path
    );
    if (!packageRoot.ok) {
      return { ok: false, issue: packageRoot.issue };
    }
    if (!isValidPackageRoot(packageRoot.value)) {
      return issue(
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
      return { ok: false, issue: digest.issue };
    }
    if (!isCanonicalContentDigest(digest.value)) {
      return issue(
        "invalid-field",
        `${path}.baseline-content-digest`
      );
    }

    const transformValue =
      entry["baseline-transform-json"];
    if (
      transformValue !== undefined &&
      typeof transformValue !== "string"
    ) {
      return issue(
        "invalid-field",
        `${path}.baseline-transform-json`
      );
    }
    const transformJson =
      typeof transformValue === "string"
        ? transformValue
        : null;
    if (
      transformJson !== null &&
      (
        materialization !== "copy" ||
        !isCanonicalManagedTransformJson(transformJson)
      )
    ) {
      return issue(
        "invalid-field",
        `${path}.baseline-transform-json`
      );
    }

    if (packages.has(packageCoordinate)) {
      return issue("duplicate-managed", path);
    }
    if (activationNames.has(activation.value)) {
      return issue(
        "contradictory-sparse-metadata",
        `${path}.activation-name`
      );
    }
    packages.add(packageCoordinate);
    activationNames.add(activation.value);

    result.push({
      packageCoordinate,
      activationName: activation.value,
      materialization,
      packageRoot: packageRoot.value,
      contentDigest: digest.value,
      transformJson
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

export function writeManagedMarkerTable(
  baseline: TargetRecoveryManagedBaseline
): ReadonlyArray<string> {
  const lines = [
    "[[managed]]",
    `package = ${tomlString(
      baseline.packageCoordinate
    )}`,
    `activation-name = ${tomlString(
      baseline.activationName
    )}`,
    `materialization = ${tomlString(
      baseline.materialization
    )}`,
    `baseline-package-root = ${tomlString(
      baseline.packageRoot
    )}`,
    `baseline-content-digest = ${tomlString(
      baseline.contentDigest
    )}`
  ];
  if (baseline.transformJson !== null) {
    lines.push(
      `baseline-transform-json = ${tomlString(
        baseline.transformJson
      )}`
    );
  }
  return lines;
}

function isCanonicalManagedTransformJson(
  source: string
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return false;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  const record = value as Readonly<
    Record<string, unknown>
  >;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    keys[0] !== "rename" ||
    keys[1] !== "dependencyRoutes"
  ) {
    return false;
  }

  const canonicalRename = canonicalRenameValue(
    record.rename
  );
  if (canonicalRename === undefined) {
    return false;
  }
  const canonicalRoutes = canonicalRouteValues(
    record.dependencyRoutes
  );
  if (canonicalRoutes === undefined) {
    return false;
  }

  return (
    JSON.stringify({
      rename: canonicalRename,
      dependencyRoutes: canonicalRoutes
    }) === source
  );
}

function canonicalRenameValue(
  value: unknown
):
  | null
  | Readonly<{
      fromActivationName: string;
      toActivationName: string;
    }>
  | undefined {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const record = value as Readonly<
    Record<string, unknown>
  >;
  if (
    Object.keys(record).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(
      record,
      "fromActivationName"
    ) ||
    !Object.prototype.hasOwnProperty.call(
      record,
      "toActivationName"
    ) ||
    typeof record.fromActivationName !== "string" ||
    typeof record.toActivationName !== "string" ||
    !isValidPublicActivationName(
      record.fromActivationName
    ) ||
    !isValidPublicActivationName(
      record.toActivationName
    ) ||
    record.fromActivationName ===
      record.toActivationName
  ) {
    return undefined;
  }
  return {
    fromActivationName: record.fromActivationName,
    toActivationName: record.toActivationName
  };
}

function canonicalRouteValues(
  value: unknown
):
  | ReadonlyArray<Readonly<{
      dependencyPackageCoordinate: string;
      fromActivationName: string;
      toActivationName: string;
    }>>
  | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const routes: Array<{
    dependencyPackageCoordinate: string;
    fromActivationName: string;
    toActivationName: string;
  }> = [];
  const seenPackages = new Set<string>();

  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      return undefined;
    }
    const record = entry as Readonly<
      Record<string, unknown>
    >;
    if (
      Object.keys(record).length !== 3 ||
      typeof record.dependencyPackageCoordinate !==
        "string" ||
      typeof record.fromActivationName !== "string" ||
      typeof record.toActivationName !== "string"
    ) {
      return undefined;
    }

    const dependencyPackageCoordinate =
      canonicalPackageCoordinate(
        record.dependencyPackageCoordinate
      );
    if (
      dependencyPackageCoordinate === undefined ||
      dependencyPackageCoordinate !==
        record.dependencyPackageCoordinate ||
      seenPackages.has(dependencyPackageCoordinate) ||
      !isValidPublicActivationName(
        record.fromActivationName
      ) ||
      !isValidPublicActivationName(
        record.toActivationName
      ) ||
      record.fromActivationName ===
        record.toActivationName
    ) {
      return undefined;
    }
    seenPackages.add(dependencyPackageCoordinate);
    routes.push({
      dependencyPackageCoordinate,
      fromActivationName:
        record.fromActivationName,
      toActivationName:
        record.toActivationName
    });
  }

  return routes.sort((left, right) =>
    compareUtf8(
      left.dependencyPackageCoordinate,
      right.dependencyPackageCoordinate
    )
  );
}

function issue(
  reason: ManagedMarkerIssue["reason"],
  path: string
): Readonly<{
  ok: false;
  issue: ManagedMarkerIssue;
}> {
  return {
    ok: false,
    issue: { reason, path }
  };
}
