import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  TargetProjection,
  TargetProjectionTransform
} from "../../../domain/target/index.js";
import type {
  TargetOwnedProjection
} from "../../../domain/target/preflight.js";

const RECOVERY_FORMAT = "SKILOOM-TARGET-RECONCILE-RECOVERY-V1";
const RECOVERY_FILE = "recovery.json";

export type TargetReconciliationRecoveryAction =
  | "stage"
  | "remove";

export type TargetReconciliationRecoveryManifest = Readonly<{
  format: typeof RECOVERY_FORMAT;
  operationId: string;
  targetId: string;
  activationName: string;
  action: TargetReconciliationRecoveryAction;
  previous: Readonly<{
    projection: TargetProjection;
    materialization: "symlink" | "junction" | "copy";
  }> | null;
}>;

export type InvalidTargetReconciliationRecoveryManifest = ProductError<
  "InvalidTargetReconciliationRecoveryManifest",
  Readonly<{
    stagingPath: string;
    reason:
      | "missing"
      | "invalid-json"
      | "invalid-shape"
      | "fact-mismatch";
  }>
>;

export async function writeTargetReconciliationRecoveryManifest(
  stagingPath: string,
  manifest: Omit<
    TargetReconciliationRecoveryManifest,
    "format"
  >
): Promise<void> {
  await mkdir(stagingPath, { recursive: true });
  const value: TargetReconciliationRecoveryManifest = {
    format: RECOVERY_FORMAT,
    ...manifest
  };
  await writeFile(
    join(stagingPath, RECOVERY_FILE),
    JSON.stringify(value) + "\n",
    {
      encoding: "utf8",
      flag: "wx"
    }
  );
}

export async function readTargetReconciliationRecoveryManifest(
  stagingPath: string,
  expected: Readonly<{
    operationId: string;
    targetId: string;
    activationName: string;
  }>
): Promise<
  Result<
    TargetReconciliationRecoveryManifest,
    InvalidTargetReconciliationRecoveryManifest
  >
> {
  let raw: string;
  try {
    raw = await readFile(
      join(stagingPath, RECOVERY_FILE),
      "utf8"
    );
  } catch {
    return invalidManifest(stagingPath, "missing");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return invalidManifest(stagingPath, "invalid-json");
  }
  const parsed = parseManifest(value);
  if (parsed === undefined) {
    return invalidManifest(stagingPath, "invalid-shape");
  }
  if (
    parsed.operationId !== expected.operationId ||
    parsed.targetId !== expected.targetId ||
    parsed.activationName !== expected.activationName
  ) {
    return invalidManifest(stagingPath, "fact-mismatch");
  }
  return { ok: true, value: parsed };
}

export function recoveryManifestPreviousOwned(
  manifest: TargetReconciliationRecoveryManifest
): TargetOwnedProjection | undefined {
  return manifest.previous === null
    ? undefined
    : {
        projection: manifest.previous.projection,
        ownership: "managed",
        materialization:
          manifest.previous.materialization
      };
}

function parseManifest(
  value: unknown
): TargetReconciliationRecoveryManifest | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "format",
      "operationId",
      "targetId",
      "activationName",
      "action",
      "previous"
    ]) ||
    value.format !== RECOVERY_FORMAT ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0 ||
    typeof value.targetId !== "string" ||
    value.targetId.length === 0 ||
    typeof value.activationName !== "string" ||
    value.activationName.length === 0 ||
    (value.action !== "stage" &&
      value.action !== "remove")
  ) {
    return undefined;
  }

  const previous =
    value.previous === null
      ? null
      : parsePrevious(value.previous);
  if (value.previous !== null && previous === undefined) {
    return undefined;
  }

  return {
    format: RECOVERY_FORMAT,
    operationId: value.operationId,
    targetId: value.targetId,
    activationName: value.activationName,
    action: value.action,
    previous:
      previous as TargetReconciliationRecoveryManifest["previous"]
  };
}

function parsePrevious(
  value: unknown
): NonNullable<
  TargetReconciliationRecoveryManifest["previous"]
> | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "projection",
      "materialization"
    ]) ||
    (value.materialization !== "symlink" &&
      value.materialization !== "junction" &&
      value.materialization !== "copy")
  ) {
    return undefined;
  }
  const projection = parseProjection(value.projection);
  if (projection === undefined) {
    return undefined;
  }
  return {
    projection,
    materialization: value.materialization
  };
}

function parseProjection(
  value: unknown
): TargetProjection | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "packageCoordinate",
      "packageRoot",
      "contentDigest",
      "activationName",
      "projectionKind",
      "transform"
    ]) ||
    typeof value.packageCoordinate !== "string" ||
    typeof value.packageRoot !== "string" ||
    typeof value.contentDigest !== "string" ||
    typeof value.activationName !== "string" ||
    (value.projectionKind !== "direct" &&
      value.projectionKind !== "transformed-copy")
  ) {
    return undefined;
  }

  const transform =
    value.transform === null
      ? null
      : parseTransform(value.transform);
  if (value.transform !== null && transform === undefined) {
    return undefined;
  }
  if (
    (value.projectionKind === "direct" &&
      transform !== null) ||
    (value.projectionKind === "transformed-copy" &&
      transform === null)
  ) {
    return undefined;
  }

  return {
    packageCoordinate: value.packageCoordinate,
    packageRoot: value.packageRoot,
    contentDigest: value.contentDigest,
    activationName: value.activationName,
    projectionKind: value.projectionKind,
    transform: transform as TargetProjection["transform"]
  };
}

function parseTransform(
  value: unknown
): TargetProjectionTransform | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "rename",
      "dependencyRoutes"
    ]) ||
    !Array.isArray(value.dependencyRoutes)
  ) {
    return undefined;
  }

  let rename: TargetProjectionTransform["rename"];
  if (value.rename === null) {
    rename = null;
  } else if (
    isRecord(value.rename) &&
    hasExactKeys(value.rename, [
      "fromActivationName",
      "toActivationName"
    ]) &&
    typeof value.rename.fromActivationName === "string" &&
    typeof value.rename.toActivationName === "string"
  ) {
    rename = {
      fromActivationName:
        value.rename.fromActivationName,
      toActivationName:
        value.rename.toActivationName
    };
  } else {
    return undefined;
  }

  const dependencyRoutes: TargetProjectionTransform["dependencyRoutes"][number][] = [];
  for (const route of value.dependencyRoutes) {
    if (
      !isRecord(route) ||
      !hasExactKeys(route, [
        "dependencyPackageCoordinate",
        "fromActivationName",
        "toActivationName"
      ]) ||
      typeof route.dependencyPackageCoordinate !== "string" ||
      typeof route.fromActivationName !== "string" ||
      typeof route.toActivationName !== "string"
    ) {
      return undefined;
    }
    dependencyRoutes.push({
      dependencyPackageCoordinate:
        route.dependencyPackageCoordinate,
      fromActivationName: route.fromActivationName,
      toActivationName: route.toActivationName
    });
  }

  return { rename, dependencyRoutes };
}

function invalidManifest(
  stagingPath: string,
  reason:
    InvalidTargetReconciliationRecoveryManifest["facts"]["reason"]
): Result<never, InvalidTargetReconciliationRecoveryManifest> {
  return {
    ok: false,
    error: productError(
      "InvalidTargetReconciliationRecoveryManifest",
      { stagingPath, reason }
    )
  };
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

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlyArray<string>
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every(
      (key, index) => key === wanted[index]
    )
  );
}
