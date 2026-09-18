import { randomUUID } from "node:crypto";
import {
  link,
  open,
  rm
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../native/skiloom-lock.js";

export type ExactExportDestinationExists = ProductError<
  "ExactExportDestinationExists",
  Readonly<{ path: string }>
>;

export type ExactExportWriteFailed = ProductError<
  "ExactExportWriteFailed",
  Readonly<{ path: string }>
>;

export type ExactExportFileWriteError =
  | OperationLockLost
  | ExactExportDestinationExists
  | ExactExportWriteFailed;

export async function writeExactExportFile(
  input: Readonly<{
    destinationPath: string;
    bytes: Uint8Array;
    lock: OperationLockSession;
  }>
): Promise<Result<string, ExactExportFileWriteError>> {
  const destinationPath = resolve(input.destinationPath);
  const parent = dirname(destinationPath);
  const temporaryPath = join(
    parent,
    `.${basename(destinationPath)}.tmp-${process.pid}-${randomUUID()}`
  );
  let handle;
  let linked = false;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(input.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }

    try {
      await link(temporaryPath, destinationPath);
      linked = true;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return {
          ok: false,
          error: productError(
            "ExactExportDestinationExists",
            { path: destinationPath }
          )
        };
      }
      return {
        ok: false,
        error: productError("ExactExportWriteFailed", {
          path: destinationPath
        })
      };
    }

    await syncDirectoryBestEffort(parent);
    return { ok: true, value: destinationPath };
  } catch {
    return {
      ok: false,
      error: productError("ExactExportWriteFailed", {
        path: destinationPath
      })
    };
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    void linked;
  }
}

async function syncDirectoryBestEffort(
  path: string
): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not exposed on every supported filesystem.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isNodeError(
  error: unknown
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
