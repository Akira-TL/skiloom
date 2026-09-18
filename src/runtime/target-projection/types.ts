import type { ProductError } from "../../domain/errors/index.js";
import type { TargetProjection } from "../../domain/target/index.js";
import type { PackageStoreError } from "../store.js";
import type { SkiloomHomePaths } from "../home.js";

export type ManagedProjectionMaterialization = "symlink" | "junction" | "copy";
export type ManagedProjectionMaterializationRequest =
  | "auto"
  | ManagedProjectionMaterialization;

export type ManagedProjectionExpectation = Readonly<{
  projection: TargetProjection;
  materialization: ManagedProjectionMaterialization;
}>;

export type MaterializeManagedProjectionInput = Readonly<{
  home: SkiloomHomePaths;
  targetRoot: string;
  projection: TargetProjection;
  materialization?: ManagedProjectionMaterializationRequest;
  current?: ManagedProjectionExpectation;
}>;

export type VerifyManagedProjectionInput = Readonly<{
  home: SkiloomHomePaths;
  targetRoot: string;
  expected: ManagedProjectionExpectation;
}>;

export type MaterializedManagedProjection = Readonly<{
  status: "created" | "replaced";
  activationPath: string;
  materialization: ManagedProjectionMaterialization;
  storePayloadPath: string;
  packageCoordinate: string;
  contentDigest: string;
}>;

export type VerifiedManagedProjection = Readonly<{
  activationPath: string;
  materialization: ManagedProjectionMaterialization;
  storePayloadPath: string;
  packageCoordinate: string;
  contentDigest: string;
}>;

export type ManagedProjectionTreeEntry = Readonly<{
  path: string;
  executable: boolean;
  content: Uint8Array;
}>;

export type ManagedProjectionTree = Readonly<{
  entries: ReadonlyArray<ManagedProjectionTreeEntry>;
}>;

export type InvalidManagedProjectionInputReason =
  | "target-root-not-absolute"
  | "target-root-not-directory"
  | "invalid-package-coordinate"
  | "invalid-activation-name"
  | "projection-kind-transform-mismatch"
  | "activation-name-transform-mismatch"
  | "snapshot-digest-mismatch"
  | "current-activation-mismatch"
  | "transformed-copy-requires-copy";

export type InvalidManagedProjectionInput = ProductError<
  "InvalidManagedProjectionInput",
  Readonly<{
    reason: InvalidManagedProjectionInputReason;
    subject: string;
  }>
>;

export type UnsupportedManagedTransformReason =
  | "source-skill-not-admitted"
  | "missing-skill-markdown"
  | "invalid-skill-utf8"
  | "frontmatter-range-unavailable"
  | "source-name-mismatch"
  | "transformed-skill-invalid"
  | "invalid-routing-dependency"
  | "duplicate-routing-dependency"
  | "invalid-routing-activation";

export type UnsupportedManagedTransform = ProductError<
  "UnsupportedManagedTransform",
  Readonly<{
    packageCoordinate: string;
    reason: UnsupportedManagedTransformReason;
  }>
>;

export type ManagedTransformMarkerConflict = ProductError<
  "ManagedTransformMarkerConflict",
  Readonly<{
    packageCoordinate: string;
    marker: "begin" | "end";
  }>
>;

export type ManagedProjectionMaterializationUnsupported = ProductError<
  "ManagedProjectionMaterializationUnsupported",
  Readonly<{
    requested: ManagedProjectionMaterialization;
    platform: NodeJS.Platform;
  }>
>;

export type TargetPathOccupied = ProductError<
  "TargetPathOccupied",
  Readonly<{
    activationName: string;
    activationPath: string;
  }>
>;

export type ManagedProjectionMissing = ProductError<
  "ManagedProjectionMissing",
  Readonly<{
    activationName: string;
    activationPath: string;
  }>
>;

export type ManagedProjectionMaterializationMismatch = ProductError<
  "ManagedProjectionMaterializationMismatch",
  Readonly<{
    activationName: string;
    expected: ManagedProjectionMaterialization;
    actual: "link" | "directory" | "other";
  }>
>;

export type ManagedProjectionWrongLink = ProductError<
  "ManagedProjectionWrongLink",
  Readonly<{
    activationName: string;
    expectedTarget: string;
    actualTarget: string;
  }>
>;

export type ManagedProjectionMissingEntry = ProductError<
  "ManagedProjectionMissingEntry",
  Readonly<{
    activationName: string;
    path: string;
  }>
>;

export type ManagedProjectionUnexpectedEntry = ProductError<
  "ManagedProjectionUnexpectedEntry",
  Readonly<{
    activationName: string;
    path: string;
  }>
>;

export type ManagedProjectionContentMismatch = ProductError<
  "ManagedProjectionContentMismatch",
  Readonly<{
    activationName: string;
    path: string;
  }>
>;

export type ManagedProjectionExecutableMismatch = ProductError<
  "ManagedProjectionExecutableMismatch",
  Readonly<{
    activationName: string;
    path: string;
  }>
>;

export type ManagedProjectionUnsupportedEntry = ProductError<
  "ManagedProjectionUnsupportedEntry",
  Readonly<{
    activationName: string;
    path: string;
    entryType: "symlink" | "file" | "special";
  }>
>;

export type ManagedTransformError =
  | InvalidManagedProjectionInput
  | UnsupportedManagedTransform
  | ManagedTransformMarkerConflict;

export type ManagedProjectionVerificationError =
  | InvalidManagedProjectionInput
  | ManagedTransformError
  | ManagedProjectionMissing
  | ManagedProjectionMaterializationMismatch
  | ManagedProjectionWrongLink
  | ManagedProjectionMissingEntry
  | ManagedProjectionUnexpectedEntry
  | ManagedProjectionContentMismatch
  | ManagedProjectionExecutableMismatch
  | ManagedProjectionUnsupportedEntry
  | PackageStoreError;

export type ManagedProjectionRuntimeError =
  | ManagedProjectionVerificationError
  | ManagedProjectionMaterializationUnsupported
  | TargetPathOccupied;
