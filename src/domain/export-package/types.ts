import type { ProductError } from "../errors/index.js";
import type {
  TargetRecoveryDetachedBaseline,
  TargetRecoveryRequirement
} from "../target/recovery.js";

export type ExactExportMode = "dependencies" | "full";

export type ExactExportSource =
  | Readonly<{
      repositoryCoordinate: string;
      sourceKind: "github-release";
      version: string;
      actualTag: string;
      exactCommit: string;
      immutable: boolean | null;
    }>
  | Readonly<{
      repositoryCoordinate: string;
      sourceKind: "git";
      exactCommit: string;
    }>;

export type ExactExportManagedPackage = Readonly<{
  packageCoordinate: string;
  packageRoot: string;
  contentDigest: string;
  payloadId: string;
}>;

export type ExactExportDependency = Readonly<{
  fromPackageCoordinate: string;
  toPackageCoordinate: string;
}>;

export type ExactExportProjection = Readonly<{
  packageCoordinate: string;
  activationName: string;
}>;

export type ExactExportDetached = TargetRecoveryDetachedBaseline &
  Readonly<{
    activationName: string;
    payloadId: string;
    userContentDigest: string;
  }>;

export type ExactExportUserSkill = Readonly<{
  activationName: string;
  skillName: string;
  payloadId: string;
  userContentDigest: string;
}>;

export type ExactExportManifest = Readonly<{
  format: "SKILOOM-EXPORT-V1";
  mode: ExactExportMode;
  requirements: ReadonlyArray<TargetRecoveryRequirement>;
  sources: ReadonlyArray<ExactExportSource>;
  packages: ReadonlyArray<ExactExportManagedPackage>;
  dependencies: ReadonlyArray<ExactExportDependency>;
  projections: ReadonlyArray<ExactExportProjection>;
  detached: ReadonlyArray<ExactExportDetached>;
  userSkills: ReadonlyArray<ExactExportUserSkill>;
}>;

export type ExactExportFileFrame = Readonly<{
  payloadId: string;
  path: string;
  executable: boolean;
  content: Uint8Array;
}>;

export type ExactExportPackage = Readonly<{
  manifest: ExactExportManifest;
  frames: ReadonlyArray<ExactExportFileFrame>;
}>;

export type InvalidExportPackageReason =
  | "invalid-toml"
  | "invalid-magic"
  | "missing-field"
  | "unknown-field"
  | "invalid-field"
  | "duplicate-requirement"
  | "duplicate-source"
  | "duplicate-package"
  | "duplicate-dependency"
  | "duplicate-projection"
  | "duplicate-detached"
  | "duplicate-user-skill"
  | "dangling-reference"
  | "source-conflict"
  | "requirement-mismatch"
  | "projection-missing"
  | "activation-conflict"
  | "payload-id-mismatch"
  | "mode-conflict"
  | "truncated"
  | "length-out-of-range"
  | "invalid-utf8"
  | "invalid-executable"
  | "duplicate-frame"
  | "undeclared-payload"
  | "missing-payload"
  | "invalid-payload-path"
  | "managed-content-digest-mismatch";

export type InvalidExportPackage = ProductError<
  "InvalidExportPackage",
  Readonly<{
    reason: InvalidExportPackageReason;
    path: string;
  }>
>;

export type UnsupportedExportVersion = ProductError<
  "UnsupportedExportVersion",
  Readonly<{ format: string }>
>;

export type ExactExportParseError =
  | InvalidExportPackage
  | UnsupportedExportVersion;
