import { lstat, rm, unlink } from "node:fs/promises";

import {
  productError,
  type Result
} from "../../domain/errors/index.js";
import {
  verifyManagedProjection
} from "./verify.js";
import type {
  ManagedProjectionMaterializationMismatch,
  ManagedProjectionVerificationError,
  RemovedManagedProjection,
  VerifyManagedProjectionInput
} from "./types.js";

export async function removeManagedProjection(
  input: VerifyManagedProjectionInput
): Promise<
  Result<RemovedManagedProjection, ManagedProjectionVerificationError>
> {
  const verified = await verifyManagedProjection(input);
  if (!verified.ok) {
    if (verified.error.code === "ManagedProjectionMissing") {
      return {
        ok: true,
        value: {
          status: "missing",
          activationPath: verified.error.facts.activationPath,
          packageCoordinate: input.expected.projection.packageCoordinate
        }
      };
    }
    return verified;
  }

  let stat;
  try {
    stat = await lstat(verified.value.activationPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        ok: true,
        value: {
          status: "missing",
          activationPath: verified.value.activationPath,
          packageCoordinate: verified.value.packageCoordinate
        }
      };
    }
    throw error;
  }

  const actual = stat.isSymbolicLink()
    ? "link"
    : stat.isDirectory()
      ? "directory"
      : "other";
  const expectedActual =
    verified.value.materialization === "copy" ? "directory" : "link";
  if (actual !== expectedActual) {
    return materializationMismatch(
      input.expected.projection.activationName,
      verified.value.materialization,
      actual
    );
  }

  if (actual === "link") {
    await unlink(verified.value.activationPath);
  } else {
    await rm(verified.value.activationPath, {
      recursive: true,
      force: false
    });
  }

  return {
    ok: true,
    value: {
      status: "removed",
      activationPath: verified.value.activationPath,
      packageCoordinate: verified.value.packageCoordinate
    }
  };
}

function materializationMismatch(
  activationName: string,
  expected: ManagedProjectionMaterializationMismatch["facts"]["expected"],
  actual: ManagedProjectionMaterializationMismatch["facts"]["actual"]
): Result<never, ManagedProjectionMaterializationMismatch> {
  return {
    ok: false,
    error: productError("ManagedProjectionMaterializationMismatch", {
      activationName,
      expected,
      actual
    })
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
