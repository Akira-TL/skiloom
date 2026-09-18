import { createHash } from "node:crypto";
import { TextEncoder } from "node:util";

import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";
import {
  createPackageSnapshot,
  type PackageSnapshotError
} from "../snapshot/index.js";

const FORMAT_HEADER = Buffer.from(
  "SKILOOM-USER-PAYLOAD-V1\0",
  "ascii"
);
const UTF8_ENCODER = new TextEncoder();

export type UserPayloadContentEntry = Readonly<{
  path: string;
  executable: boolean;
  content: Uint8Array;
}>;

export type UserPayloadEntry = Readonly<{
  path: string;
  executable: boolean;
  content: Uint8Array;
  fileDigest: string;
}>;

export type UserPayload = Readonly<{
  entries: ReadonlyArray<UserPayloadEntry>;
  contentDigest: string;
  payloadId: string;
}>;

export type InvalidUserPayload = ProductError<
  "InvalidUserPayload",
  Readonly<{
    path: string;
    reason:
      | "invalid-path"
      | "casefold-collision";
  }>
>;

export type UserPayloadDigestMismatch = ProductError<
  "UserPayloadDigestMismatch",
  Readonly<{
    expected: string;
    actual: string;
  }>
>;

export type UserPayloadError =
  | InvalidUserPayload
  | UserPayloadDigestMismatch;

export function createUserPayload(
  entries: ReadonlyArray<UserPayloadContentEntry>
): Result<UserPayload, InvalidUserPayload> {
  const validated = createPackageSnapshot(entries);
  if (!validated.ok) {
    return invalidFromPackageSnapshot(validated.error);
  }

  const canonicalEntries: UserPayloadEntry[] = validated.value.entries.map(
    (entry) => ({
      path: entry.path,
      executable: entry.executable,
      content: Uint8Array.from(entry.content),
      fileDigest: entry.fileDigest
    })
  );
  const contentDigest = digestUserPayload(canonicalEntries);
  return {
    ok: true,
    value: {
      entries: canonicalEntries,
      contentDigest,
      payloadId: `user:${contentDigest}`
    }
  };
}

export function verifyUserPayload(
  expectedDigest: string,
  entries: ReadonlyArray<UserPayloadContentEntry>
): Result<UserPayload, UserPayloadError> {
  const payload = createUserPayload(entries);
  if (!payload.ok) {
    return payload;
  }
  if (payload.value.contentDigest !== expectedDigest) {
    return {
      ok: false,
      error: productError("UserPayloadDigestMismatch", {
        expected: expectedDigest,
        actual: payload.value.contentDigest
      })
    };
  }
  return payload;
}

function digestUserPayload(
  entries: ReadonlyArray<UserPayloadEntry>
): string {
  const hash = createHash("sha256");
  hash.update(FORMAT_HEADER);
  hash.update(uint64be(entries.length));

  for (const entry of entries) {
    const pathBytes = UTF8_ENCODER.encode(entry.path);
    const digestBytes = Buffer.from(
      entry.fileDigest.slice("sha256:".length),
      "hex"
    );
    hash.update(Uint8Array.of(0x01));
    hash.update(uint64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(
      Uint8Array.of(entry.executable ? 0x01 : 0x00)
    );
    hash.update(uint64be(entry.content.length));
    hash.update(digestBytes);
  }

  return `sha256:${hash.digest("hex")}`;
}

function invalidFromPackageSnapshot(
  error: PackageSnapshotError
): Result<never, InvalidUserPayload> {
  if (error.code === "PackagePathCollision") {
    return {
      ok: false,
      error: productError("InvalidUserPayload", {
        path: error.facts.paths.join(" | "),
        reason: "casefold-collision"
      })
    };
  }
  return {
    ok: false,
    error: productError("InvalidUserPayload", {
      path:
        error.code === "InvalidPackagePath"
          ? error.facts.pathHex
          : error.facts.path,
      reason: "invalid-path"
    })
  };
}

function uint64be(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}
