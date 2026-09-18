import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Result } from "../../../../domain/errors/index.js";
import type {
  RepositorySnapshotEntry,
  RepositorySnapshotFileType
} from "../../../../domain/snapshot/index.js";
import {
  acquireExactGitHubRepositorySnapshot,
  type AcquiredGitHubRepositorySnapshot,
  type AcquireExactGitHubRepositorySnapshotError,
  type AcquireExactGitHubRepositorySnapshotInput
} from "../snapshot.js";

const CACHE_FORMAT = "SKILOOM-GITHUB-SOURCE-CACHE-V1";
const EXACT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const INTEGRITY_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SPECIAL_FILE_TYPES = new Set<
  Exclude<RepositorySnapshotFileType, "regular">
>([
  "symlink",
  "hardlink",
  "fifo",
  "device",
  "socket",
  "other"
]);

type CachedRegularEntry = Readonly<{
  pathBase64: string;
  fileType: "regular";
  gitMode: "100644" | "100755";
  contentBase64: string;
}>;

type CachedSpecialEntry = Readonly<{
  pathBase64: string;
  fileType: Exclude<RepositorySnapshotFileType, "regular">;
}>;

type CachedSnapshotEntry = CachedRegularEntry | CachedSpecialEntry;

type CachePayload = Readonly<{
  format: typeof CACHE_FORMAT;
  repositoryCoordinate: string;
  exactCommit: string;
  entries: ReadonlyArray<CachedSnapshotEntry>;
}>;

type CacheDocument = CachePayload &
  Readonly<{
    integrity: string;
  }>;

export type AcquireCachedExactGitHubRepositorySnapshotInput =
  AcquireExactGitHubRepositorySnapshotInput &
    Readonly<{
      cacheRoot: string;
    }>;

export async function acquireCachedExactGitHubRepositorySnapshot(
  input: AcquireCachedExactGitHubRepositorySnapshotInput
): Promise<
  Result<
    AcquiredGitHubRepositorySnapshot,
    AcquireExactGitHubRepositorySnapshotError
  >
> {
  if (!EXACT_COMMIT_PATTERN.test(input.exactCommit)) {
    return acquireExactGitHubRepositorySnapshot(withoutCacheRoot(input));
  }

  const path = sourceCacheEntryPath(
    input.cacheRoot,
    input.repository.canonical,
    input.exactCommit
  );
  const cached = await readCachedSnapshot(
    path,
    input.repository.canonical,
    input.exactCommit
  );
  if (cached !== undefined) {
    return {
      ok: true,
      value: {
        repository: input.repository,
        exactCommit: input.exactCommit,
        entries: cached
      }
    };
  }

  const acquired = await acquireExactGitHubRepositorySnapshot(
    withoutCacheRoot(input)
  );
  if (!acquired.ok) {
    return acquired;
  }

  await writeCachedSnapshotBestEffort(path, acquired.value);
  return acquired;
}

export function sourceCacheEntryPath(
  cacheRoot: string,
  repositoryCoordinate: string,
  exactCommit: string
): string {
  const repositoryKey = createHash("sha256")
    .update(repositoryCoordinate, "utf8")
    .digest("hex");
  return join(
    cacheRoot,
    "github-v1",
    repositoryKey,
    `${exactCommit}.json`
  );
}

function withoutCacheRoot(
  input: AcquireCachedExactGitHubRepositorySnapshotInput
): AcquireExactGitHubRepositorySnapshotInput {
  return {
    repository: input.repository,
    exactCommit: input.exactCommit,
    transport: input.transport,
    ...(input.credential === undefined
      ? {}
      : { credential: input.credential })
  };
}

async function readCachedSnapshot(
  path: string,
  repositoryCoordinate: string,
  exactCommit: string
): Promise<ReadonlyArray<RepositorySnapshotEntry> | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  const parsed = parseCacheDocument(
    source,
    repositoryCoordinate,
    exactCommit
  );
  if (parsed !== undefined) {
    return parsed;
  }

  await removeBestEffort(path);
  return undefined;
}

function parseCacheDocument(
  source: string,
  repositoryCoordinate: string,
  exactCommit: string
): ReadonlyArray<RepositorySnapshotEntry> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(value) || !hasExactKeys(value, [
    "format",
    "repositoryCoordinate",
    "exactCommit",
    "entries",
    "integrity"
  ])) {
    return undefined;
  }
  if (
    value.format !== CACHE_FORMAT ||
    value.repositoryCoordinate !== repositoryCoordinate ||
    value.exactCommit !== exactCommit ||
    !Array.isArray(value.entries) ||
    typeof value.integrity !== "string" ||
    !INTEGRITY_PATTERN.test(value.integrity)
  ) {
    return undefined;
  }

  const cachedEntries: CachedSnapshotEntry[] = [];
  const snapshotEntries: RepositorySnapshotEntry[] = [];
  const seenPaths = new Set<string>();

  for (const rawEntry of value.entries) {
    const parsed = parseCacheEntry(rawEntry);
    if (parsed === undefined) {
      return undefined;
    }
    const pathBytes = decodeStrictBase64(parsed.pathBase64);
    if (pathBytes === undefined) {
      return undefined;
    }
    const pathKey = Buffer.from(pathBytes).toString("base64");
    if (seenPaths.has(pathKey)) {
      return undefined;
    }
    seenPaths.add(pathKey);

    cachedEntries.push(parsed);
    if (parsed.fileType === "regular") {
      const content = decodeStrictBase64(parsed.contentBase64);
      if (content === undefined) {
        return undefined;
      }
      snapshotEntries.push({
        pathBytes,
        fileType: "regular",
        gitMode: parsed.gitMode,
        content
      });
    } else {
      snapshotEntries.push({
        pathBytes,
        fileType: parsed.fileType
      });
    }
  }

  const payload: CachePayload = {
    format: CACHE_FORMAT,
    repositoryCoordinate,
    exactCommit,
    entries: cachedEntries
  };
  if (integrityFor(payload) !== value.integrity) {
    return undefined;
  }

  snapshotEntries.sort(compareSnapshotEntries);
  return snapshotEntries;
}

function parseCacheEntry(value: unknown): CachedSnapshotEntry | undefined {
  if (!isRecord(value) || typeof value.fileType !== "string") {
    return undefined;
  }

  if (value.fileType === "regular") {
    if (
      !hasExactKeys(value, [
        "pathBase64",
        "fileType",
        "gitMode",
        "contentBase64"
      ]) ||
      typeof value.pathBase64 !== "string" ||
      (value.gitMode !== "100644" && value.gitMode !== "100755") ||
      typeof value.contentBase64 !== "string"
    ) {
      return undefined;
    }
    return {
      pathBase64: value.pathBase64,
      fileType: "regular",
      gitMode: value.gitMode,
      contentBase64: value.contentBase64
    };
  }

  if (
    !SPECIAL_FILE_TYPES.has(
      value.fileType as Exclude<RepositorySnapshotFileType, "regular">
    ) ||
    !hasExactKeys(value, ["pathBase64", "fileType"]) ||
    typeof value.pathBase64 !== "string"
  ) {
    return undefined;
  }

  return {
    pathBase64: value.pathBase64,
    fileType: value.fileType as Exclude<
      RepositorySnapshotFileType,
      "regular"
    >
  };
}

async function writeCachedSnapshotBestEffort(
  path: string,
  snapshot: AcquiredGitHubRepositorySnapshot
): Promise<void> {
  const payload = cachePayload(snapshot);
  const document: CacheDocument = {
    ...payload,
    integrity: integrityFor(payload)
  };
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      tempPath,
      `${JSON.stringify(document)}\n`,
      {
        encoding: "utf8",
        flag: "wx"
      }
    );
    await rename(tempPath, path);
  } catch {
    // The cache is disposable. Source acquisition must not depend on cache I/O.
  } finally {
    await removeBestEffort(tempPath);
  }
}

function cachePayload(
  snapshot: AcquiredGitHubRepositorySnapshot
): CachePayload {
  const entries = [...snapshot.entries]
    .sort(compareSnapshotEntries)
    .map((entry): CachedSnapshotEntry =>
      entry.fileType === "regular"
        ? {
            pathBase64: Buffer.from(entry.pathBytes).toString("base64"),
            fileType: "regular",
            gitMode: entry.gitMode,
            contentBase64: Buffer.from(entry.content).toString("base64")
          }
        : {
            pathBase64: Buffer.from(entry.pathBytes).toString("base64"),
            fileType: entry.fileType
          }
    );

  return {
    format: CACHE_FORMAT,
    repositoryCoordinate: snapshot.repository.canonical,
    exactCommit: snapshot.exactCommit,
    entries
  };
}

function integrityFor(payload: CachePayload): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex")}`;
}

function decodeStrictBase64(value: string): Uint8Array | undefined {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value
    )
  ) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value
    ? Uint8Array.from(bytes)
    : undefined;
}

function compareSnapshotEntries(
  left: RepositorySnapshotEntry,
  right: RepositorySnapshotEntry
): number {
  return Buffer.compare(
    Buffer.from(left.pathBytes),
    Buffer.from(right.pathBytes)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

async function removeBestEffort(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Cache cleanup is best-effort by design.
  }
}
