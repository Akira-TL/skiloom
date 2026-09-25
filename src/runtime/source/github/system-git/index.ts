import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RepositoryCoordinate } from "../../../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../../../domain/errors/index.js";
import type { RepositorySnapshotEntry } from "../../../../domain/snapshot/index.js";
import {
  readCachedExactGitHubRepositorySnapshot,
  writeCachedExactGitHubRepositorySnapshot
} from "../cache/index.js";
import type {
  AcquiredGitHubRepositorySnapshot,
  UnsupportedGitTreeEntry
} from "../snapshot.js";

const EXACT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export type GitHubSystemGitRemoteCandidate = Readonly<{
  kind: "ssh" | "https";
  url: string;
}>;

export type GitHubSystemGitOperation =
  | "initialize"
  | "fetch"
  | "resolve-ref"
  | "read-tree"
  | "read-blob";

export type GitHubSystemGitUnavailable = ProductError<
  "GitHubSystemGitUnavailable",
  Readonly<{
    repositoryCoordinate: string;
    operation: GitHubSystemGitOperation;
    reason:
      | "git-unavailable"
      | "access-unavailable"
      | "invalid-response"
      | "aborted"
      | "local-io";
  }>
>;

export type AcquireGitRepositorySnapshotWithSystemGitError =
  | GitHubSystemGitUnavailable
  | UnsupportedGitTreeEntry;

export type AcquireGitRepositorySnapshotWithSystemGitInput = Readonly<{
  repository: RepositoryCoordinate;
  requestedRef: string;
  remotes: ReadonlyArray<GitHubSystemGitRemoteCandidate>;
  gitExecutable?: string;
  signal?: AbortSignal;
  sourceCachePath?: string;
}>;

export type AcquireGitHubRepositorySnapshotWithSystemGitInput = Readonly<{
  repository: RepositoryCoordinate;
  requestedRef: string;
  gitExecutable?: string;
  signal?: AbortSignal;
  sourceCachePath?: string;
}>;

export type GitHubSystemGitSnapshotTransport = (
  input: AcquireGitHubRepositorySnapshotWithSystemGitInput
) => Promise<
  Result<
    AcquiredGitHubRepositorySnapshot,
    AcquireGitRepositorySnapshotWithSystemGitError
  >
>;

export function gitHubSystemGitRemoteCandidates(
  repository: RepositoryCoordinate
): ReadonlyArray<GitHubSystemGitRemoteCandidate> {
  return [
    {
      kind: "ssh",
      url: `git@github.com:${repository.owner}/${repository.repo}.git`
    },
    {
      kind: "https",
      url:
        `https://github.com/${repository.owner}/${repository.repo}.git`
    }
  ];
}

export function acquireGitHubRepositorySnapshotWithSystemGit(
  input: AcquireGitHubRepositorySnapshotWithSystemGitInput
): Promise<
  Result<
    AcquiredGitHubRepositorySnapshot,
    AcquireGitRepositorySnapshotWithSystemGitError
  >
> {
  return acquireGitRepositorySnapshotWithSystemGit({
    ...input,
    remotes: gitHubSystemGitRemoteCandidates(input.repository)
  });
}

export async function acquireGitRepositorySnapshotWithSystemGit(
  input: AcquireGitRepositorySnapshotWithSystemGitInput
): Promise<
  Result<
    AcquiredGitHubRepositorySnapshot,
    AcquireGitRepositorySnapshotWithSystemGitError
  >
> {
  const gitExecutable = input.gitExecutable ?? "git";
  if (input.signal?.aborted) {
    return unavailable(input, "initialize", "aborted");
  }

  let root: string;
  try {
    root = await mkdtemp(join(tmpdir(), "skiloom-system-git-"));
  } catch {
    return unavailable(input, "initialize", "local-io");
  }

  const gitDirectory = join(root, "repository.git");
  try {
    const initialized = await runGit({
      executable: gitExecutable,
      args: ["init", "--bare", gitDirectory],
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (!initialized.ok) {
      return commandFailure(
        input,
        "initialize",
        initialized,
        "local-io"
      );
    }

    let fetched = false;
    for (const remote of input.remotes) {
      const result = await runGit({
        executable: gitExecutable,
        args: [
          ...remoteGitConfig(remote),
          "--git-dir",
          gitDirectory,
          "fetch",
          "--force",
          "--no-tags",
          "--depth=1",
          "--",
          remote.url,
          input.requestedRef
        ],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        environment: remoteEnvironment(remote)
      });
      if (result.ok) {
        fetched = true;
        break;
      }
      if (
        result.reason === "git-unavailable" ||
        result.reason === "aborted"
      ) {
        return commandFailure(
          input,
          "fetch",
          result,
          "access-unavailable"
        );
      }
    }
    if (!fetched) {
      return unavailable(input, "fetch", "access-unavailable");
    }

    const resolved = await runGit({
      executable: gitExecutable,
      args: [
        "--git-dir",
        gitDirectory,
        "rev-parse",
        "--verify",
        "FETCH_HEAD^{commit}"
      ],
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (!resolved.ok) {
      return commandFailure(
        input,
        "resolve-ref",
        resolved,
        "invalid-response"
      );
    }
    const exactCommit = resolved.stdout.toString("utf8").trim();
    if (!EXACT_COMMIT_PATTERN.test(exactCommit)) {
      return unavailable(input, "resolve-ref", "invalid-response");
    }

    if (input.sourceCachePath !== undefined) {
      const cached = await readCachedExactGitHubRepositorySnapshot({
        cacheRoot: input.sourceCachePath,
        repository: input.repository,
        exactCommit
      });
      if (cached !== undefined) {
        return { ok: true, value: cached };
      }
    }

    const listed = await runGit({
      executable: gitExecutable,
      args: [
        "--git-dir",
        gitDirectory,
        "ls-tree",
        "-rz",
        "--full-tree",
        exactCommit
      ],
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (!listed.ok) {
      return commandFailure(
        input,
        "read-tree",
        listed,
        "invalid-response"
      );
    }

    const parsed = parseTree(
      input.repository,
      listed.stdout
    );
    if (!parsed.ok) {
      return parsed;
    }

    const entries: RepositorySnapshotEntry[] = [];
    for (const treeEntry of parsed.value) {
      if (treeEntry.fileType === "symlink") {
        entries.push({
          pathBytes: treeEntry.pathBytes,
          fileType: "symlink"
        });
        continue;
      }

      const blob = await runGit({
        executable: gitExecutable,
        args: [
          "--git-dir",
          gitDirectory,
          "cat-file",
          "blob",
          treeEntry.sha
        ],
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      if (!blob.ok) {
        return commandFailure(
          input,
          "read-blob",
          blob,
          "invalid-response"
        );
      }
      entries.push({
        pathBytes: treeEntry.pathBytes,
        fileType: "regular",
        gitMode: treeEntry.gitMode,
        content: Uint8Array.from(blob.stdout)
      });
    }

    entries.sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.pathBytes),
        Buffer.from(right.pathBytes)
      )
    );

    const snapshot: AcquiredGitHubRepositorySnapshot = {
      repository: input.repository,
      exactCommit,
      entries
    };
    if (input.sourceCachePath !== undefined) {
      await writeCachedExactGitHubRepositorySnapshot(
        input.sourceCachePath,
        snapshot
      );
    }
    return { ok: true, value: snapshot };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

type ParsedTreeEntry =
  | Readonly<{
      pathBytes: Uint8Array;
      fileType: "regular";
      gitMode: "100644" | "100755";
      sha: string;
    }>
  | Readonly<{
      pathBytes: Uint8Array;
      fileType: "symlink";
      sha: string;
    }>;

function parseTree(
  repository: RepositoryCoordinate,
  source: Buffer
): Result<
  ReadonlyArray<ParsedTreeEntry>,
  GitHubSystemGitUnavailable | UnsupportedGitTreeEntry
> {
  const entries: ParsedTreeEntry[] = [];
  let offset = 0;

  while (offset < source.length) {
    const nul = source.indexOf(0, offset);
    if (nul < 0) {
      return invalidTree(repository);
    }
    const record = source.subarray(offset, nul);
    offset = nul + 1;

    const tab = record.indexOf(0x09);
    if (tab < 0) {
      return invalidTree(repository);
    }
    const metadata = record.subarray(0, tab).toString("ascii");
    const pathBytes = Uint8Array.from(record.subarray(tab + 1));
    const [mode, type, sha, extra] = metadata.split(" ");
    if (
      extra !== undefined ||
      mode === undefined ||
      type === undefined ||
      sha === undefined ||
      pathBytes.length === 0 ||
      !EXACT_COMMIT_PATTERN.test(sha)
    ) {
      return invalidTree(repository);
    }

    if (
      type === "blob" &&
      (mode === "100644" || mode === "100755")
    ) {
      entries.push({
        pathBytes,
        fileType: "regular",
        gitMode: mode,
        sha
      });
      continue;
    }
    if (type === "blob" && mode === "120000") {
      entries.push({
        pathBytes,
        fileType: "symlink",
        sha
      });
      continue;
    }

    return {
      ok: false,
      error: productError("UnsupportedGitTreeEntry", {
        repositoryCoordinate: repository.canonical,
        path: Buffer.from(pathBytes).toString("utf8"),
        mode,
        type
      })
    };
  }

  return { ok: true, value: entries };
}

function invalidTree(
  repository: RepositoryCoordinate
): Result<never, GitHubSystemGitUnavailable> {
  return {
    ok: false,
    error: productError("GitHubSystemGitUnavailable", {
      repositoryCoordinate: repository.canonical,
      operation: "read-tree",
      reason: "invalid-response"
    })
  };
}

type GitCommandFailureReason =
  | "git-unavailable"
  | "command-failed"
  | "aborted";

type GitCommandResult =
  | Readonly<{ ok: true; stdout: Buffer }>
  | Readonly<{
      ok: false;
      reason: GitCommandFailureReason;
    }>;

type RunGitInput = Readonly<{
  executable: string;
  args: ReadonlyArray<string>;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

function runGit(input: RunGitInput): Promise<GitCommandResult> {
  if (input.signal?.aborted) {
    return Promise.resolve({ ok: false, reason: "aborted" });
  }

  return new Promise((resolveResult) => {
    let settled = false;
    let child;
    try {
      child = spawn(input.executable, [...input.args], {
        env: input.environment ?? nonInteractiveGitEnvironment(),
        signal: input.signal,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      });
    } catch {
      resolveResult({ ok: false, reason: "git-unavailable" });
      return;
    }

    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk));
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveResult({
        ok: false,
        reason:
          error.name === "AbortError"
            ? "aborted"
            : error.code === "ENOENT"
              ? "git-unavailable"
              : "command-failed"
      });
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveResult(
        code === 0 && signal === null
          ? {
              ok: true,
              stdout: Buffer.concat(stdout)
            }
          : {
              ok: false,
              reason: input.signal?.aborted
                ? "aborted"
                : "command-failed"
            }
      );
    });
  });
}

function remoteGitConfig(
  remote: GitHubSystemGitRemoteCandidate
): ReadonlyArray<string> {
  return remote.kind === "https"
    ? [
        "-c",
        "credential.helper=",
        "-c",
        "core.askPass="
      ]
    : [];
}

function remoteEnvironment(
  _remote: GitHubSystemGitRemoteCandidate
): NodeJS.ProcessEnv {
  return nonInteractiveGitEnvironment();
}

function nonInteractiveGitEnvironment(): NodeJS.ProcessEnv {
  const {
    GH_TOKEN: _ghToken,
    GITHUB_TOKEN: _githubToken,
    ...ambient
  } = process.env;
  const configuredSshCommand = process.env.GIT_SSH_COMMAND?.trim();
  return {
    ...ambient,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_SSH_COMMAND:
      (configuredSshCommand === undefined ||
      configuredSshCommand.length === 0
        ? "ssh"
        : configuredSshCommand) +
      " -o BatchMode=yes -o StrictHostKeyChecking=yes"
  };
}

function commandFailure(
  input: AcquireGitRepositorySnapshotWithSystemGitInput,
  operation: GitHubSystemGitOperation,
  failure: Exclude<GitCommandResult, { ok: true }>,
  fallback: GitHubSystemGitUnavailable["facts"]["reason"]
): Result<never, GitHubSystemGitUnavailable> {
  return unavailable(
    input,
    operation,
    failure.reason === "git-unavailable"
      ? "git-unavailable"
      : failure.reason === "aborted"
        ? "aborted"
        : fallback
  );
}

function unavailable(
  input: Pick<
    AcquireGitRepositorySnapshotWithSystemGitInput,
    "repository"
  >,
  operation: GitHubSystemGitOperation,
  reason: GitHubSystemGitUnavailable["facts"]["reason"]
): Result<never, GitHubSystemGitUnavailable> {
  return {
    ok: false,
    error: productError("GitHubSystemGitUnavailable", {
      repositoryCoordinate: input.repository.canonical,
      operation,
      reason
    })
  };
}
