import {
  matchesReleaseRequirement,
  parseReleaseRequirement,
  parseReleaseVersion
} from "../requirement/index.js";
import type { Result } from "../errors/index.js";
import type {
  ExactExportManifest,
  InvalidExportPackage
} from "./types.js";
import { invalidExportPackage } from "./validation-error.js";

export function validateExactExportManifestCrossRecords(
  manifest: ExactExportManifest
): Result<void, InvalidExportPackage> {
  const sourceByRepository = new Map(
    manifest.sources.map((entry) => [
      entry.repositoryCoordinate,
      entry
    ])
  );
  const packages = new Map(
    manifest.packages.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  const projections = new Map(
    manifest.projections.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );

  for (let index = 0; index < manifest.packages.length; index += 1) {
    const packageFact = manifest.packages[index]!;
    const repository = repositoryFromPackage(
      packageFact.packageCoordinate
    );
    if (!sourceByRepository.has(repository)) {
      return invalidExportPackage(
        "dangling-reference",
        `packages[${index}].coordinate`
      );
    }
    if (!projections.has(packageFact.packageCoordinate)) {
      return invalidExportPackage(
        "projection-missing",
        `packages[${index}].coordinate`
      );
    }
  }

  for (let index = 0; index < manifest.projections.length; index += 1) {
    if (!packages.has(manifest.projections[index]!.packageCoordinate)) {
      return invalidExportPackage(
        "dangling-reference",
        `projections[${index}].package`
      );
    }
  }

  for (let index = 0; index < manifest.dependencies.length; index += 1) {
    const edge = manifest.dependencies[index]!;
    if (!packages.has(edge.fromPackageCoordinate)) {
      return invalidExportPackage(
        "dangling-reference",
        `dependencies[${index}].from`
      );
    }
    if (!packages.has(edge.toPackageCoordinate)) {
      return invalidExportPackage(
        "dangling-reference",
        `dependencies[${index}].to`
      );
    }
  }

  for (let index = 0; index < manifest.requirements.length; index += 1) {
    const requirement = manifest.requirements[index]!;
    if (
      requirement.kind === "package" &&
      !packages.has(requirement.coordinate)
    ) {
      return invalidExportPackage(
        "dangling-reference",
        `requirements[${index}].coordinate`
      );
    }

    const repository =
      requirement.kind === "package"
        ? repositoryFromPackage(requirement.coordinate)
        : requirement.coordinate;
    const source = sourceByRepository.get(repository);
    if (source === undefined) {
      return invalidExportPackage(
        "dangling-reference",
        `requirements[${index}].coordinate`
      );
    }
    if (source.sourceKind !== requirement.sourceKind) {
      return invalidExportPackage(
        "source-conflict",
        `requirements[${index}].source`
      );
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
        return invalidExportPackage(
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
    if (!packages.has(detached.packageCoordinate)) {
      return invalidExportPackage(
        "dangling-reference",
        `detached[${index}].package`
      );
    }
    const projection = projections.get(detached.packageCoordinate);
    if (projection?.activationName !== detached.activationName) {
      return invalidExportPackage(
        "dangling-reference",
        `detached[${index}].activation-name`
      );
    }
  }
  for (let index = 0; index < manifest.userSkills.length; index += 1) {
    const userSkill = manifest.userSkills[index]!;
    if (projectionActivations.has(userSkill.activationName)) {
      return invalidExportPackage(
        "activation-conflict",
        `user-skills[${index}].activation-name`
      );
    }
  }

  const reachable = reachablePackages(manifest);
  for (let index = 0; index < manifest.packages.length; index += 1) {
    const packageCoordinate =
      manifest.packages[index]!.packageCoordinate;
    if (!reachable.has(packageCoordinate)) {
      return invalidExportPackage(
        "unreachable-package",
        `packages[${index}].coordinate`
      );
    }
  }

  const usedRepositories = new Set<string>();
  for (const requirement of manifest.requirements) {
    usedRepositories.add(
      requirement.kind === "package"
        ? repositoryFromPackage(requirement.coordinate)
        : requirement.coordinate
    );
  }
  for (const packageFact of manifest.packages) {
    usedRepositories.add(
      repositoryFromPackage(packageFact.packageCoordinate)
    );
  }
  for (let index = 0; index < manifest.sources.length; index += 1) {
    const repository =
      manifest.sources[index]!.repositoryCoordinate;
    if (!usedRepositories.has(repository)) {
      return invalidExportPackage(
        "unused-source",
        `sources[${index}].repository`
      );
    }
  }

  return { ok: true, value: undefined };
}

function reachablePackages(
  manifest: ExactExportManifest
): ReadonlySet<string> {
  const roots = new Set<string>();
  for (const requirement of manifest.requirements) {
    if (requirement.kind === "package") {
      roots.add(requirement.coordinate);
      continue;
    }
    for (const packageFact of manifest.packages) {
      if (
        repositoryFromPackage(packageFact.packageCoordinate) ===
        requirement.coordinate
      ) {
        roots.add(packageFact.packageCoordinate);
      }
    }
  }

  const outgoing = new Map<string, string[]>();
  for (const edge of manifest.dependencies) {
    const targets = outgoing.get(edge.fromPackageCoordinate) ?? [];
    targets.push(edge.toPackageCoordinate);
    outgoing.set(edge.fromPackageCoordinate, targets);
  }

  const reached = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reached.has(current)) {
      continue;
    }
    reached.add(current);
    for (const target of outgoing.get(current) ?? []) {
      if (!reached.has(target)) {
        queue.push(target);
      }
    }
  }
  return reached;
}

function repositoryFromPackage(
  packageCoordinate: string
): string {
  return packageCoordinate.split("/").slice(0, 2).join("/");
}
