import { parse as parseToml } from "smol-toml";

import {
  productError,
  type Result
} from "../errors/index.js";
import {
  canonicalPackageCoordinate,
  canonicalRepositoryCoordinate,
  compareUtf8,
  firstUnknownField,
  isCanonicalContentDigest,
  isCanonicalExactCommit,
  isCanonicalReleaseVersion,
  isTomlTable,
  isValidPackageRoot,
  isValidPublicActivationName,
  parsePublicRequirementTable,
  requiredString,
  tomlString,
  writePublicRequirementTable,
  type PublicFormatIssue
} from "../public-format/common.js";
import { isValidSkillName } from "../coordinate/index.js";
import {
  matchesReleaseRequirement,
  parseReleaseRequirement,
  parseReleaseVersion
} from "../requirement/index.js";
import type {
  ExactExportDependency,
  ExactExportDetached,
  ExactExportManagedPackage,
  ExactExportManifest,
  ExactExportParseError,
  ExactExportProjection,
  ExactExportSource,
  ExactExportUserSkill,
  InvalidExportPackage,
  InvalidExportPackageReason
} from "./types.js";

const FORMAT = "SKILOOM-EXPORT-V1";
const FUTURE_FORMAT_PATTERN = /^SKILOOM-EXPORT-V[0-9]+$/u;

export function parseExactExportManifest(
  source: string
): Result<ExactExportManifest, ExactExportParseError> {
  let parsed: unknown;
  try {
    parsed = parseToml(source, {
      integersAsBigInt: true,
      maxDepth: 100
    });
  } catch {
    return invalid("invalid-toml", "manifest");
  }
  if (!isTomlTable(parsed)) {
    return invalid("invalid-toml", "manifest");
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
          error: productError("UnsupportedExportVersion", {
            format
          })
        }
      : invalid("invalid-field", "format");
  }

  const unknown = firstUnknownField(parsed, [
    "format",
    "mode",
    "requirements",
    "sources",
    "packages",
    "dependencies",
    "projections",
    "detached",
    "user-skills"
  ]);
  if (unknown !== undefined) {
    return invalid("unknown-field", unknown);
  }

  const mode = parsed.mode;
  if (mode === undefined) {
    return invalid("missing-field", "mode");
  }
  if (mode !== "dependencies" && mode !== "full") {
    return invalid("invalid-field", "mode");
  }

  const requirements = parseRequirements(parsed.requirements);
  if (!requirements.ok) return requirements;
  const sources = parseSources(parsed.sources);
  if (!sources.ok) return sources;
  const packages = parsePackages(parsed.packages);
  if (!packages.ok) return packages;
  const dependencies = parseDependencies(parsed.dependencies);
  if (!dependencies.ok) return dependencies;
  const projections = parseProjections(parsed.projections);
  if (!projections.ok) return projections;
  const detached = parseDetached(parsed.detached);
  if (!detached.ok) return detached;
  const userSkills = parseUserSkills(parsed["user-skills"]);
  if (!userSkills.ok) return userSkills;

  if (
    mode === "dependencies" &&
    detached.value.length > 0
  ) {
    return invalid("mode-conflict", "detached");
  }
  if (
    mode === "dependencies" &&
    userSkills.value.length > 0
  ) {
    return invalid("mode-conflict", "user-skills");
  }

  const manifest: ExactExportManifest = {
    format: FORMAT,
    mode,
    requirements: requirements.value,
    sources: sources.value,
    packages: packages.value,
    dependencies: dependencies.value,
    projections: projections.value,
    detached: detached.value,
    userSkills: userSkills.value
  };
  const cross = validateCrossRecords(manifest);
  return cross.ok ? { ok: true, value: manifest } : cross;
}

export function writeExactExportManifest(
  manifest: ExactExportManifest
): string {
  const lines: string[] = [
    `format = ${tomlString(FORMAT)}`,
    `mode = ${tomlString(manifest.mode)}`
  ];

  for (const requirement of [...manifest.requirements].sort(
    compareRequirements
  )) {
    lines.push("", ...writePublicRequirementTable(requirement));
  }
  for (const source of [...manifest.sources].sort((left, right) =>
    compareUtf8(
      left.repositoryCoordinate,
      right.repositoryCoordinate
    )
  )) {
    lines.push("", ...writeSource(source));
  }
  for (const packageFact of [...manifest.packages].sort(
    (left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
  )) {
    lines.push("", ...writePackage(packageFact));
  }
  for (const edge of [...manifest.dependencies].sort(compareDependencies)) {
    lines.push("", ...writeDependency(edge));
  }
  for (const projection of [...manifest.projections].sort(
    (left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
  )) {
    lines.push("", ...writeProjection(projection));
  }
  for (const detached of [...manifest.detached].sort((left, right) =>
    compareUtf8(
      left.packageCoordinate,
      right.packageCoordinate
    )
  )) {
    lines.push("", ...writeDetached(detached));
  }
  for (const userSkill of [...manifest.userSkills].sort(compareUserSkills)) {
    lines.push("", ...writeUserSkill(userSkill));
  }

  return lines.join("\n") + "\n";
}

function parseRequirements(
  value: unknown
): Result<ExactExportManifest["requirements"], InvalidExportPackage> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return invalid("invalid-field", "requirements");
  const result: ExactExportManifest["requirements"][number][] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `requirements[${index}]`;
    const parsed = parsePublicRequirementTable(value[index], path);
    if (!parsed.ok) return invalidIssue(parsed.issue);
    const key = `${parsed.value.kind}\u0000${parsed.value.coordinate}`;
    if (seen.has(key)) return invalid("duplicate-requirement", path);
    seen.add(key);
    result.push(parsed.value);
  }
  return { ok: true, value: result.sort(compareRequirements) };
}

function parseSources(
  value: unknown
): Result<ReadonlyArray<ExactExportSource>, InvalidExportPackage> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return invalid("invalid-field", "sources");
  const result: ExactExportSource[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `sources[${index}]`;
    const entry = value[index];
    if (!isTomlTable(entry)) return invalid("invalid-field", path);
    const kind = requiredString(entry, "kind", path);
    if (!kind.ok) return invalidIssue(kind.issue);
    const allowed =
      kind.value === "github-release"
        ? ["repository", "kind", "version", "tag", "commit", "immutable"]
        : kind.value === "git"
          ? ["repository", "kind", "commit"]
          : null;
    if (allowed === null) return invalid("invalid-field", `${path}.kind`);
    const unknown = firstUnknownField(entry, allowed);
    if (unknown !== undefined) return invalid("unknown-field", `${path}.${unknown}`);

    const repository = requiredString(entry, "repository", path);
    if (!repository.ok) return invalidIssue(repository.issue);
    const repositoryCoordinate = canonicalRepositoryCoordinate(repository.value);
    if (repositoryCoordinate === undefined) return invalid("invalid-field", `${path}.repository`);
    if (seen.has(repositoryCoordinate)) return invalid("duplicate-source", path);
    seen.add(repositoryCoordinate);

    const commit = requiredString(entry, "commit", path);
    if (!commit.ok) return invalidIssue(commit.issue);
    if (!isCanonicalExactCommit(commit.value)) return invalid("invalid-field", `${path}.commit`);

    if (kind.value === "git") {
      result.push({
        repositoryCoordinate,
        sourceKind: "git",
        exactCommit: commit.value
      });
      continue;
    }

    const version = requiredString(entry, "version", path);
    if (!version.ok) return invalidIssue(version.issue);
    if (!isCanonicalReleaseVersion(version.value)) return invalid("invalid-field", `${path}.version`);
    const tag = requiredString(entry, "tag", path);
    if (!tag.ok) return invalidIssue(tag.issue);
    if (tag.value.length === 0) return invalid("invalid-field", `${path}.tag`);
    let immutable: boolean | null = null;
    if (entry.immutable !== undefined) {
      if (typeof entry.immutable !== "boolean") return invalid("invalid-field", `${path}.immutable`);
      immutable = entry.immutable;
    }
    result.push({
      repositoryCoordinate,
      sourceKind: "github-release",
      version: version.value,
      actualTag: tag.value,
      exactCommit: commit.value,
      immutable
    });
  }
  return {
    ok: true,
    value: result.sort((left, right) =>
      compareUtf8(left.repositoryCoordinate, right.repositoryCoordinate)
    )
  };
}

function parsePackages(
  value: unknown
): Result<ReadonlyArray<ExactExportManagedPackage>, InvalidExportPackage> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return invalid("invalid-field", "packages");
  const result: ExactExportManagedPackage[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `packages[${index}]`;
    const entry = value[index];
    if (!isTomlTable(entry)) return invalid("invalid-field", path);
    const unknown = firstUnknownField(entry, [
      "coordinate",
      "package-root",
      "content-digest",
      "payload"
    ]);
    if (unknown !== undefined) return invalid("unknown-field", `${path}.${unknown}`);
    const coordinate = requiredString(entry, "coordinate", path);
    if (!coordinate.ok) return invalidIssue(coordinate.issue);
    const packageCoordinate = canonicalPackageCoordinate(coordinate.value);
    if (packageCoordinate === undefined) return invalid("invalid-field", `${path}.coordinate`);
    if (seen.has(packageCoordinate)) return invalid("duplicate-package", path);
    seen.add(packageCoordinate);
    const root = requiredString(entry, "package-root", path);
    if (!root.ok) return invalidIssue(root.issue);
    if (!isValidPackageRoot(root.value)) return invalid("invalid-field", `${path}.package-root`);
    const digest = requiredString(entry, "content-digest", path);
    if (!digest.ok) return invalidIssue(digest.issue);
    if (!isCanonicalContentDigest(digest.value)) return invalid("invalid-field", `${path}.content-digest`);
    const payload = requiredString(entry, "payload", path);
    if (!payload.ok) return invalidIssue(payload.issue);
    if (payload.value !== `package:${digest.value}`) return invalid("payload-id-mismatch", `${path}.payload`);
    result.push({
      packageCoordinate,
      packageRoot: root.value,
      contentDigest: digest.value,
      payloadId: payload.value
    });
  }
  return {
    ok: true,
    value: result.sort((left, right) =>
      compareUtf8(left.packageCoordinate, right.packageCoordinate)
    )
  };
}

function parseDependencies(
  value: unknown
): Result<ReadonlyArray<ExactExportDependency>, InvalidExportPackage> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return invalid("invalid-field", "dependencies");
  const result: ExactExportDependency[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `dependencies[${index}]`;
    const entry = value[index];
    if (!isTomlTable(entry)) return invalid("invalid-field", path);
    const unknown = firstUnknownField(entry, ["from", "to"]);
    if (unknown !== undefined) return invalid("unknown-field", `${path}.${unknown}`);
    const from = requiredString(entry, "from", path);
    if (!from.ok) return invalidIssue(from.issue);
    const to = requiredString(entry, "to", path);
    if (!to.ok) return invalidIssue(to.issue);
    const fromCoordinate = canonicalPackageCoordinate(from.value);
    const toCoordinate = canonicalPackageCoordinate(to.value);
    if (fromCoordinate === undefined) return invalid("invalid-field", `${path}.from`);
    if (toCoordinate === undefined) return invalid("invalid-field", `${path}.to`);
    const key = `${fromCoordinate}\u0000${toCoordinate}`;
    if (seen.has(key)) return invalid("duplicate-dependency", path);
    seen.add(key);
    result.push({
      fromPackageCoordinate: fromCoordinate,
      toPackageCoordinate: toCoordinate
    });
  }
  return { ok: true, value: result.sort(compareDependencies) };
}

function parseProjections(
  value: unknown
): Result<ReadonlyArray<ExactExportProjection>, InvalidExportPackage> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return invalid("invalid-field", "projections");
  const result: ExactExportProjection[] = [];
  const packages = new Set<string>();
  const activations = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `projections[${index}]`;
    const entry = value[index];
    if (!isTomlTable(entry)) return invalid("invalid-field", path);
    const unknown = firstUnknownField(entry, ["package", "activation-name"]);
    if (unknown !== undefined) return invalid("unknown-field", `${path}.${unknown}`);
    const packageValue = requiredString(entry, "package", path);
    if (!packageValue.ok) return invalidIssue(packageValue.issue);
    const packageCoordinate = canonicalPackageCoordinate(packageValue.value);
    if (packageCoordinate === undefined) return invalid("invalid-field", `${path}.package`);
    if (packages.has(packageCoordinate)) return invalid("duplicate-projection", path);
    const activation = requiredString(entry, "activation-name", path);
    if (!activation.ok) return invalidIssue(activation.issue);
    if (!isValidPublicActivationName(activation.value)) return invalid("invalid-field", `${path}.activation-name`);
    if (activations.has(activation.value)) return invalid("activation-conflict", `${path}.activation-name`);
    packages.add(packageCoordinate);
    activations.add(activation.value);
    result.push({ packageCoordinate, activationName: activation.value });
  }
  return {
    ok: true,
    value: result.sort((left, right) =>
      compareUtf8(left.packageCoordinate, right.packageCoordinate)
    )
  };
}

function parseDetached(
  value: unknown
): Result<ReadonlyArray<ExactExportDetached>, InvalidExportPackage> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return invalid("invalid-field", "detached");
  const result: ExactExportDetached[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `detached[${index}]`;
    const entry = value[index];
    if (!isTomlTable(entry)) return invalid("invalid-field", path);
    const source = requiredString(entry, "baseline-source", path);
    if (!source.ok) return invalidIssue(source.issue);
    const allowed = source.value === "github-release"
      ? ["package","activation-name","payload","content-digest","baseline-source","baseline-version","baseline-tag","baseline-commit","baseline-package-root","baseline-content-digest"]
      : source.value === "git"
        ? ["package","activation-name","payload","content-digest","baseline-source","baseline-ref","baseline-commit","baseline-package-root","baseline-content-digest"]
        : null;
    if (allowed === null) return invalid("invalid-field", `${path}.baseline-source`);
    const unknown = firstUnknownField(entry, allowed);
    if (unknown !== undefined) return invalid("unknown-field", `${path}.${unknown}`);
    const packageValue = requiredString(entry, "package", path);
    if (!packageValue.ok) return invalidIssue(packageValue.issue);
    const packageCoordinate = canonicalPackageCoordinate(packageValue.value);
    if (packageCoordinate === undefined) return invalid("invalid-field", `${path}.package`);
    if (seen.has(packageCoordinate)) return invalid("duplicate-detached", path);
    seen.add(packageCoordinate);
    const activation = requiredString(entry, "activation-name", path);
    if (!activation.ok) return invalidIssue(activation.issue);
    if (!isValidPublicActivationName(activation.value)) return invalid("invalid-field", `${path}.activation-name`);
    const userDigest = requiredString(entry, "content-digest", path);
    if (!userDigest.ok) return invalidIssue(userDigest.issue);
    if (!isCanonicalContentDigest(userDigest.value)) return invalid("invalid-field", `${path}.content-digest`);
    const payload = requiredString(entry, "payload", path);
    if (!payload.ok) return invalidIssue(payload.issue);
    if (payload.value !== `user:${userDigest.value}`) return invalid("payload-id-mismatch", `${path}.payload`);
    const baseline = parseBaselineCommon(entry, path);
    if (!baseline.ok) return baseline;
    if (source.value === "github-release") {
      const version = requiredString(entry, "baseline-version", path);
      if (!version.ok) return invalidIssue(version.issue);
      if (!isCanonicalReleaseVersion(version.value)) return invalid("invalid-field", `${path}.baseline-version`);
      const tag = requiredString(entry, "baseline-tag", path);
      if (!tag.ok) return invalidIssue(tag.issue);
      if (tag.value.length === 0) return invalid("invalid-field", `${path}.baseline-tag`);
      result.push({
        packageCoordinate,
        activationName: activation.value,
        payloadId: payload.value,
        userContentDigest: userDigest.value,
        sourceKind: "github-release",
        version: version.value,
        actualTag: tag.value,
        exactCommit: baseline.value.exactCommit,
        packageRoot: baseline.value.packageRoot,
        contentDigest: baseline.value.contentDigest
      });
    } else {
      const ref = requiredString(entry, "baseline-ref", path);
      if (!ref.ok) return invalidIssue(ref.issue);
      if (ref.value.length === 0) return invalid("invalid-field", `${path}.baseline-ref`);
      result.push({
        packageCoordinate,
        activationName: activation.value,
        payloadId: payload.value,
        userContentDigest: userDigest.value,
        sourceKind: "git",
        requestedRef: ref.value,
        exactCommit: baseline.value.exactCommit,
        packageRoot: baseline.value.packageRoot,
        contentDigest: baseline.value.contentDigest
      });
    }
  }
  return {
    ok: true,
    value: result.sort((left, right) =>
      compareUtf8(left.packageCoordinate, right.packageCoordinate)
    )
  };
}

function parseBaselineCommon(
  entry: Readonly<Record<string, unknown>>,
  path: string
): Result<Readonly<{ exactCommit: string; packageRoot: string; contentDigest: string }>, InvalidExportPackage> {
  const commit = requiredString(entry, "baseline-commit", path);
  if (!commit.ok) return invalidIssue(commit.issue);
  if (!isCanonicalExactCommit(commit.value)) return invalid("invalid-field", `${path}.baseline-commit`);
  const root = requiredString(entry, "baseline-package-root", path);
  if (!root.ok) return invalidIssue(root.issue);
  if (!isValidPackageRoot(root.value)) return invalid("invalid-field", `${path}.baseline-package-root`);
  const digest = requiredString(entry, "baseline-content-digest", path);
  if (!digest.ok) return invalidIssue(digest.issue);
  if (!isCanonicalContentDigest(digest.value)) return invalid("invalid-field", `${path}.baseline-content-digest`);
  return { ok: true, value: { exactCommit: commit.value, packageRoot: root.value, contentDigest: digest.value } };
}

function parseUserSkills(
  value: unknown
): Result<ReadonlyArray<ExactExportUserSkill>, InvalidExportPackage> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return invalid("invalid-field", "user-skills");
  const result: ExactExportUserSkill[] = [];
  const activations = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const path = `user-skills[${index}]`;
    const entry = value[index];
    if (!isTomlTable(entry)) return invalid("invalid-field", path);
    const unknown = firstUnknownField(entry, ["activation-name","skill-name","payload","content-digest"]);
    if (unknown !== undefined) return invalid("unknown-field", `${path}.${unknown}`);
    const activation = requiredString(entry, "activation-name", path);
    if (!activation.ok) return invalidIssue(activation.issue);
    if (!isValidPublicActivationName(activation.value)) return invalid("invalid-field", `${path}.activation-name`);
    if (activations.has(activation.value)) return invalid("duplicate-user-skill", path);
    activations.add(activation.value);
    const skill = requiredString(entry, "skill-name", path);
    if (!skill.ok) return invalidIssue(skill.issue);
    if (!isValidSkillName(skill.value)) return invalid("invalid-field", `${path}.skill-name`);
    const digest = requiredString(entry, "content-digest", path);
    if (!digest.ok) return invalidIssue(digest.issue);
    if (!isCanonicalContentDigest(digest.value)) return invalid("invalid-field", `${path}.content-digest`);
    const payload = requiredString(entry, "payload", path);
    if (!payload.ok) return invalidIssue(payload.issue);
    if (payload.value !== `user:${digest.value}`) return invalid("payload-id-mismatch", `${path}.payload`);
    result.push({
      activationName: activation.value,
      skillName: skill.value,
      payloadId: payload.value,
      userContentDigest: digest.value
    });
  }
  return { ok: true, value: result.sort(compareUserSkills) };
}

function validateCrossRecords(
  manifest: ExactExportManifest
): Result<void, InvalidExportPackage> {
  const sourceByRepository = new Map(
    manifest.sources.map((entry) => [
      entry.repositoryCoordinate,
      entry
    ])
  );
  const sources = new Set(sourceByRepository.keys());
  const packages = new Map(
    manifest.packages.map((entry) => [entry.packageCoordinate, entry])
  );
  const projections = new Map(
    manifest.projections.map((entry) => [entry.packageCoordinate, entry])
  );

  for (let index = 0; index < manifest.packages.length; index += 1) {
    const packageFact = manifest.packages[index]!;
    const repository = packageFact.packageCoordinate.split("/").slice(0, 2).join("/");
    if (!sources.has(repository)) return invalid("dangling-reference", `packages[${index}].coordinate`);
    if (!projections.has(packageFact.packageCoordinate)) return invalid("projection-missing", `packages[${index}].coordinate`);
  }
  for (let index = 0; index < manifest.projections.length; index += 1) {
    if (!packages.has(manifest.projections[index]!.packageCoordinate)) return invalid("dangling-reference", `projections[${index}].package`);
  }
  for (let index = 0; index < manifest.dependencies.length; index += 1) {
    const edge = manifest.dependencies[index]!;
    if (!packages.has(edge.fromPackageCoordinate)) return invalid("dangling-reference", `dependencies[${index}].from`);
    if (!packages.has(edge.toPackageCoordinate)) return invalid("dangling-reference", `dependencies[${index}].to`);
  }
  for (let index = 0; index < manifest.requirements.length; index += 1) {
    const requirement = manifest.requirements[index]!;
    if (
      requirement.kind === "package" &&
      !packages.has(requirement.coordinate)
    ) {
      return invalid("dangling-reference", `requirements[${index}].coordinate`);
    }
    const repository =
      requirement.kind === "package"
        ? requirement.coordinate.split("/").slice(0, 2).join("/")
        : requirement.coordinate;
    const source = sourceByRepository.get(repository);
    if (source === undefined) {
      return invalid("dangling-reference", `requirements[${index}].coordinate`);
    }
    if (source.sourceKind !== requirement.sourceKind) {
      return invalid("source-conflict", `requirements[${index}].source`);
    }
    if (
      requirement.sourceKind === "github-release" &&
      requirement.versionRequirement !== null
    ) {
      const parsedRequirement = parseReleaseRequirement(
        requirement.versionRequirement
      );
      const parsedVersion =
        source.sourceKind === "github-release"
          ? parseReleaseVersion(source.version)
          : null;
      if (
        !parsedRequirement.ok ||
        parsedVersion === null ||
        !parsedVersion.ok ||
        !matchesReleaseRequirement(
          parsedRequirement.value,
          parsedVersion.value
        )
      ) {
        return invalid(
          "requirement-mismatch",
          `requirements[${index}].version`
        );
      }
    }
  }

  const projectionActivations = new Set(
    manifest.projections.map((entry) => entry.activationName)
  );
  for (let index = 0; index < manifest.detached.length; index += 1) {
    const detached = manifest.detached[index]!;
    if (!packages.has(detached.packageCoordinate)) return invalid("dangling-reference", `detached[${index}].package`);
    const projection = projections.get(detached.packageCoordinate);
    if (projection?.activationName !== detached.activationName) return invalid("dangling-reference", `detached[${index}].activation-name`);
  }
  for (let index = 0; index < manifest.userSkills.length; index += 1) {
    const userSkill = manifest.userSkills[index]!;
    if (projectionActivations.has(userSkill.activationName)) {
      return invalid("activation-conflict", `user-skills[${index}].activation-name`);
    }
  }
  return { ok: true, value: undefined };
}

function writeSource(source: ExactExportSource): ReadonlyArray<string> {
  const lines = [
    "[[sources]]",
    `repository = ${tomlString(source.repositoryCoordinate)}`,
    `kind = ${tomlString(source.sourceKind)}`
  ];
  if (source.sourceKind === "github-release") {
    lines.push(
      `version = ${tomlString(source.version)}`,
      `tag = ${tomlString(source.actualTag)}`,
      `commit = ${tomlString(source.exactCommit)}`
    );
    if (source.immutable !== null) {
      lines.push(`immutable = ${source.immutable ? "true" : "false"}`);
    }
  } else {
    lines.push(`commit = ${tomlString(source.exactCommit)}`);
  }
  return lines;
}

function writePackage(entry: ExactExportManagedPackage): ReadonlyArray<string> {
  return [
    "[[packages]]",
    `coordinate = ${tomlString(entry.packageCoordinate)}`,
    `package-root = ${tomlString(entry.packageRoot)}`,
    `content-digest = ${tomlString(entry.contentDigest)}`,
    `payload = ${tomlString(entry.payloadId)}`
  ];
}

function writeDependency(entry: ExactExportDependency): ReadonlyArray<string> {
  return [
    "[[dependencies]]",
    `from = ${tomlString(entry.fromPackageCoordinate)}`,
    `to = ${tomlString(entry.toPackageCoordinate)}`
  ];
}

function writeProjection(entry: ExactExportProjection): ReadonlyArray<string> {
  return [
    "[[projections]]",
    `package = ${tomlString(entry.packageCoordinate)}`,
    `activation-name = ${tomlString(entry.activationName)}`
  ];
}

function writeDetached(entry: ExactExportDetached): ReadonlyArray<string> {
  const lines = [
    "[[detached]]",
    `package = ${tomlString(entry.packageCoordinate)}`,
    `activation-name = ${tomlString(entry.activationName)}`,
    `payload = ${tomlString(entry.payloadId)}`,
    `content-digest = ${tomlString(entry.userContentDigest)}`,
    `baseline-source = ${tomlString(entry.sourceKind)}`
  ];
  if (entry.sourceKind === "github-release") {
    lines.push(
      `baseline-version = ${tomlString(entry.version)}`,
      `baseline-tag = ${tomlString(entry.actualTag)}`
    );
  } else {
    lines.push(`baseline-ref = ${tomlString(entry.requestedRef)}`);
  }
  lines.push(
    `baseline-commit = ${tomlString(entry.exactCommit)}`,
    `baseline-package-root = ${tomlString(entry.packageRoot)}`,
    `baseline-content-digest = ${tomlString(entry.contentDigest)}`
  );
  return lines;
}

function writeUserSkill(entry: ExactExportUserSkill): ReadonlyArray<string> {
  return [
    "[[user-skills]]",
    `activation-name = ${tomlString(entry.activationName)}`,
    `skill-name = ${tomlString(entry.skillName)}`,
    `payload = ${tomlString(entry.payloadId)}`,
    `content-digest = ${tomlString(entry.userContentDigest)}`
  ];
}

function compareRequirements(
  left: ExactExportManifest["requirements"][number],
  right: ExactExportManifest["requirements"][number]
): number {
  for (const [a, b] of [
    [left.kind, right.kind],
    [left.coordinate, right.coordinate],
    [left.sourceKind, right.sourceKind],
    [requirementDetail(left), requirementDetail(right)]
  ] as const) {
    const compared = compareUtf8(a, b);
    if (compared !== 0) return compared;
  }
  return 0;
}

function requirementDetail(value: ExactExportManifest["requirements"][number]): string {
  return value.sourceKind === "git"
    ? value.requestedRef
    : value.versionRequirement ?? "";
}

function compareDependencies(left: ExactExportDependency, right: ExactExportDependency): number {
  const from = compareUtf8(left.fromPackageCoordinate, right.fromPackageCoordinate);
  return from !== 0 ? from : compareUtf8(left.toPackageCoordinate, right.toPackageCoordinate);
}

function compareUserSkills(left: ExactExportUserSkill, right: ExactExportUserSkill): number {
  const activation = compareUtf8(left.activationName, right.activationName);
  return activation !== 0 ? activation : compareUtf8(left.skillName, right.skillName);
}

function invalidIssue(issue: PublicFormatIssue): Result<never, InvalidExportPackage> {
  return invalid(issue.reason, issue.path);
}

function invalid(
  reason: InvalidExportPackageReason,
  path: string
): Result<never, InvalidExportPackage> {
  return {
    ok: false,
    error: productError("InvalidExportPackage", { reason, path })
  };
}
