import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import {
  writeExactExportPackage,
  type ExactExportManifest,
  type ExactExportParseError
} from "../../domain/export-package/index.js";
import type {
  RegistryTargetState
} from "../registry/index.js";
import {
  writeExactExportFile,
  type ExactExportFileWriteError
} from "./file.js";
import {
  prepareManagedExactExport,
  type ExactExportTargetNotFound,
  type ExactExportTargetNotReconciled,
  type PrepareManagedExactExportError,
  type PrepareManagedExactExportInput
} from "./managed.js";

export type {
  ExactExportTargetNotFound,
  ExactExportTargetNotReconciled
} from "./managed.js";

export type ExactExportWarning = ProductError<
  "DetachedOverrideBytesOmitted",
  Readonly<{
    packageCoordinate: string;
    activationName: string;
  }>
>;

export type ExportManagedDependenciesError =
  | PrepareManagedExactExportError
  | ExactExportParseError
  | ExactExportFileWriteError;

export type ExportManagedDependenciesResult = Readonly<{
  destinationPath: string;
  manifest: ExactExportManifest;
  warnings: ReadonlyArray<ExactExportWarning>;
}>;

export async function exportManagedDependencies(
  input: PrepareManagedExactExportInput &
    Readonly<{ destinationPath: string }>
): Promise<
  Result<
    ExportManagedDependenciesResult,
    ExportManagedDependenciesError
  >
> {
  const prepared = await prepareManagedExactExport(input);
  if (!prepared.ok) {
    return prepared;
  }

  const encoded = writeExactExportPackage({
    manifest: prepared.value.manifest,
    frames: prepared.value.frames
  });
  if (!encoded.ok) {
    return encoded;
  }

  const written = await writeExactExportFile({
    destinationPath: input.destinationPath,
    bytes: encoded.value,
    lock: input.lock
  });
  if (!written.ok) {
    return written;
  }

  return {
    ok: true,
    value: {
      destinationPath: written.value,
      manifest: prepared.value.manifest,
      warnings: detachedWarnings(prepared.value.state)
    }
  };
}

function detachedWarnings(
  state: RegistryTargetState
): ReadonlyArray<ExactExportWarning> {
  const projectionByPackage = new Map(
    state.projections.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  return [...state.detachedBaselines]
    .sort((left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
    )
    .map((baseline) =>
      productError("DetachedOverrideBytesOmitted", {
        packageCoordinate: baseline.packageCoordinate,
        activationName:
          projectionByPackage.get(
            baseline.packageCoordinate
          )?.activationName ?? ""
      })
    );
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
