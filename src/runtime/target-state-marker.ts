import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../domain/errors/index.js";
import {
  parseTargetStateMarker,
  writeTargetStateMarker,
  type TargetStateMarkerParseError
} from "../domain/target/state-marker.js";
import type {
  TargetRecoveryMarkerFacts
} from "../domain/target/recovery.js";

export const TARGET_STATE_MARKER_FILENAME = ".skiloom-state";

export type TargetStateMarkerReadFailed = ProductError<
  "TargetStateMarkerReadFailed",
  Readonly<{
    path: string;
  }>
>;

export type TargetStateMarkerWriteFailed = ProductError<
  "TargetStateMarkerWriteFailed",
  Readonly<{
    path: string;
  }>
>;

export type ReadTargetStateMarkerFileError =
  | TargetStateMarkerParseError
  | TargetStateMarkerReadFailed;

export async function readTargetStateMarkerFile(
  targetRoot: string
): Promise<
  Result<
    TargetRecoveryMarkerFacts | null,
    ReadTargetStateMarkerFileError
  >
> {
  const markerPath = join(
    resolve(targetRoot),
    TARGET_STATE_MARKER_FILENAME
  );
  let source: string;
  try {
    source = await readFile(markerPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ok: true, value: null };
    }
    return {
      ok: false,
      error: productError("TargetStateMarkerReadFailed", {
        path: markerPath
      })
    };
  }
  return parseTargetStateMarker(source);
}

export async function writeTargetStateMarkerFile(
  targetRoot: string,
  facts: TargetRecoveryMarkerFacts
): Promise<Result<void, TargetStateMarkerWriteFailed>> {
  const root = resolve(targetRoot);
  const markerPath = join(root, TARGET_STATE_MARKER_FILENAME);
  const temporaryPath = join(
    root,
    `${TARGET_STATE_MARKER_FILENAME}.tmp-${process.pid}-${randomUUID()}`
  );
  const source = writeTargetStateMarker(facts);

  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, markerPath);
    await syncDirectoryBestEffort(root);
    return { ok: true, value: undefined };
  } catch {
    try {
      await handle?.close();
    } catch {
      // Preserve the public write failure below.
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    return {
      ok: false,
      error: productError("TargetStateMarkerWriteFailed", {
        path: markerPath
      })
    };
  }
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Some supported platforms/filesystems do not expose directory fsync.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
