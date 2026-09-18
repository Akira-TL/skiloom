import { TextDecoder, TextEncoder } from "node:util";

import {
  productError,
  type Result
} from "../errors/index.js";
import { createPackageSnapshot } from "../snapshot/index.js";
import { verifyUserPayload } from "../user-payload/index.js";
import {
  parseExactExportManifest,
  writeExactExportManifest
} from "./manifest.js";
import type {
  ExactExportFileFrame,
  ExactExportPackage,
  ExactExportParseError,
  InvalidExportPackage,
  InvalidExportPackageReason
} from "./types.js";

const MAGIC = Buffer.from("SKILOOM-EXPORT-V1\0", "ascii");
const FUTURE_MAGIC_PATTERN = /^SKILOOM-EXPORT-V[0-9]+$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

export function parseExactExportPackage(
  input: Uint8Array
): Result<ExactExportPackage, ExactExportParseError> {
  const bytes = Buffer.from(input);
  if (!startsWith(bytes, MAGIC)) {
    const future = recognizableMagic(bytes);
    return future === undefined
      ? invalid("invalid-magic", "magic")
      : {
          ok: false,
          error: productError("UnsupportedExportVersion", {
            format: future
          })
        };
  }

  let offset = MAGIC.length;
  const manifestLength = readLength(
    bytes,
    offset,
    "manifest-length"
  );
  if (!manifestLength.ok) return manifestLength;
  offset += 8;
  if (offset + manifestLength.value > bytes.length) {
    return invalid("truncated", "manifest-bytes");
  }

  let manifestSource: string;
  try {
    manifestSource = UTF8_DECODER.decode(
      bytes.subarray(offset, offset + manifestLength.value)
    );
  } catch {
    return invalid("invalid-utf8", "manifest-bytes");
  }
  offset += manifestLength.value;

  const manifest = parseExactExportManifest(manifestSource);
  if (!manifest.ok) return manifest;
  if (manifest.value.format !== "SKILOOM-EXPORT-V1") {
    return invalid("invalid-magic", "format");
  }

  const declared = declaredPayloads(manifest.value);
  const frames: ExactExportFileFrame[] = [];
  const seenFrames = new Set<string>();
  const seenPayloads = new Set<string>();

  while (offset < bytes.length) {
    const payloadLength = readLength(
      bytes,
      offset,
      "frame.payload-id-length"
    );
    if (!payloadLength.ok) return payloadLength;
    offset += 8;
    if (offset + payloadLength.value > bytes.length) {
      return invalid("truncated", "frame.payload-id");
    }
    const payloadId = decodeUtf8(
      bytes.subarray(offset, offset + payloadLength.value),
      "frame.payload-id"
    );
    if (!payloadId.ok) return payloadId;
    offset += payloadLength.value;

    const pathLength = readLength(
      bytes,
      offset,
      `${payloadId.value}.path-length`
    );
    if (!pathLength.ok) return pathLength;
    offset += 8;
    if (offset + pathLength.value > bytes.length) {
      return invalid("truncated", `${payloadId.value}.path`);
    }
    const path = decodeUtf8(
      bytes.subarray(offset, offset + pathLength.value),
      `${payloadId.value}.path`
    );
    if (!path.ok) return path;
    offset += pathLength.value;

    if (offset >= bytes.length) {
      return invalid("truncated", `${payloadId.value}:${path.value}.executable`);
    }
    const executableByte = bytes[offset]!;
    offset += 1;
    if (executableByte !== 0 && executableByte !== 1) {
      return invalid(
        "invalid-executable",
        `${payloadId.value}:${path.value}`
      );
    }

    const fileLength = readLength(
      bytes,
      offset,
      `${payloadId.value}:${path.value}.file-size`
    );
    if (!fileLength.ok) return fileLength;
    offset += 8;
    if (offset + fileLength.value > bytes.length) {
      return invalid(
        "truncated",
        `${payloadId.value}:${path.value}.file-bytes`
      );
    }
    const content = Uint8Array.from(
      bytes.subarray(offset, offset + fileLength.value)
    );
    offset += fileLength.value;

    if (!declared.has(payloadId.value)) {
      return invalid("undeclared-payload", payloadId.value);
    }
    const frameKey = `${payloadId.value}\u0000${path.value}`;
    if (seenFrames.has(frameKey)) {
      return invalid(
        "duplicate-frame",
        `${payloadId.value}:${path.value}`
      );
    }
    seenFrames.add(frameKey);
    seenPayloads.add(payloadId.value);
    frames.push({
      payloadId: payloadId.value,
      path: path.value,
      executable: executableByte === 1,
      content
    });
  }

  for (const payloadId of [...declared].sort(compareUtf8)) {
    if (!seenPayloads.has(payloadId)) {
      return invalid("missing-payload", payloadId);
    }
  }

  const verified = verifyPayloadFrames(
    manifest.value,
    frames
  );
  if (!verified.ok) return verified;

  frames.sort(compareFrames);
  return {
    ok: true,
    value: {
      manifest: manifest.value,
      frames
    }
  };
}

export function writeExactExportPackage(
  input: ExactExportPackage
): Result<Uint8Array, ExactExportParseError> {
  const manifestSource = writeExactExportManifest(input.manifest);
  const manifest = parseExactExportManifest(manifestSource);
  if (!manifest.ok) return manifest;

  const frames = [...input.frames]
    .map((frame) => ({
      ...frame,
      content: Uint8Array.from(frame.content)
    }))
    .sort(compareFrames);
  const parts: Buffer[] = [
    MAGIC,
    uint64le(Buffer.byteLength(manifestSource, "utf8")),
    Buffer.from(manifestSource, "utf8")
  ];
  for (const frame of frames) {
    const payloadId = Buffer.from(frame.payloadId, "utf8");
    const path = Buffer.from(frame.path, "utf8");
    const content = Buffer.from(frame.content);
    parts.push(
      uint64le(payloadId.length),
      payloadId,
      uint64le(path.length),
      path,
      Buffer.from([frame.executable ? 1 : 0]),
      uint64le(content.length),
      content
    );
  }
  const bytes = Buffer.concat(parts);
  const verified = parseExactExportPackage(bytes);
  return verified.ok
    ? { ok: true, value: Uint8Array.from(bytes) }
    : verified;
}

function verifyPayloadFrames(
  manifest: ExactExportPackage["manifest"],
  frames: ReadonlyArray<ExactExportFileFrame>
): Result<void, InvalidExportPackage> {
  const byPayload = new Map<string, ExactExportFileFrame[]>();
  for (const frame of frames) {
    const group = byPayload.get(frame.payloadId) ?? [];
    group.push(frame);
    byPayload.set(frame.payloadId, group);
  }

  for (const [payloadId, group] of byPayload) {
    for (const frame of group) {
      const single = createPackageSnapshot([
        {
          path: frame.path,
          executable: frame.executable,
          content: frame.content
        }
      ]);
      if (!single.ok) {
        return invalid(
          "invalid-payload-path",
          `${payloadId}:${frame.path}`
        );
      }
    }
    const snapshot = createPackageSnapshot(
      group.map((frame) => ({
        path: frame.path,
        executable: frame.executable,
        content: frame.content
      }))
    );
    if (!snapshot.ok) {
      return invalid("invalid-payload-path", payloadId);
    }
  }

  const managedDigests = new Map(
    manifest.packages.map((entry) => [
      entry.payloadId,
      entry.contentDigest
    ])
  );
  for (const [payloadId, contentDigest] of managedDigests) {
    const group = byPayload.get(payloadId);
    if (group === undefined) {
      return invalid("missing-payload", payloadId);
    }
    const snapshot = createPackageSnapshot(
      group.map((frame) => ({
        path: frame.path,
        executable: frame.executable,
        content: frame.content
      }))
    );
    if (!snapshot.ok || snapshot.value.contentDigest !== contentDigest) {
      return invalid(
        "managed-content-digest-mismatch",
        payloadId
      );
    }
  }

  const userDigests = new Map<string, string>();
  for (const entry of manifest.detached) {
    userDigests.set(
      entry.payloadId,
      entry.userContentDigest
    );
  }
  for (const entry of manifest.userSkills) {
    userDigests.set(
      entry.payloadId,
      entry.userContentDigest
    );
  }
  for (const [payloadId, contentDigest] of userDigests) {
    const group = byPayload.get(payloadId);
    if (group === undefined) {
      return invalid("missing-payload", payloadId);
    }
    const verified = verifyUserPayload(
      contentDigest,
      group.map((frame) => ({
        path: frame.path,
        executable: frame.executable,
        content: frame.content
      }))
    );
    if (!verified.ok) {
      return invalid(
        verified.error.code === "UserPayloadDigestMismatch"
          ? "user-content-digest-mismatch"
          : "invalid-payload-path",
        payloadId
      );
    }
  }

  return { ok: true, value: undefined };
}

function declaredPayloads(
  manifest: ExactExportPackage["manifest"]
): ReadonlySet<string> {
  return new Set([
    ...manifest.packages.map((entry) => entry.payloadId),
    ...manifest.detached.map((entry) => entry.payloadId),
    ...manifest.userSkills.map((entry) => entry.payloadId)
  ]);
}

function readLength(
  bytes: Buffer,
  offset: number,
  path: string
): Result<number, InvalidExportPackage> {
  if (offset + 8 > bytes.length) {
    return invalid("truncated", path);
  }
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return invalid("length-out-of-range", path);
  }
  return { ok: true, value: Number(value) };
}

function decodeUtf8(
  bytes: Uint8Array,
  path: string
): Result<string, InvalidExportPackage> {
  try {
    return { ok: true, value: UTF8_DECODER.decode(bytes) };
  } catch {
    return invalid("invalid-utf8", path);
  }
}

function recognizableMagic(bytes: Buffer): string | undefined {
  const limit = Math.min(bytes.length, 64);
  const nul = bytes.subarray(0, limit).indexOf(0);
  if (nul < 0) return undefined;
  const raw = bytes.subarray(0, nul);
  if (raw.some((byte) => byte > 0x7f)) return undefined;
  const value = raw.toString("ascii");
  return FUTURE_MAGIC_PATTERN.test(value) ? value : undefined;
}

function startsWith(value: Buffer, prefix: Buffer): boolean {
  return (
    value.length >= prefix.length &&
    value.subarray(0, prefix.length).equals(prefix)
  );
}

function compareFrames(
  left: ExactExportFileFrame,
  right: ExactExportFileFrame
): number {
  const payload = compareUtf8(left.payloadId, right.payloadId);
  return payload !== 0
    ? payload
    : compareUtf8(left.path, right.path);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

function uint64le(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function invalid(
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
