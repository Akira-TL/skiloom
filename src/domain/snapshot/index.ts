import { createHash } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

import { caseFold } from "unicode-case-folding";

import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";

export type RepositorySnapshotFileType =
  | "regular"
  | "symlink"
  | "hardlink"
  | "fifo"
  | "device"
  | "socket"
  | "other";

export type RepositorySnapshotEntry =
  | Readonly<{
      pathBytes: Uint8Array;
      fileType: "regular";
      gitMode: "100644" | "100755";
      content: Uint8Array;
    }>
  | Readonly<{
      pathBytes: Uint8Array;
      fileType: Exclude<RepositorySnapshotFileType, "regular">;
    }>;

export type PackageSnapshotEntry = Readonly<{
  path: string;
  executable: boolean;
  content: Uint8Array;
  fileDigest: string;
}>;

export type PackageSnapshot = Readonly<{
  entries: ReadonlyArray<PackageSnapshotEntry>;
  contentDigest: string;
}>;

export type PackageSnapshotInput = Readonly<{
  packageRoot: string;
  discoveredPackageRoots: ReadonlyArray<string>;
  entries: ReadonlyArray<RepositorySnapshotEntry>;
}>;

export type InvalidPackagePathReason =
  | "invalid-utf8"
  | "empty"
  | "absolute-path"
  | "nul"
  | "empty-segment"
  | "dot-segment"
  | "parent-segment";

export type PackageSnapshotError =
  | ProductError<
      "UnsupportedPackageFileType",
      Readonly<{
        path: string;
        fileType: Exclude<RepositorySnapshotFileType, "regular">;
      }>
    >
  | ProductError<
      "InvalidPackagePath",
      Readonly<{
        pathHex: string;
        reason: InvalidPackagePathReason;
      }>
    >
  | ProductError<
      "PackagePathCollision",
      Readonly<{
        caseFoldedPath: string;
        paths: ReadonlyArray<string>;
      }>
    >;

type SelectedEntry = Readonly<{
  entry: RepositorySnapshotEntry;
  relativePathBytes: Uint8Array;
}>;

type PreparedEntry = Readonly<{
  path: string;
  pathBytes: Uint8Array;
  executable: boolean;
  content: Uint8Array;
  fileDigest: string;
  fileDigestBytes: Uint8Array;
}>;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const FORMAT_HEADER = Buffer.from("SKILOOM-PACKAGE-V1\0", "ascii");

export function buildPackageSnapshot(
  input: PackageSnapshotInput
): Result<PackageSnapshot, PackageSnapshotError> {
  const packagePrefix = packageRootPrefix(input.packageRoot);
  const nestedPrefixes = input.discoveredPackageRoots
    .filter((root) => isStrictNestedRoot(root, input.packageRoot))
    .map(packageRootPrefix);

  const selected: SelectedEntry[] = [];
  for (const entry of input.entries) {
    const relativePathBytes = stripPackagePrefix(entry.pathBytes, packagePrefix);
    if (relativePathBytes === undefined) {
      continue;
    }
    if (
      nestedPrefixes.some((prefix) =>
        startsWithBytes(entry.pathBytes, prefix)
      )
    ) {
      continue;
    }
    selected.push({ entry, relativePathBytes });
  }

  selected.sort((left, right) =>
    compareBytes(left.relativePathBytes, right.relativePathBytes)
  );

  const prepared: PreparedEntry[] = [];
  for (const selectedEntry of selected) {
    const pathResult = validatePackagePath(selectedEntry.relativePathBytes);
    if (!pathResult.ok) {
      return pathResult;
    }

    if (selectedEntry.entry.fileType !== "regular") {
      return {
        ok: false,
        error: productError("UnsupportedPackageFileType", {
          path: pathResult.value,
          fileType: selectedEntry.entry.fileType
        })
      };
    }

    const content = Uint8Array.from(selectedEntry.entry.content);
    const fileDigestBytes = sha256(content);
    prepared.push({
      path: pathResult.value,
      pathBytes: Uint8Array.from(selectedEntry.relativePathBytes),
      executable: selectedEntry.entry.gitMode === "100755",
      content,
      fileDigest: `sha256:${hex(fileDigestBytes)}`,
      fileDigestBytes
    });
  }

  const collision = firstPathCollision(prepared);
  if (collision !== undefined) {
    return {
      ok: false,
      error: productError("PackagePathCollision", collision)
    };
  }

  const contentDigest = digestSnapshot(prepared);
  return {
    ok: true,
    value: {
      entries: prepared.map((entry) => ({
        path: entry.path,
        executable: entry.executable,
        content: entry.content,
        fileDigest: entry.fileDigest
      })),
      contentDigest
    }
  };
}

function packageRootPrefix(packageRoot: string): Uint8Array {
  if (packageRoot === ".") {
    return new Uint8Array();
  }
  return UTF8_ENCODER.encode(`${packageRoot}/`);
}

function isStrictNestedRoot(candidate: string, packageRoot: string): boolean {
  if (candidate === packageRoot) {
    return false;
  }
  if (packageRoot === ".") {
    return candidate !== ".";
  }
  return candidate.startsWith(`${packageRoot}/`);
}

function stripPackagePrefix(
  repositoryPathBytes: Uint8Array,
  packagePrefix: Uint8Array
): Uint8Array | undefined {
  if (packagePrefix.length === 0) {
    return repositoryPathBytes;
  }
  if (!startsWithBytes(repositoryPathBytes, packagePrefix)) {
    return undefined;
  }
  return repositoryPathBytes.subarray(packagePrefix.length);
}

function validatePackagePath(
  pathBytes: Uint8Array
): Result<string, Extract<PackageSnapshotError, { code: "InvalidPackagePath" }>> {
  const pathHex = hex(pathBytes);
  if (pathBytes.length === 0) {
    return invalidPackagePath(pathHex, "empty");
  }

  let path: string;
  try {
    path = UTF8_DECODER.decode(pathBytes);
  } catch {
    return invalidPackagePath(pathHex, "invalid-utf8");
  }

  if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path)) {
    return invalidPackagePath(pathHex, "absolute-path");
  }
  if (path.includes("\0")) {
    return invalidPackagePath(pathHex, "nul");
  }

  const segments = path.split("/");
  if (segments.includes("")) {
    return invalidPackagePath(pathHex, "empty-segment");
  }
  if (segments.includes(".")) {
    return invalidPackagePath(pathHex, "dot-segment");
  }
  if (segments.includes("..")) {
    return invalidPackagePath(pathHex, "parent-segment");
  }

  return { ok: true, value: path };
}

function invalidPackagePath(
  pathHex: string,
  reason: InvalidPackagePathReason
): Result<never, Extract<PackageSnapshotError, { code: "InvalidPackagePath" }>> {
  return {
    ok: false,
    error: productError("InvalidPackagePath", { pathHex, reason })
  };
}

function firstPathCollision(
  entries: ReadonlyArray<PreparedEntry>
): Readonly<{
  caseFoldedPath: string;
  paths: ReadonlyArray<string>;
}> | undefined {
  const claims = new Map<
    string,
    Readonly<{
      originalPath: string;
      ownerPath: string;
      kind: "directory" | "file";
    }>
  >();

  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const originalPath = segments.slice(0, length).join("/");
      const caseFoldedPath = caseFold(originalPath);
      const kind = length === segments.length ? "file" : "directory";
      const prior = claims.get(caseFoldedPath);
      if (
        prior !== undefined &&
        (prior.originalPath !== originalPath || prior.kind !== kind)
      ) {
        return {
          caseFoldedPath,
          paths: [prior.ownerPath, entry.path]
        };
      }
      if (prior === undefined) {
        claims.set(caseFoldedPath, {
          originalPath,
          ownerPath: entry.path,
          kind
        });
      }
    }
  }

  return undefined;
}

function digestSnapshot(entries: ReadonlyArray<PreparedEntry>): string {
  const hash = createHash("sha256");
  hash.update(FORMAT_HEADER);
  hash.update(uint64(entries.length));

  for (const entry of entries) {
    hash.update(Uint8Array.of(0x01));
    hash.update(uint64(entry.pathBytes.length));
    hash.update(entry.pathBytes);
    hash.update(Uint8Array.of(entry.executable ? 0x01 : 0x00));
    hash.update(uint64(entry.content.length));
    hash.update(entry.fileDigestBytes);
  }

  return `sha256:${hash.digest("hex")}`;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

function uint64(value: number): Uint8Array {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > value.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (value[index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
