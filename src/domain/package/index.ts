import { parseDocument } from "yaml";

import { isValidSkillName } from "../coordinate/index.js";
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
