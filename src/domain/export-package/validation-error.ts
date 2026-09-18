import {
  productError,
  type Result
} from "../errors/index.js";
import type {
  InvalidExportPackage,
  InvalidExportPackageReason
} from "./types.js";

export function invalidExportPackage(
  reason: InvalidExportPackageReason,
  path: string
): Result<never, InvalidExportPackage> {
  return {
    ok: false,
    error: productError("InvalidExportPackage", {
      reason,
      path
    })
  };
}
