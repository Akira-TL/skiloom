import type { RepositoryCoordinate } from "../../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  RepositorySnapshotEntry
} from "../../../domain/snapshot/index.js";
import type { SourceAccessUnavailable } from "./repository.js";
import type { GitHubJsonTransport } from "./transport.js";

const EXACT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export type AcquiredGitHubRepositorySnapshot = Readonly<{
  repository: RepositoryCoordinate;
  exactCommit: string;
  entries: ReadonlyArray<RepositorySnapshotEntry>;
}>;

export type InvalidExactGitHubCommit = ProductError<
  "InvalidExactGitHubCommit",
  Readonly<{
    repositoryCoordinate: string;
    exactCommit: string;
  }>
>;

export type InvalidGitHubGitCommitResponse = ProductError<
  "InvalidGitHubGitCommitResponse",
  Readonly<{
    repositoryCoordinate: string;
    exactCommit: string;
  }>
>;

export type InvalidGitHubTreeResponse = ProductError<
  "InvalidGitHubTreeResponse",
  Readonly<{
    repositoryCoordinate: string;
    exactCommit: string;
  }>
>;

export type GitHubTreeTruncated = ProductError<
  "GitHubTreeTruncated",
  Readonly<{
    repositoryCoordinate: string;
    exactCommit: string;
  }>
>;

export type UnsupportedGitTreeEntry = ProductError<
  "UnsupportedGitTreeEntry",
  Readonly<{
    repositoryCoordinate: string;
    path: string;
    mode: string;
    type: string;
  }>
>;

export type InvalidGitHubBlobResponse = ProductError<
  "InvalidGitHubBlobResponse",
  Readonly<{
    repositoryCoordinate: string;
    path: string;
  }>
>;

export type GitHubSnapshotTransportUnavailable = ProductError<
  "GitHubSnapshotTransportUnavailable",
  Readonly<{
    repositoryCoordinate: string;
    operation: "read-commit" | "read-tree" | "read-blob";
    status: number | null;
  }>
>;

export type AcquireExactGitHubRepositorySnapshotError =
  | SourceAccessUnavailable
  | InvalidExactGitHubCommit
  | InvalidGitHubGitCommitResponse
  | InvalidGitHubTreeResponse
  | GitHubTreeTruncated
  | UnsupportedGitTreeEntry
  | InvalidGitHubBlobResponse
  | GitHubSnapshotTransportUnavailable;

export type AcquireExactGitHubRepositorySnapshotInput = Readonly<{
  repository: RepositoryCoordinate;
  exactCommit: string;
  credential?: string;
  transport: GitHubJsonTransport;
}>;

type GitTreeRegularEntry = Readonly<{
  path: string;
  mode: "100644" | "100755";
  sha: string;
}>;

export async function acquireExactGitHubRepositorySnapshot(
  input: AcquireExactGitHubRepositorySnapshotInput
): Promise<
  Result<
    AcquiredGitHubRepositorySnapshot,
    AcquireExactGitHubRepositorySnapshotError
  >
> {
  if (!EXACT_COMMIT_PATTERN.test(input.exactCommit)) {
    return {
      ok: false,
      error: productError("InvalidExactGitHubCommit", {
        repositoryCoordinate: input.repository.canonical,
        exactCommit: input.exactCommit
      })
    };
  }

  const treeSha = await readCommitTreeSha(input);
  if (!treeSha.ok) {
    return treeSha;
  }

  const tree = await readRecursiveTree(input, treeSha.value);
  if (!tree.ok) {
    return tree;
  }

  const entries: RepositorySnapshotEntry[] = [];
  for (const special of tree.value.symlinks) {
    entries.push({
      pathBytes: new TextEncoder().encode(special.path),
      fileType: "symlink"
    });
  }

  for (const regular of tree.value.regular) {
    const content = await readBlob(input, regular);
    if (!content.ok) {
      return content;
    }
    entries.push({
      pathBytes: new TextEncoder().encode(regular.path),
      fileType: "regular",
      gitMode: regular.mode,
      content: content.value
    });
  }

  entries.sort(compareSnapshotEntries);

  return {
    ok: true,
    value: {
      repository: input.repository,
      exactCommit: input.exactCommit,
      entries
    }
  };
}

async function readCommitTreeSha(
  input: AcquireExactGitHubRepositorySnapshotInput
): Promise<Result<string, AcquireExactGitHubRepositorySnapshotError>> {
  const response = await requestJson(
    input,
    {
      path:
        repositoryPath(input.repository) +
        "/git/commits/" +
        input.exactCommit
    },
    "read-commit"
  );
  if (!response.ok) {
    return response;
  }

  if (!isRecord(response.value.body)) {
    return invalidCommitResponse(input);
  }
  if (response.value.body.sha !== input.exactCommit) {
    return invalidCommitResponse(input);
  }

  const tree = response.value.body.tree;
  if (!isRecord(tree)) {
    return invalidCommitResponse(input);
  }
  const sha = tree.sha;
  if (typeof sha !== "string" || !EXACT_COMMIT_PATTERN.test(sha)) {
    return invalidCommitResponse(input);
  }

  return { ok: true, value: sha };
}

type ParsedTree = Readonly<{
  regular: ReadonlyArray<GitTreeRegularEntry>;
  symlinks: ReadonlyArray<Readonly<{ path: string }>>;
}>;

async function readRecursiveTree(
  input: AcquireExactGitHubRepositorySnapshotInput,
  treeSha: string
): Promise<Result<ParsedTree, AcquireExactGitHubRepositorySnapshotError>> {
  const response = await requestJson(
    input,
    {
      path:
        repositoryPath(input.repository) +
        "/git/trees/" +
        treeSha,
      query: { recursive: "1" }
    },
    "read-tree"
  );
  if (!response.ok) {
    return response;
  }

  if (!isRecord(response.value.body)) {
    return invalidTreeResponse(input);
  }
  if (
    response.value.body.sha !== treeSha ||
    typeof response.value.body.truncated !== "boolean" ||
    !Array.isArray(response.value.body.tree)
  ) {
    return invalidTreeResponse(input);
  }
  if (response.value.body.truncated) {
    return {
      ok: false,
      error: productError("GitHubTreeTruncated", {
        repositoryCoordinate: input.repository.canonical,
        exactCommit: input.exactCommit
      })
    };
  }

  const regular: GitTreeRegularEntry[] = [];
  const symlinks: Array<Readonly<{ path: string }>> = [];
  const seenPaths = new Set<string>();

  for (const value of response.value.body.tree) {
    const parsed = parseTreeEntry(value);
    if (parsed === undefined || seenPaths.has(parsed.path)) {
      return invalidTreeResponse(input);
    }
    seenPaths.add(parsed.path);

    if (parsed.type === "tree" && parsed.mode === "040000") {
      continue;
    }
    if (
      parsed.type === "blob" &&
      (parsed.mode === "100644" || parsed.mode === "100755")
    ) {
      regular.push({
        path: parsed.path,
        mode: parsed.mode,
        sha: parsed.sha
      });
      continue;
    }
    if (parsed.type === "blob" && parsed.mode === "120000") {
      symlinks.push({ path: parsed.path });
      continue;
    }

    return {
      ok: false,
      error: productError("UnsupportedGitTreeEntry", {
        repositoryCoordinate: input.repository.canonical,
        path: parsed.path,
        mode: parsed.mode,
        type: parsed.type
      })
    };
  }

  regular.sort((left, right) => compareUtf8(left.path, right.path));
  symlinks.sort((left, right) => compareUtf8(left.path, right.path));

  return {
    ok: true,
    value: {
      regular,
      symlinks
    }
  };
}

type ParsedTreeEntry = Readonly<{
  path: string;
  mode: string;
  type: string;
  sha: string;
}>;

function parseTreeEntry(value: unknown): ParsedTreeEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const path = value.path;
  const mode = value.mode;
  const type = value.type;
  const sha = value.sha;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    typeof mode !== "string" ||
    typeof type !== "string" ||
    typeof sha !== "string" ||
    !EXACT_COMMIT_PATTERN.test(sha)
  ) {
    return undefined;
  }

  return { path, mode, type, sha };
}

async function readBlob(
  input: AcquireExactGitHubRepositorySnapshotInput,
  entry: GitTreeRegularEntry
): Promise<
  Result<Uint8Array, AcquireExactGitHubRepositorySnapshotError>
> {
  const response = await requestJson(
    input,
    {
      path:
        repositoryPath(input.repository) +
        "/git/blobs/" +
        entry.sha
    },
    "read-blob"
  );
  if (!response.ok) {
    return response;
  }

  if (!isRecord(response.value.body)) {
    return invalidBlobResponse(input, entry.path);
  }
  if (
    response.value.body.sha !== entry.sha ||
    response.value.body.encoding !== "base64" ||
    typeof response.value.body.content !== "string"
  ) {
    return invalidBlobResponse(input, entry.path);
  }

  const content = decodeStrictBase64(response.value.body.content);
  return content === undefined
    ? invalidBlobResponse(input, entry.path)
    : { ok: true, value: content };
}

type JsonRequest = Readonly<{
  path: string;
  query?: Readonly<Record<string, string>>;
}>;

async function requestJson(
  input: AcquireExactGitHubRepositorySnapshotInput,
  request: JsonRequest,
  operation: GitHubSnapshotTransportUnavailable["facts"]["operation"]
): Promise<
  Result<
    Readonly<{ body: unknown }>,
    SourceAccessUnavailable | GitHubSnapshotTransportUnavailable
  >
> {
  let response;
  try {
    response = await input.transport({
      ...request,
      ...(input.credential === undefined
        ? {}
        : { credential: input.credential })
    });
  } catch {
    return transportUnavailable(input.repository, operation, null);
  }

  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return {
      ok: false,
      error: productError("SourceAccessUnavailable", {
        repositoryCoordinate: input.repository.canonical,
        status: response.status
      })
    };
  }

  if (response.status !== 200) {
    return transportUnavailable(
      input.repository,
      operation,
      response.status
    );
  }

  return {
    ok: true,
    value: {
      body: response.body
    }
  };
}

function decodeStrictBase64(value: string): Uint8Array | undefined {
  const compact = value.replace(/\s+/gu, "");
  if (
    compact.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      compact
    )
  ) {
    return undefined;
  }

  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64") !== compact) {
    return undefined;
  }
  return Uint8Array.from(bytes);
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

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

function repositoryPath(repository: RepositoryCoordinate): string {
  return (
    "/repos/" +
    encodeURIComponent(repository.owner) +
    "/" +
    encodeURIComponent(repository.repo)
  );
}

function invalidCommitResponse(
  input: AcquireExactGitHubRepositorySnapshotInput
): Result<never, InvalidGitHubGitCommitResponse> {
  return {
    ok: false,
    error: productError("InvalidGitHubGitCommitResponse", {
      repositoryCoordinate: input.repository.canonical,
      exactCommit: input.exactCommit
    })
  };
}

function invalidTreeResponse(
  input: AcquireExactGitHubRepositorySnapshotInput
): Result<never, InvalidGitHubTreeResponse> {
  return {
    ok: false,
    error: productError("InvalidGitHubTreeResponse", {
      repositoryCoordinate: input.repository.canonical,
      exactCommit: input.exactCommit
    })
  };
}

function invalidBlobResponse(
  input: AcquireExactGitHubRepositorySnapshotInput,
  path: string
): Result<never, InvalidGitHubBlobResponse> {
  return {
    ok: false,
    error: productError("InvalidGitHubBlobResponse", {
      repositoryCoordinate: input.repository.canonical,
      path
    })
  };
}

function transportUnavailable(
  repository: RepositoryCoordinate,
  operation: GitHubSnapshotTransportUnavailable["facts"]["operation"],
  status: number | null
): Result<never, GitHubSnapshotTransportUnavailable> {
  return {
    ok: false,
    error: productError("GitHubSnapshotTransportUnavailable", {
      repositoryCoordinate: repository.canonical,
      operation,
      status
    })
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
