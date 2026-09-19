import { TextDecoder } from "node:util";

import {
  parsePackageCoordinate
} from "../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import type {
  ExactExportManifest,
  ExactExportPackage
} from "../../domain/export-package/index.js";
import {
  admitSkillPackage,
  parsePackageMetadata
} from "../../domain/package/index.js";
import type {
  ResolverCandidateGraph
} from "../../domain/resolver/index.js";
import {
  createPackageSnapshot,
  type PackageSnapshot
} from "../../domain/snapshot/index.js";
import {
  preflightTargetOwnership,
  type TargetOwnedProjection,
  type TargetOwnershipPreflight,
  type TargetOwnershipPreflightError
} from "../../domain/target/preflight.js";
import type {
  TargetPlan,
  TargetPlanError,
  TargetProjectionRename
} from "../../domain/target/index.js";
import type {
  RegistryDirectRequirement,
  RegistryResolvedSource,
  RegistryTargetStateInput
} from "../registry/index.js";
import {
  planLifecycleTarget,
  projectionMaterialization,
  projectionTransformJson,
  repositoryFromPackageCoordinate
} from "../orchestration/lifecycle/apply.js";
import {
  registryRequirementsToDomain
} from "../orchestration/lifecycle/requirements.js";

const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true
});

export type InvalidExactImportPackageFacts = ProductError<
  "InvalidExactImportPackageFacts",
  Readonly<{
    reason:
      | "invalid-direct-requirements"
      | "projection-mismatch"
      | "git-source-without-ref"
      | "git-source-ref-conflict"
      | "managed-skill-missing"
      | "managed-skill-invalid-utf8"
      | "managed-skill-invalid"
      | "managed-dependency-mismatch"
      | "user-skill-missing"
      | "user-skill-invalid-utf8"
      | "user-skill-invalid";
    subject: string;
  }>
>;

export type PrepareExactImportError =
  | InvalidExactImportPackageFacts
  | TargetPlanError
  | TargetOwnershipPreflightError;

export type PreparedImportUserPayload = Readonly<{
  kind: "detached" | "user-skill";
  packageCoordinate: string | null;
  activationName: string;
  contentDigest: string;
  entries: ReadonlyArray<Readonly<{
    path: string;
    executable: boolean;
    content: Uint8Array;
  }>>;
}>;

export type PreparedExactImport = Readonly<{
  manifest: ExactExportManifest;
  plan: TargetPlan;
  preflight: TargetOwnershipPreflight;
  currentProjections: ReadonlyArray<TargetOwnedProjection>;
  nextState: RegistryTargetStateInput;
  managedSnapshots: ReadonlyArray<Readonly<{
    packageCoordinate: string;
    snapshot: PackageSnapshot;
  }>>;
  userPayloads: ReadonlyArray<PreparedImportUserPayload>;
}>;

export function prepareExactImport(
  input: Readonly<{
    parsed: ExactExportPackage;
    targetId: string;
    targetRoot: string;
  }>
): Result<PreparedExactImport, PrepareExactImportError> {
  const requirements = registryRequirementsToDomain(
    input.targetId,
    input.parsed.manifest.requirements as ReadonlyArray<RegistryDirectRequirement>
  );
  if (!requirements.ok) {
    return invalid(
      "invalid-direct-requirements",
      input.targetId
    );
  }

  const candidate: ResolverCandidateGraph = {
    sourceBindings: [],
    packages: input.parsed.manifest.packages.map((entry) => ({
      packageCoordinate: entry.packageCoordinate,
      packageRoot: entry.packageRoot,
      contentDigest: entry.contentDigest
    })),
    dependencyEdges: input.parsed.manifest.dependencies.map((entry) => ({
      sourcePackageCoordinate:
        entry.fromPackageCoordinate,
      targetPackageCoordinate:
        entry.toPackageCoordinate
    }))
  };
  const renames = projectionRenames(
    input.parsed.manifest
  );
  if (!renames.ok) {
    return renames;
  }

  const plan = planLifecycleTarget(
    requirements.value,
    candidate,
    renames.value
  );
  if (!plan.ok) {
    return plan;
  }
  if (!sameProjectionFacts(plan.value, input.parsed.manifest)) {
    return invalid(
      "projection-mismatch",
      input.targetId
    );
  }

  const managedSnapshots = buildManagedSnapshots(
    input.parsed
  );
  if (!managedSnapshots.ok) {
    return managedSnapshots;
  }
  const userPayloads = buildUserPayloads(
    input.parsed
  );
  if (!userPayloads.ok) {
    return userPayloads;
  }

  const detachedPackages = new Set(
    input.parsed.manifest.detached.map(
      (entry) => entry.packageCoordinate
    )
  );
  const currentProjections: TargetOwnedProjection[] =
    plan.value.projections
      .filter((projection) =>
        detachedPackages.has(
          projection.packageCoordinate
        )
      )
      .map((projection) => ({
        projection,
        ownership: "detached" as const,
        materialization: "copy" as const
      }));

  const preflight = preflightTargetOwnership({
    desiredPlan: plan.value,
    currentProjections,
    observedPaths: []
  });
  if (!preflight.ok) {
    return preflight;
  }

  const sources = registrySources(
    input.parsed.manifest
  );
  if (!sources.ok) {
    return sources;
  }

  const projectionByPackage = new Map(
    input.parsed.manifest.projections.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  const planByPackage = new Map(
    plan.value.projections.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );

  const nextState: RegistryTargetStateInput = {
    targetId: input.targetId,
    locations: [
      {
        path: input.targetRoot,
        observedGeneration: null
      }
    ],
    directRequirements:
      input.parsed.manifest.requirements.map(
        copyRequirement
      ),
    resolvedSources: sources.value,
    resolvedPackages:
      input.parsed.manifest.packages.map((entry) => ({
        packageCoordinate: entry.packageCoordinate,
        repositoryCoordinate:
          repositoryFromPackageCoordinate(
            entry.packageCoordinate
          ),
        packageRoot: entry.packageRoot,
        contentDigest: entry.contentDigest
      })),
    dependencyEdges:
      input.parsed.manifest.dependencies.map((entry) => ({
        fromPackage: entry.fromPackageCoordinate,
        toPackage: entry.toPackageCoordinate
      })),
    projections:
      input.parsed.manifest.projections.map((entry) => {
        const planned = planByPackage.get(
          entry.packageCoordinate
        )!;
        const detached = detachedPackages.has(
          entry.packageCoordinate
        );
        return {
          packageCoordinate: entry.packageCoordinate,
          activationName: entry.activationName,
          ownership:
            detached ? "detached" as const : "managed" as const,
          materialization:
            detached
              ? "copy" as const
              : projectionMaterialization(planned),
          transformJson:
            projectionTransformJson(planned)
        };
      }),
    detachedBaselines:
      input.parsed.manifest.detached.map((entry) =>
        entry.sourceKind === "git"
          ? {
              packageCoordinate:
                entry.packageCoordinate,
              repositoryCoordinate:
                repositoryFromPackageCoordinate(
                  entry.packageCoordinate
                ),
              sourceKind: "git" as const,
              requestedRef: entry.requestedRef,
              exactCommit: entry.exactCommit,
              packageRoot: entry.packageRoot,
              contentDigest: entry.contentDigest
            }
          : {
              packageCoordinate:
                entry.packageCoordinate,
              repositoryCoordinate:
                repositoryFromPackageCoordinate(
                  entry.packageCoordinate
                ),
              sourceKind: "github-release" as const,
              version: entry.version,
              actualTag: entry.actualTag,
              exactCommit: entry.exactCommit,
              packageRoot: entry.packageRoot,
              contentDigest: entry.contentDigest
            }
      ),
    dependencyObservations: []
  };

  for (const detached of input.parsed.manifest.detached) {
    const projection = projectionByPackage.get(
      detached.packageCoordinate
    );
    if (
      projection === undefined ||
      projection.activationName !==
        detached.activationName
    ) {
      return invalid(
        "projection-mismatch",
        detached.packageCoordinate
      );
    }
  }

  return {
    ok: true,
    value: {
      manifest: input.parsed.manifest,
      plan: plan.value,
      preflight: preflight.value,
      currentProjections,
      nextState,
      managedSnapshots: managedSnapshots.value,
      userPayloads: userPayloads.value
    }
  };
}

function buildManagedSnapshots(
  parsed: ExactExportPackage
): Result<
  PreparedExactImport["managedSnapshots"],
  InvalidExactImportPackageFacts
> {
  const framesByPayload = new Map<
    string,
    ExactExportPackage["frames"][number][]
  >();
  for (const frame of parsed.frames) {
    const frames =
      framesByPayload.get(frame.payloadId) ?? [];
    frames.push(frame);
    framesByPayload.set(frame.payloadId, frames);
  }

  const byDigest = new Map<
    string,
    PreparedExactImport["managedSnapshots"][number]
  >();

  for (const packageFact of parsed.manifest.packages) {
    const frames =
      framesByPayload.get(packageFact.payloadId) ?? [];
    const snapshot = createPackageSnapshot(
      frames.map((frame) => ({
        path: frame.path,
        executable: frame.executable,
        content: frame.content
      }))
    );
    if (
      !snapshot.ok ||
      snapshot.value.contentDigest !==
        packageFact.contentDigest
    ) {
      return invalid(
        "managed-skill-invalid",
        packageFact.packageCoordinate
      );
    }

    const coordinate = parsePackageCoordinate(
      packageFact.packageCoordinate
    );
    if (!coordinate.ok) {
      return invalid(
        "managed-skill-invalid",
        packageFact.packageCoordinate
      );
    }
    const skill = snapshot.value.entries.find(
      (entry) => entry.path === "SKILL.md"
    );
    if (skill === undefined) {
      return invalid(
        "managed-skill-missing",
        packageFact.packageCoordinate
      );
    }
    let skillMarkdown: string;
    try {
      skillMarkdown = UTF8_DECODER.decode(
        skill.content
      );
    } catch {
      return invalid(
        "managed-skill-invalid-utf8",
        packageFact.packageCoordinate
      );
    }
    const admitted = admitSkillPackage({
      rootBasename: coordinate.value.packageName,
      skillMarkdown
    });
    if (!admitted.ok) {
      return invalid(
        "managed-skill-invalid",
        packageFact.packageCoordinate
      );
    }

    const metadata = snapshot.value.entries.find(
      (entry) => entry.path === "skiloom-package.toml"
    );
    let declaredDependencies: string[] = [];
    if (metadata !== undefined) {
      let metadataText: string;
      try {
        metadataText = UTF8_DECODER.decode(
          metadata.content
        );
      } catch {
        return invalid(
          "managed-skill-invalid",
          packageFact.packageCoordinate
        );
      }
      const parsedMetadata =
        parsePackageMetadata(metadataText);
      if (!parsedMetadata.ok) {
        return invalid(
          "managed-skill-invalid",
          packageFact.packageCoordinate
        );
      }
      declaredDependencies = Object.keys(
        parsedMetadata.value.dependencies
      ).sort(compareUtf8);
    }
    const exactDependencies =
      parsed.manifest.dependencies
        .filter(
          (edge) =>
            edge.fromPackageCoordinate ===
            packageFact.packageCoordinate
        )
        .map((edge) => edge.toPackageCoordinate)
        .sort(compareUtf8);
    if (
      declaredDependencies.length !==
        exactDependencies.length ||
      declaredDependencies.some(
        (coordinateValue, index) =>
          coordinateValue !==
          exactDependencies[index]
      )
    ) {
      return invalid(
        "managed-dependency-mismatch",
        packageFact.packageCoordinate
      );
    }

    if (!byDigest.has(packageFact.contentDigest)) {
      byDigest.set(packageFact.contentDigest, {
        packageCoordinate:
          packageFact.packageCoordinate,
        snapshot: snapshot.value
      });
    }
  }

  return {
    ok: true,
    value: [...byDigest.values()].sort(
      (left, right) =>
        compareUtf8(
          left.packageCoordinate,
          right.packageCoordinate
        )
    )
  };
}

function buildUserPayloads(
  parsed: ExactExportPackage
): Result<
  ReadonlyArray<PreparedImportUserPayload>,
  InvalidExactImportPackageFacts
> {
  const framesByPayload = new Map<
    string,
    ExactExportPackage["frames"][number][]
  >();
  for (const frame of parsed.frames) {
    const frames =
      framesByPayload.get(frame.payloadId) ?? [];
    frames.push(frame);
    framesByPayload.set(frame.payloadId, frames);
  }

  const result: PreparedImportUserPayload[] = [];
  for (const detached of parsed.manifest.detached) {
    result.push({
      kind: "detached",
      packageCoordinate: detached.packageCoordinate,
      activationName: detached.activationName,
      contentDigest: detached.userContentDigest,
      entries: (framesByPayload.get(detached.payloadId) ?? []).map(
        (frame) => ({
          path: frame.path,
          executable: frame.executable,
          content: Uint8Array.from(frame.content)
        })
      )
    });
  }

  for (const userSkill of parsed.manifest.userSkills) {
    const frames =
      framesByPayload.get(userSkill.payloadId) ?? [];
    const skill = frames.find(
      (frame) => frame.path === "SKILL.md"
    );
    if (skill === undefined) {
      return invalid(
        "user-skill-missing",
        userSkill.activationName
      );
    }
    let skillMarkdown: string;
    try {
      skillMarkdown = UTF8_DECODER.decode(
        skill.content
      );
    } catch {
      return invalid(
        "user-skill-invalid-utf8",
        userSkill.activationName
      );
    }
    const admitted = admitSkillPackage({
      rootBasename: userSkill.activationName,
      skillMarkdown
    });
    if (
      !admitted.ok ||
      admitted.value.name !== userSkill.skillName
    ) {
      return invalid(
        "user-skill-invalid",
        userSkill.activationName
      );
    }

    result.push({
      kind: "user-skill",
      packageCoordinate: null,
      activationName: userSkill.activationName,
      contentDigest: userSkill.userContentDigest,
      entries: frames.map((frame) => ({
        path: frame.path,
        executable: frame.executable,
        content: Uint8Array.from(frame.content)
      }))
    });
  }

  result.sort((left, right) =>
    compareUtf8(
      left.activationName,
      right.activationName
    )
  );
  return { ok: true, value: result };
}

function registrySources(
  manifest: ExactExportManifest
): Result<
  ReadonlyArray<RegistryResolvedSource>,
  InvalidExactImportPackageFacts
> {
  const result: RegistryResolvedSource[] = [];
  for (const source of manifest.sources) {
    if (source.sourceKind === "github-release") {
      result.push({
        repositoryCoordinate:
          source.repositoryCoordinate,
        sourceKind: "github-release",
        version: source.version,
        actualTag: source.actualTag,
        exactCommit: source.exactCommit,
        immutable: source.immutable
      });
      continue;
    }

    const refs = new Set(
      manifest.requirements
        .filter(
          (requirement) =>
            requirement.sourceKind === "git" &&
            requirementRepository(requirement) ===
              source.repositoryCoordinate
        )
        .map((requirement) =>
          requirement.sourceKind === "git"
            ? requirement.requestedRef
            : ""
        )
    );
    if (refs.size === 0) {
      return invalid(
        "git-source-without-ref",
        source.repositoryCoordinate
      );
    }
    if (refs.size !== 1) {
      return invalid(
        "git-source-ref-conflict",
        source.repositoryCoordinate
      );
    }
    result.push({
      repositoryCoordinate: source.repositoryCoordinate,
      sourceKind: "git",
      requestedRef: [...refs][0]!,
      exactCommit: source.exactCommit
    });
  }
  return {
    ok: true,
    value: result
  };
}

function projectionRenames(
  manifest: ExactExportManifest
): Result<
  ReadonlyArray<TargetProjectionRename>,
  InvalidExactImportPackageFacts
> {
  const result: TargetProjectionRename[] = [];
  for (const projection of manifest.projections) {
    const coordinate = parsePackageCoordinate(
      projection.packageCoordinate
    );
    if (!coordinate.ok) {
      return invalid(
        "projection-mismatch",
        projection.packageCoordinate
      );
    }
    if (
      coordinate.value.packageName !==
      projection.activationName
    ) {
      result.push({
        packageCoordinate:
          projection.packageCoordinate,
        activationName: projection.activationName
      });
    }
  }
  return { ok: true, value: result };
}

function sameProjectionFacts(
  plan: TargetPlan,
  manifest: ExactExportManifest
): boolean {
  const planned = plan.projections
    .map((entry) => [
      entry.packageCoordinate,
      entry.activationName
    ] as const)
    .sort(compareTuple);
  const recorded = manifest.projections
    .map((entry) => [
      entry.packageCoordinate,
      entry.activationName
    ] as const)
    .sort(compareTuple);
  return (
    planned.length === recorded.length &&
    planned.every(
      (entry, index) =>
        entry[0] === recorded[index]?.[0] &&
        entry[1] === recorded[index]?.[1]
    )
  );
}

function copyRequirement(
  requirement: ExactExportManifest["requirements"][number]
): RegistryDirectRequirement {
  return requirement.sourceKind === "git"
    ? {
        kind: requirement.kind,
        coordinate: requirement.coordinate,
        sourceKind: "git",
        requestedRef: requirement.requestedRef
      }
    : {
        kind: requirement.kind,
        coordinate: requirement.coordinate,
        sourceKind: "github-release",
        versionRequirement:
          requirement.versionRequirement
      };
}

function requirementRepository(
  requirement: ExactExportManifest["requirements"][number]
): string {
  return requirement.kind === "repository"
    ? requirement.coordinate
    : repositoryFromPackageCoordinate(
        requirement.coordinate
      );
}

function invalid(
  reason:
    InvalidExactImportPackageFacts["facts"]["reason"],
  subject: string
): Result<never, InvalidExactImportPackageFacts> {
  return {
    ok: false,
    error: productError(
      "InvalidExactImportPackageFacts",
      { reason, subject }
    )
  };
}

function compareTuple(
  left: readonly [string, string],
  right: readonly [string, string]
): number {
  const first = compareUtf8(left[0], right[0]);
  return first !== 0
    ? first
    : compareUtf8(left[1], right[1]);
}

function compareUtf8(
  left: string,
  right: string
): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
