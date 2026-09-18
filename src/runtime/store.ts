import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  createPackageSnapshot,
  type PackageSnapshot,
  type PackageSnapshotError
} from "../domain/snapshot/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../domain/errors/index.js";
import type { SkiloomHomePaths } from "./home.js";

const STORE_MANIFEST_FORMAT = "SKILOOM-STORE-ENTRY-V1";
const CONTENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type StoreEntryNotFound = ProductError<
  "StoreEntryNotFound",
  Readonly<{ contentDigest: string }>
>;

export type PackageContentDigestMismatch = ProductError<
  "PackageContentDigestMismatch",
  Readonly<{
    expectedDigest: string;
    actualDigest: string;
  }>
>;

export type CorruptStoreEntryReason =
  | "unsupported-store-entry-type"
  | "invalid-manifest"
  | "missing-payload"
  | "unexpected-payload-entry"
  | "unsupported-payload-file-type"
  | "content-digest-mismatch";

export type CorruptStoreEntry = ProductError<
  "CorruptStoreEntry",
  Readonly<{
    contentDigest: string;
    reason: CorruptStoreEntryReason;
  }>
>;

export type InvalidPackageContentDigest = ProductError<
  "InvalidPackageContentDigest",
  Readonly<{ contentDigest: string }>
>;

export type PackageStoreError =
  | StoreEntryNotFound
  | PackageContentDigestMismatch
  | CorruptStoreEntry
  | InvalidPackageContentDigest
  | PackageSnapshotError;

export type VerifiedPackageStoreEntry = Readonly<{
  contentDigest: string;
  entryPath: string;
  payloadPath: string;
  snapshot: PackageSnapshot;
}>;

export type PublishedPackageStoreEntry = VerifiedPackageStoreEntry &
  Readonly<{ status: "published" | "existing" }>;

type CollectedPayloadEntry = Readonly<{
  path: string;
  executableOnDisk: boolean;
  content: Uint8Array;
}>;

type StoreManifest = Readonly<{
  format: typeof STORE_MANIFEST_FORMAT;
  contentDigest: string;
  entries: ReadonlyArray<
    Readonly<{
      path: string;
      executable: boolean;
    }>
  >;
}>;

export async function publishPackageSnapshot(
  paths: SkiloomHomePaths,
  snapshot: PackageSnapshot
): Promise<Result<PublishedPackageStoreEntry, PackageStoreError>> {
  const rebuilt = rebuildSnapshotForDigest(
    snapshot,
    snapshot.contentDigest
  );
  if (!rebuilt.ok) {
    return rebuilt;
  }

  const entryPath = storeEntryPath(paths, snapshot.contentDigest);
  if (await pathExists(entryPath)) {
    const existing = await verifyPackageStoreEntry(paths, snapshot.contentDigest);
    if (!existing.ok) {
      return existing;
    }
    return {
      ok: true,
      value: {
        ...existing.value,
        status: "existing"
      }
    };
  }

  await mkdir(paths.storePath, { recursive: true });
  const stagingPath = join(
    paths.storePath,
    `.staging-${process.pid}-${randomUUID()}`
  );

  try {
    await writeStagingEntry(stagingPath, rebuilt.value);
    const staged = await verifyEntryDirectory(stagingPath, snapshot.contentDigest);
    if (!staged.ok) {
      return staged;
    }

    try {
      await rename(stagingPath, entryPath);
    } catch (error) {
      if (await pathExists(entryPath)) {
        const existing = await verifyPackageStoreEntry(paths, snapshot.contentDigest);
        if (!existing.ok) {
          return existing;
        }
        return {
          ok: true,
          value: {
            ...existing.value,
            status: "existing"
          }
        };
      }
      throw error;
    }

    return {
      ok: true,
      value: {
        ...staged.value,
        entryPath,
        payloadPath: join(entryPath, "payload"),
        status: "published"
      }
    };
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

export async function repairPackageStoreEntry(
  paths: SkiloomHomePaths,
  contentDigest: string,
  snapshot: PackageSnapshot
): Promise<Result<PublishedPackageStoreEntry, PackageStoreError>> {
  const rebuilt = rebuildSnapshotForDigest(snapshot, contentDigest);
  if (!rebuilt.ok) {
    return rebuilt;
  }

  const existing = await verifyPackageStoreEntry(paths, contentDigest);
  if (existing.ok) {
    return {
      ok: true,
      value: {
        ...existing.value,
        status: "existing"
      }
    };
  }
  if (
    existing.error.code !== "StoreEntryNotFound" &&
    existing.error.code !== "CorruptStoreEntry"
  ) {
    return existing;
  }

  await removeStoreEntryPath(storeEntryPath(paths, contentDigest));
  return publishPackageSnapshot(paths, rebuilt.value);
}

export async function verifyPackageStoreEntry(
  paths: SkiloomHomePaths,
  contentDigest: string
): Promise<Result<VerifiedPackageStoreEntry, PackageStoreError>> {
  const digestValidation = validateContentDigest(contentDigest);
  if (!digestValidation.ok) {
    return digestValidation;
  }

  const entryPath = storeEntryPath(paths, contentDigest);
  if (!(await pathExists(entryPath))) {
    return {
      ok: false,
      error: productError("StoreEntryNotFound", { contentDigest })
    };
  }

  return verifyEntryDirectory(entryPath, contentDigest);
}

function rebuildSnapshotForDigest(
  snapshot: PackageSnapshot,
  expectedDigest: string
): Result<PackageSnapshot, PackageStoreError> {
  const digestValidation = validateContentDigest(expectedDigest);
  if (!digestValidation.ok) {
    return digestValidation;
  }

  const rebuilt = createPackageSnapshot(
    snapshot.entries.map((entry) => ({
      path: entry.path,
      executable: entry.executable,
      content: entry.content
    }))
  );
  if (!rebuilt.ok) {
    return rebuilt;
  }
  if (rebuilt.value.contentDigest !== expectedDigest) {
    return {
      ok: false,
      error: productError("PackageContentDigestMismatch", {
        expectedDigest,
        actualDigest: rebuilt.value.contentDigest
      })
    };
  }
  return rebuilt;
}

async function removeStoreEntryPath(entryPath: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(entryPath);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  await rm(entryPath, {
    recursive: stat.isDirectory() && !stat.isSymbolicLink(),
    force: true
  });
}

function validateContentDigest(
  contentDigest: string
): Result<string, InvalidPackageContentDigest> {
  if (!CONTENT_DIGEST_PATTERN.test(contentDigest)) {
    return {
      ok: false,
      error: productError("InvalidPackageContentDigest", { contentDigest })
    };
  }
  return { ok: true, value: contentDigest };
}

function storeEntryPath(paths: SkiloomHomePaths, contentDigest: string): string {
  const hex = contentDigest.slice("sha256:".length);
  return join(paths.storePath, `sha256-${hex}`);
}

async function writeStagingEntry(
  stagingPath: string,
  snapshot: PackageSnapshot
): Promise<void> {
  const payloadPath = join(stagingPath, "payload");
  await mkdir(payloadPath, { recursive: true });

  for (const entry of snapshot.entries) {
    const targetPath = join(payloadPath, ...entry.path.split("/"));
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, entry.content, { flag: "wx" });
    if (entry.executable && process.platform !== "win32") {
      await chmod(targetPath, 0o755);
    }
  }

  const manifest: StoreManifest = {
    format: STORE_MANIFEST_FORMAT,
    contentDigest: snapshot.contentDigest,
    entries: snapshot.entries.map((entry) => ({
      path: entry.path,
      executable: entry.executable
    }))
  };
  await writeFile(
    join(stagingPath, "manifest.json"),
    `${JSON.stringify(manifest)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
}

async function verifyEntryDirectory(
  entryPath: string,
  expectedDigest: string
): Promise<Result<VerifiedPackageStoreEntry, PackageStoreError>> {
  let entryStat;
  try {
    entryStat = await lstat(entryPath);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        ok: false,
        error: productError("StoreEntryNotFound", { contentDigest: expectedDigest })
      };
    }
    throw error;
  }
  if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
    return corrupt(expectedDigest, "unsupported-store-entry-type");
  }

  const manifest = await readManifest(entryPath, expectedDigest);
  if (!manifest.ok) {
    return manifest;
  }

  const payloadPath = join(entryPath, "payload");
  const payloadEntries = await collectPayloadFiles(payloadPath, expectedDigest);
  if (!payloadEntries.ok) {
    return payloadEntries;
  }

  const expectedPaths = [...manifest.value.entries]
    .map((entry) => entry.path)
    .sort(compareStrings);
  const actualPaths = payloadEntries.value.map((entry) => entry.path).sort(compareStrings);
  if (!sameStrings(expectedPaths, actualPaths)) {
    return corrupt(expectedDigest, "unexpected-payload-entry");
  }

  const executableByPath = new Map(
    manifest.value.entries.map((entry) => [entry.path, entry.executable])
  );
  if (process.platform !== "win32") {
    for (const entry of payloadEntries.value) {
      if (entry.executableOnDisk !== executableByPath.get(entry.path)) {
        return corrupt(expectedDigest, "content-digest-mismatch");
      }
    }
  }

  const snapshot = createPackageSnapshot(
    payloadEntries.value.map((entry) => ({
      path: entry.path,
      executable:
        process.platform === "win32"
          ? (executableByPath.get(entry.path) ?? false)
          : entry.executableOnDisk,
      content: entry.content
    }))
  );
  if (!snapshot.ok) {
    return corrupt(expectedDigest, "invalid-manifest");
  }
  if (snapshot.value.contentDigest !== expectedDigest) {
    return corrupt(expectedDigest, "content-digest-mismatch");
  }

  return {
    ok: true,
    value: {
      contentDigest: expectedDigest,
      entryPath,
      payloadPath,
      snapshot: snapshot.value
    }
  };
}

async function readManifest(
  entryPath: string,
  expectedDigest: string
): Promise<Result<StoreManifest, CorruptStoreEntry>> {
  let raw: string;
  try {
    raw = await readFile(join(entryPath, "manifest.json"), "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return corrupt(expectedDigest, "invalid-manifest");
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return corrupt(expectedDigest, "invalid-manifest");
  }
  if (!isStoreManifest(value, expectedDigest)) {
    return corrupt(expectedDigest, "invalid-manifest");
  }
  return { ok: true, value };
}

function isStoreManifest(value: unknown, expectedDigest: string): value is StoreManifest {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (
    value.format !== STORE_MANIFEST_FORMAT ||
    value.contentDigest !== expectedDigest ||
    !Array.isArray(value.entries)
  ) {
    return false;
  }

  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (
      !isPlainRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.executable !== "boolean" ||
      Object.keys(entry).some((key) => key !== "path" && key !== "executable") ||
      seen.has(entry.path)
    ) {
      return false;
    }
    seen.add(entry.path);
  }

  return Object.keys(value).every(
    (key) => key === "format" || key === "contentDigest" || key === "entries"
  );
}

async function collectPayloadFiles(
  payloadPath: string,
  contentDigest: string
): Promise<Result<ReadonlyArray<CollectedPayloadEntry>, CorruptStoreEntry>> {
  let rootStat;
  try {
    rootStat = await lstat(payloadPath);
  } catch (error) {
    if (isNotFound(error)) {
      return corrupt(contentDigest, "missing-payload");
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return corrupt(contentDigest, "unsupported-payload-file-type");
  }

  const files: CollectedPayloadEntry[] = [];
  const directories = [payloadPath];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) {
      continue;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        return corrupt(contentDigest, "unsupported-payload-file-type");
      }
      if (stat.isDirectory()) {
        directories.push(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        return corrupt(contentDigest, "unsupported-payload-file-type");
      }
      files.push({
        path: toPackagePath(relative(payloadPath, absolutePath)),
        executableOnDisk: (stat.mode & 0o111) !== 0,
        content: await readFile(absolutePath)
      });
    }
  }

  files.sort((left, right) => compareStrings(left.path, right.path));
  return { ok: true, value: files };
}

function toPackagePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function corrupt(
  contentDigest: string,
  reason: CorruptStoreEntryReason
): Result<never, CorruptStoreEntry> {
  return {
    ok: false,
    error: productError("CorruptStoreEntry", { contentDigest, reason })
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}
