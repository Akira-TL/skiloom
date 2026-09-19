import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  materializeVerifiedUserPayloadTree,
  scanUserPayloadTree
} from "../../../src/runtime/user-payload.js";

const digest =
  "sha256:d1e27eb593724bc5bee911f50c09d3214281e8b385232a7fbae0d2e74ec354e8";

test("user payload scanner observes deterministic bytes and POSIX executable semantics without following links", async () => {
  await withTemp(async (root) => {
    const source = join(root, "source");
    await mkdir(join(source, "bin"), { recursive: true });
    await writeFile(join(source, "bin", "run.sh"), "#!/bin/sh\n");
    await writeFile(join(source, "a.txt"), "A\n");
    if (process.platform !== "win32") {
      await chmod(join(source, "bin", "run.sh"), 0o755);
      await chmod(join(source, "a.txt"), 0o644);
    }

    const scanned = await scanUserPayloadTree(source);
    assert.equal(scanned.ok, true);
    if (!scanned.ok) {
      return;
    }
    assert.equal(scanned.value.contentDigest, digest);
    assert.equal(scanned.value.payloadId, `user:${digest}`);
    assert.deepEqual(
      scanned.value.entries.map((entry) => [
        entry.path,
        entry.executable,
        Buffer.from(entry.content).toString("utf8")
      ]),
      [
        ["a.txt", false, "A\n"],
        [
          "bin/run.sh",
          process.platform === "win32" ? false : true,
          "#!/bin/sh\n"
        ]
      ]
    );

    if (process.platform !== "win32") {
      await symlink("a.txt", join(source, "linked.txt"));
      const rejected = await scanUserPayloadTree(source);
      assert.equal(rejected.ok, false);
      if (!rejected.ok) {
        assert.equal(
          rejected.error.code,
          "UnsupportedUserPayloadEntry"
        );
        assert.equal(rejected.error.facts.path, "linked.txt");
        assert.equal(rejected.error.facts.fileType, "symlink");
      }
    }
  });
});

test("user payload scanner rejects raw invalid UTF-8 names before reading file content", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTemp(async (root) => {
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    const invalidPath = Buffer.concat([
      Buffer.from(source, "utf8"),
      Buffer.from("/"),
      Buffer.from([0xff])
    ]);
    await writeFile(invalidPath, "invalid-name\n");

    const scanned = await scanUserPayloadTree(source);
    assert.equal(scanned.ok, false);
    if (!scanned.ok) {
      assert.equal(
        scanned.error.code,
        "UserPayloadScanFailed"
      );
      assert.equal(
        scanned.error.facts.reason,
        "invalid-utf8-name"
      );
    }
  });
});

test("verified user payload materialization checks digest before creating destination and restores executable mode", async () => {
  await withTemp(async (root) => {
    const destination = join(root, "restored");
    const frames = [
      {
        path: "bin/run.sh",
        executable: true,
        content: Uint8Array.from(
          Buffer.from("#!/bin/sh\n", "utf8")
        )
      },
      {
        path: "a.txt",
        executable: false,
        content: Uint8Array.from(Buffer.from("A\n", "utf8"))
      }
    ];

    const corrupted = await materializeVerifiedUserPayloadTree({
      destinationRoot: destination,
      expectedDigest: digest,
      entries: frames.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              content: Uint8Array.from(
                Buffer.from("corrupt\n", "utf8")
              )
            }
          : entry
      )
    });
    assert.equal(corrupted.ok, false);
    if (!corrupted.ok) {
      assert.equal(
        corrupted.error.code,
        "UserPayloadDigestMismatch"
      );
    }
    await assert.rejects(lstat(destination));

    const restored = await materializeVerifiedUserPayloadTree({
      destinationRoot: destination,
      expectedDigest: digest,
      entries: frames
    });
    assert.equal(restored.ok, true);
    assert.equal(
      await readFile(join(destination, "a.txt"), "utf8"),
      "A\n"
    );
    assert.equal(
      await readFile(join(destination, "bin", "run.sh"), "utf8"),
      "#!/bin/sh\n"
    );
    if (process.platform !== "win32") {
      const executable = await lstat(
        join(destination, "bin", "run.sh")
      );
      const regular = await lstat(join(destination, "a.txt"));
      assert.notEqual(executable.mode & 0o111, 0);
      assert.equal(regular.mode & 0o111, 0);
    }
  });
});

test("user payload materialization stops before the next protected mutation when capability is lost", async () => {
  await withTemp(async (root) => {
    const destination = join(root, "capability-loss");
    let checks = 0;
    const result = await materializeVerifiedUserPayloadTree({
      destinationRoot: destination,
      expectedDigest: digest,
      entries: [
        {
          path: "a.txt",
          executable: false,
          content: Uint8Array.from(Buffer.from("A\n"))
        },
        {
          path: "bin/run.sh",
          executable: true,
          content: Uint8Array.from(Buffer.from("#!/bin/sh\n"))
        }
      ],
      checkMutationCapability: () => {
        checks += 1;
        return checks < 3
          ? { ok: true, value: undefined }
          : {
              ok: false,
              error: {
                code: "OperationLockLost",
                facts: {
                  lockPath: "/test/operation.lock",
                  reason: "session-not-held"
                }
              }
            };
      }
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "OperationLockLost");
    }
    await assert.rejects(lstat(destination));
  });
});

test("verified user payload materialization refuses an existing destination", async () => {
  await withTemp(async (root) => {
    const destination = join(root, "existing");
    await mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "keep\n");

    const result = await materializeVerifiedUserPayloadTree({
      destinationRoot: destination,
      expectedDigest: digest,
      entries: [
        {
          path: "a.txt",
          executable: false,
          content: Uint8Array.from(Buffer.from("A\n"))
        },
        {
          path: "bin/run.sh",
          executable: true,
          content: Uint8Array.from(Buffer.from("#!/bin/sh\n"))
        }
      ]
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.code,
        "UserPayloadDestinationExists"
      );
    }
    assert.equal(
      await readFile(join(destination, "keep.txt"), "utf8"),
      "keep\n"
    );
  });
});

async function withTemp(
  run: (root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skiloom-user-payload-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
