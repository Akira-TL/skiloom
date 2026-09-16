import { parse as parseToml, TomlDate } from "smol-toml";
import { parseDocument } from "yaml";

import {
  isValidSkillName,
  parsePackageCoordinate
} from "../coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";

export type PackageAdmissionErrorReason =
  | "missing-frontmatter"
  | "unterminated-frontmatter"
  | "invalid-frontmatter-yaml"
  | "frontmatter-not-map"
  | "missing-name"
  | "invalid-name"
  | "missing-description"
  | "invalid-description"
  | "invalid-license"
  | "invalid-compatibility"
  | "invalid-metadata"
  | "invalid-allowed-tools"
  | "unknown-frontmatter-field"
  | "name-root-mismatch";

export type InvalidSkillPackage = ProductError<
  "InvalidSkillPackage",
  Readonly<{
    rootBasename: string;
    reason: PackageAdmissionErrorReason;
  }>
>;

export type AdmittedSkillPackage = Readonly<{
  name: string;
  description: string;
}>;

export type SkillPackageInput = Readonly<{
  rootBasename: string;
  skillMarkdown: string;
}>;

export type PackageMetadata = Readonly<{
  dependencies: Readonly<Record<string, string>>;
  software: Readonly<Record<string, string>>;
}>;

export type PackageManifestErrorReason =
  | "invalid-toml"
  | "dependencies-not-table"
  | "invalid-dependency-coordinate"
  | "dependency-requirement-not-string"
  | "empty-dependency-requirement"
  | "duplicate-dependency-coordinate"
  | "software-not-table"
  | "software-requirement-not-string";

export type PackageMetadataError =
  | ProductError<"MissingManifestSchema", Readonly<Record<string, never>>>
  | ProductError<
      "InvalidManifestSchema",
      Readonly<{ actualType: string }>
    >
  | ProductError<
      "UnsupportedManifestSchema",
      Readonly<{ schema: number }>
    >
  | ProductError<"UnknownManifestField", Readonly<{ field: string }>>
  | ProductError<
      "InvalidPackageManifest",
      Readonly<{
        reason: PackageManifestErrorReason;
        path: string;
      }>
    >;

const SKILL_FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools"
]);

export function admitSkillPackage(
  input: SkillPackageInput
): Result<AdmittedSkillPackage, InvalidSkillPackage> {
  const frontmatterResult = extractFrontmatter(input.skillMarkdown);
  if (!frontmatterResult.ok) {
    return invalid(input.rootBasename, frontmatterResult.reason);
  }

  let document;
  try {
    document = parseDocument(frontmatterResult.yaml, {
      prettyErrors: false,
      uniqueKeys: true
    });
  } catch {
    return invalid(input.rootBasename, "invalid-frontmatter-yaml");
  }

  if (document.errors.length > 0) {
    return invalid(input.rootBasename, "invalid-frontmatter-yaml");
  }

  let frontmatter: unknown;
  try {
    frontmatter = document.toJS({ maxAliasCount: 100 });
  } catch {
    return invalid(input.rootBasename, "invalid-frontmatter-yaml");
  }

  if (!isPlainRecord(frontmatter)) {
    return invalid(input.rootBasename, "frontmatter-not-map");
  }

  if (
    Object.keys(frontmatter).some((field) => !SKILL_FRONTMATTER_FIELDS.has(field))
  ) {
    return invalid(input.rootBasename, "unknown-frontmatter-field");
  }

  const name = frontmatter.name;
  if (typeof name !== "string") {
    return invalid(input.rootBasename, "missing-name");
  }
  if (!isValidSkillName(name)) {
    return invalid(input.rootBasename, "invalid-name");
  }
  if (name !== input.rootBasename) {
    return invalid(input.rootBasename, "name-root-mismatch");
  }

  const description = frontmatter.description;
  if (typeof description !== "string") {
    return invalid(input.rootBasename, "missing-description");
  }
  const descriptionLength = characterLength(description);
  if (
    description.trim().length === 0 ||
    descriptionLength < 1 ||
    descriptionLength > 1024
  ) {
    return invalid(input.rootBasename, "invalid-description");
  }

  if (
    frontmatter.license !== undefined &&
    typeof frontmatter.license !== "string"
  ) {
    return invalid(input.rootBasename, "invalid-license");
  }

  if (frontmatter.compatibility !== undefined) {
    const compatibility = frontmatter.compatibility;
    if (
      typeof compatibility !== "string" ||
      characterLength(compatibility) < 1 ||
      characterLength(compatibility) > 500
    ) {
      return invalid(input.rootBasename, "invalid-compatibility");
    }
  }

  if (
    frontmatter.metadata !== undefined &&
    !isStringRecord(frontmatter.metadata)
  ) {
    return invalid(input.rootBasename, "invalid-metadata");
  }

  if (
    frontmatter["allowed-tools"] !== undefined &&
    typeof frontmatter["allowed-tools"] !== "string"
  ) {
    return invalid(input.rootBasename, "invalid-allowed-tools");
  }

  return {
    ok: true,
    value: {
      name,
      description
    }
  };
}

export function parsePackageMetadata(
  source: string | undefined
): Result<PackageMetadata, PackageMetadataError> {
  if (source === undefined) {
    return {
      ok: true,
      value: {
        dependencies: {},
        software: {}
      }
    };
  }

  let parsedDocument: unknown;
  try {
    parsedDocument = parseToml(source, {
      integersAsBigInt: true,
      maxDepth: 100
    });
  } catch {
    return invalidPackageManifest("invalid-toml", "$");
  }

  if (!isTomlTable(parsedDocument)) {
    return invalidPackageManifest("invalid-toml", "$");
  }
  const document = parsedDocument;

  if (!("schema" in document)) {
    return {
      ok: false,
      error: productError("MissingManifestSchema", {})
    };
  }

  const schema = document.schema;
  if (typeof schema !== "bigint" || schema <= 0n) {
    return {
      ok: false,
      error: productError("InvalidManifestSchema", {
        actualType: typeof schema
      })
    };
  }
  if (schema !== 1n) {
    return {
      ok: false,
      error: productError("UnsupportedManifestSchema", {
        schema: Number(schema)
      })
    };
  }

  const unknownField = firstUnknownField(document, [
    "schema",
    "dependencies",
    "software"
  ]);
  if (unknownField !== undefined) {
    return {
      ok: false,
      error: productError("UnknownManifestField", {
        field: unknownField
      })
    };
  }

  const dependencyEntries: Array<readonly [string, string]> = [];
  const dependencyCoordinates = new Set<string>();
  if (document.dependencies !== undefined) {
    if (!isTomlTable(document.dependencies)) {
      return invalidPackageManifest("dependencies-not-table", "dependencies");
    }

    for (const [rawCoordinate, requirement] of Object.entries(
      document.dependencies
    )) {
      const coordinateResult = parsePackageCoordinate(rawCoordinate);
      if (!coordinateResult.ok) {
        return invalidPackageManifest(
          "invalid-dependency-coordinate",
          `dependencies.${rawCoordinate}`
        );
      }

      if (typeof requirement !== "string") {
        return invalidPackageManifest(
          "dependency-requirement-not-string",
          `dependencies.${rawCoordinate}`
        );
      }
      if (requirement.trim().length === 0) {
        return invalidPackageManifest(
          "empty-dependency-requirement",
          `dependencies.${rawCoordinate}`
        );
      }

      const coordinate = coordinateResult.value.canonical;
      if (dependencyCoordinates.has(coordinate)) {
        return invalidPackageManifest(
          "duplicate-dependency-coordinate",
          `dependencies.${coordinate}`
        );
      }
      dependencyCoordinates.add(coordinate);
      dependencyEntries.push([coordinate, requirement]);
    }
  }

  const softwareEntries: Array<readonly [string, string]> = [];
  if (document.software !== undefined) {
    if (!isTomlTable(document.software)) {
      return invalidPackageManifest("software-not-table", "software");
    }

    for (const [name, requirement] of Object.entries(document.software)) {
      if (typeof requirement !== "string") {
        return invalidPackageManifest(
          "software-requirement-not-string",
          `software.${name}`
        );
      }
      softwareEntries.push([name, requirement]);
    }
  }

  dependencyEntries.sort(([left], [right]) => compareStrings(left, right));
  softwareEntries.sort(([left], [right]) => compareStrings(left, right));

  return {
    ok: true,
    value: {
      dependencies: Object.fromEntries(dependencyEntries),
      software: Object.fromEntries(softwareEntries)
    }
  };
}

function extractFrontmatter(markdown: string):
  | Readonly<{ ok: true; yaml: string }>
  | Readonly<{
      ok: false;
      reason: "missing-frontmatter" | "unterminated-frontmatter";
    }> {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0] !== "---") {
    return { ok: false, reason: "missing-frontmatter" };
  }

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    return { ok: false, reason: "unterminated-frontmatter" };
  }

  return {
    ok: true,
    yaml: lines.slice(1, closingIndex).join("\n")
  };
}

function invalid(
  rootBasename: string,
  reason: PackageAdmissionErrorReason
): Result<never, InvalidSkillPackage> {
  return {
    ok: false,
    error: productError("InvalidSkillPackage", {
      rootBasename,
      reason
    })
  };
}

function invalidPackageManifest(
  reason: PackageManifestErrorReason,
  path: string
): Result<never, PackageMetadataError> {
  return {
    ok: false,
    error: productError("InvalidPackageManifest", {
      reason,
      path
    })
  };
}

function firstUnknownField(
  value: Readonly<Record<string, unknown>>,
  allowedFields: ReadonlyArray<string>
): string | undefined {
  const allowed = new Set(allowedFields);
  return Object.keys(value)
    .filter((field) => !allowed.has(field))
    .sort(compareStrings)[0];
}

function isTomlTable(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && !(value instanceof TomlDate);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isPlainRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}
