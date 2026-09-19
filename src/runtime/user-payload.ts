import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  productError,
  type ProductError,
  type Result
} from "../domain/errors/index.js";
import {
  createUserPayload,
  verifyUserPayload,
  type UserPayload,
  type UserPayloadContentEntry,
  type UserPayloadError
} from "../domain/user-payload/index.js";
import type {
  OperationLockLost
} from "../native/skiloom-lock.js";

const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true
});

export type UnsupportedUserPayloadEntry = ProductError<
  "UnsupportedUserPayloadEntry",
  Readonly<{
    path: string;
    fileType:
      | "symlink"
      | "fifo"
      | "socket"
      | "device"
      | "other";
  }>
>;

export type UserPayloadScanFailed = ProductError<
  "UserPayloadScanFailed",
  Readonly<{
    path: string;
    reason: "missing-root" | "not-directory" | "invalid-utf8-name" | "io";
  }>
>;

export type UserPayloadDestinationExists = ProductError<
  "UserPayloadDestinationExists",
  Readonly<{ path: string }>
>;

export type UserPayloadMaterializationFailed = ProductError<
  "UserPayloadMaterializationFailed",
  Readonly<{ path: string }>
>;

export type ScanUserPayloadError =
  | UserPayloadScanFailed
  | UnsupportedUserPayloadEntry
  | Extract<UserPayloadError, { code: "InvalidUserPayload" }>;

export type MaterializeUserPayloadError =
  | UserPayloadError
  | UserPayloadDestinationExists
  | UserPayloadMaterializationFailed
  | OperationLockLost;

export async function scanUserPayloadTree(
  root: string
): Promise<Result<UserPayload, ScanUserPayloadError>> {
  const absoluteRoot = resolve(root);
  let rootStat;
  try {
    rootStat = await lstat(absoluteRoot);
  } catch (error) {
    return {
      ok: false,
      error: productError("UserPayloadScanFailed", {
        path: ".",
        reason:
          isNodeError(error) && error.code === "ENOENT"
            ? "missing-root"
            : "io"
      })
    };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return {
      ok: false,
      error: productError("UserPayloadScanFailed", {
        path: ".",
        reason: "not-directory"
      })
    };
  }

  const entries: UserPayloadContentEntry[] = [];
  const scanned = await scanDirectory(
    absoluteRoot,
    [],
    entries
  );
  if (!scanned.ok) {
    return scanned;
  }
  return createUserPayload(entries);
}

export async function materializeVerifiedUserPayloadTree(
  input: Readonly<{
    destinationRoot: string;
    expectedDigest: string;
    entries: ReadonlyArray<UserPayloadContentEntry>;
    checkMutationCapability?: () => Result<void, OperationLockLost>;
  }>
): Promise<
  Result<UserPayload, MaterializeUserPayloadError>
> {
  const verified = verifyUserPayload(
    input.expectedDigest,
    input.entries
  );
  if (!verified.ok) {
    return verified;
  }

  const destinationRoot = resolve(input.destinationRoot);
  if (await pathExists(destinationRoot)) {
    return {
      ok: false,
      error: productError("UserPayloadDestinationExists", {
        path: destinationRoot
      })
    };
  }

  const parent = dirname(destinationRoot);
  const stagingRoot = join(
    parent,
    `.skiloom-user-payload-${process.pid}-${randomUUID()}`
  );
  let stagingCreated = false;

  try {
    const beforeStaging = checkMutationCapability(input);
    if (!beforeStaging.ok) {
      return beforeStaging;
    }
    await mkdir(stagingRoot, {
      recursive: false,
      mode: 0o700
    });
    stagingCreated = true;

    for (const entry of verified.value.entries) {
      const beforeEntry = checkMutationCapability(input);
      if (!beforeEntry.ok) {
        return beforeEntry;
      }
      const destination = join(
        stagingRoot,
        ...entry.path.split("/")
      );
      await mkdir(dirname(destination), {
        recursive: true,
        mode: 0o700
      });
      const handle = await open(
        destination,
        "wx",
        entry.executable ? 0o755 : 0o644
      );
      try {
        await handle.writeFile(entry.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.platform !== "win32") {
        await chmod(
          destination,
          entry.executable ? 0o755 : 0o644
        );
      }
    }

    const beforePublish = checkMutationCapability(input);
    if (!beforePublish.ok) {
      return beforePublish;
    }
    if (await pathExists(destinationRoot)) {
      return {
        ok: false,
        error: productError(
          "UserPayloadDestinationExists",
          { path: destinationRoot }
        )
      };
    }
    await rename(stagingRoot, destinationRoot);
    stagingCreated = false;
    const afterPublish = checkMutationCapability(input);
    return afterPublish.ok
      ? verified
      : afterPublish;
  } catch {
    return {
      ok: false,
      error: productError(
        "UserPayloadMaterializationFailed",
        { path: destinationRoot }
      )
    };
  } finally {
    if (stagingCreated) {
      await rm(stagingRoot, {
        recursive: true,
        force: true
      }).catch(() => {});
    }
  }
}

function checkMutationCapability(
  input: Readonly<{
    checkMutationCapability?: () => Result<void, OperationLockLost>;
  }>
): Result<void, OperationLockLost> {
  return input.checkMutationCapability?.() ?? {
    ok: true,
    value: undefined
  };
}

async function scanDirectory(
  directory: string,
  relativeSegments: ReadonlyArray<string>,
  output: UserPayloadContentEntry[]
): Promise<
  Result<void, UserPayloadScanFailed | UnsupportedUserPayloadEntry>
> {
  let entries;
  try {
    entries = await readdir(directory, {
      withFileTypes: true,
      encoding: "buffer"
    });
  } catch {
    return scanFailed(relativeSegments, "io");
  }

  entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.name),
      Buffer.from(right.name)
    )
  );

  for (const entry of entries) {
    let name: string;
    try {
      name = UTF8_DECODER.decode(
        Buffer.from(entry.name)
      );
    } catch {
      return scanFailed(
        [...relativeSegments, "<invalid-utf8>"],
        "invalid-utf8-name"
      );
    }

    const segments = [...relativeSegments, name];
    const relativePath = segments.join("/");
    const absolutePath = join(directory, name);
    let stat;
    try {
      stat = await lstat(absolutePath);
    } catch {
      return scanFailed(segments, "io");
    }

    if (stat.isSymbolicLink()) {
      return unsupported(relativePath, "symlink");
    }
    if (stat.isDirectory()) {
      const nested = await scanDirectory(
        absolutePath,
        segments,
        output
      );
      if (!nested.ok) {
        return nested;
      }
      continue;
    }
    if (!stat.isFile()) {
      return unsupported(
        relativePath,
        fileTypeFor(stat)
      );
    }

    let content: Uint8Array;
    let handle;
    try {
      handle = await open(
        absolutePath,
        process.platform === "win32"
          ? fsConstants.O_RDONLY
          : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      );
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== stat.dev ||
        openedStat.ino !== stat.ino
      ) {
        return scanFailed(segments, "io");
      }
      content = Uint8Array.from(await handle.readFile());
    } catch {
      return scanFailed(segments, "io");
    } finally {
      await handle?.close().catch(() => {});
    }
    output.push({
      path: relativePath,
      executable:
        process.platform === "win32"
          ? false
          : (stat.mode & 0o111) !== 0,
      content
    });
  }

  return { ok: true, value: undefined };
}

function fileTypeFor(
  stat: Awaited<ReturnType<typeof lstat>>
): UnsupportedUserPayloadEntry["facts"]["fileType"] {
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  if (stat.isBlockDevice() || stat.isCharacterDevice()) {
    return "device";
  }
  return "other";
}

function unsupported(
  path: string,
  fileType: UnsupportedUserPayloadEntry["facts"]["fileType"]
): Result<never, UnsupportedUserPayloadEntry> {
  return {
    ok: false,
    error: productError("UnsupportedUserPayloadEntry", {
      path,
      fileType
    })
  };
}

function scanFailed(
  segments: ReadonlyArray<string>,
  reason: UserPayloadScanFailed["facts"]["reason"]
): Result<never, UserPayloadScanFailed> {
  return {
    ok: false,
    error: productError("UserPayloadScanFailed", {
      path: segments.length === 0 ? "." : segments.join("/"),
      reason
    })
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(
  error: unknown
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
