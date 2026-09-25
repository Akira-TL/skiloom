import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../../../src/domain/coordinate/index.js";
import {
  acquireGitRepositorySnapshotWithSystemGit,
  gitHubSystemGitRemoteCandidates
} from "../../../../../src/runtime/source/github/index.js";

test("GitHub system Git remote candidates prefer SSH before public HTTPS", () => {
  assert.deepEqual(
    gitHubSystemGitRemoteCandidates(repository("Akira-TL/Skiloom")),
    [
      {
        kind: "ssh",
        url: "git@github.com:akira-tl/skiloom.git"
      },
      {
        kind: "https",
        url: "https://github.com/akira-tl/skiloom.git"
      }
    ]
  );
});

test("system Git resolves a real ref and builds the canonical repository snapshot with fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "skiloom-system-git-"));
  const source = join(root, "source");
  try {
    await mkdir(source);
    await git(["init", "-b", "main"], source);
    await git(["config", "user.name", "Skiloom Test"], source);
    await git(["config", "user.email", "skiloom@example.invalid"], source);
    await mkdir(join(source, "bin"));
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: demo\ndescription: System Git fixture.\n---\n",
      "utf8"
    );
    await writeFile(join(source, "bin", "run.sh"), "#!/bin/sh\necho demo\n", "utf8");
    await chmod(join(source, "bin", "run.sh"), 0o755);
    await git(["add", "."], source);
    await git(["commit", "-m", "fixture"], source);
    const exactCommit = (await git(["rev-parse", "HEAD"], source)).trim();

    const acquired = await acquireGitRepositorySnapshotWithSystemGit({
      repository: repository("Acme/Demo"),
      requestedRef: "main",
      remotes: [
        {
          kind: "ssh",
          url: pathToFileURL(join(root, "missing.git")).href
        },
        {
          kind: "https",
          url: pathToFileURL(source).href
        }
      ]
    });

    assert.equal(acquired.ok, true);
    if (!acquired.ok) {
      return;
    }
    assert.equal(acquired.value.exactCommit, exactCommit);
    assert.equal(acquired.value.repository.canonical, "acme/demo");
    assert.deepEqual(
      acquired.value.entries.map((entry) => ({
        path: Buffer.from(entry.pathBytes).toString("utf8"),
        fileType: entry.fileType,
        ...(entry.fileType === "regular"
          ? {
              gitMode: entry.gitMode,
              content: Buffer.from(entry.content).toString("utf8")
            }
          : {})
      })),
      [
        {
          path: "SKILL.md",
          fileType: "regular",
          gitMode: "100644",
          content:
            "---\nname: demo\ndescription: System Git fixture.\n---\n"
        },
        {
          path: "bin/run.sh",
          fileType: "regular",
          gitMode: "100755",
          content: "#!/bin/sh\necho demo\n"
        }
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing system Git fails with a structured secret-safe error", async () => {
  const result = await acquireGitRepositorySnapshotWithSystemGit({
    repository: repository("Acme/Private"),
    requestedRef: "main",
    gitExecutable: "/definitely/missing/skiloom-git",
    remotes: [
      {
        kind: "ssh",
        url: "git@github.com:acme/private.git"
      }
    ]
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "GitHubSystemGitUnavailable",
      facts: {
        repositoryCoordinate: "acme/private",
        operation: "initialize",
        reason: "git-unavailable"
      }
    }
  });
});

function repository(input: string) {
  const parsed = parseRepositoryCoordinate(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    throw new Error("fixture repository coordinate must parse");
  }
  return parsed.value;
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            "git " + args.join(" ") + " failed: " + stderr.trim()
          )
        );
        return;
      }
      resolveResult(stdout);
    });
  });
}
