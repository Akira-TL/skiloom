import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildPackageSnapshot,
  type PackageSnapshot,
  type RepositorySnapshotEntry
} from "../../../src/domain/snapshot/index.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../../../src/runtime/home.js";
import {
  publishPackageSnapshot,
  verifyPackageStoreEntry
} from "../../../src/runtime/store.js";

type Fixture = Readonly<{
  fixtureVersion: 1;
  snapshot: Readonly<{
    entries: ReadonlyArray<Readonly<{
      path: string;
      executable: boolean;
      contentUtf8: string;
    }>>;
  }>;
}>;

test("Skiloom Home paths are rooted under the caller home", async () => {
  const userHome = join(tmpdir(), "skiloom-home-model");
  const paths = resolveSkiloomHomePaths(userHome);

  assert.deepEqual(paths, {
    userHome,
    homeRoot: join(userHome, ".skiloom"),
    registryPath: join(userHome, ".skiloom", "registry.sqlite3"),
    operationLockPath: join(userHome, ".skiloom", "operation.lock"),
    storePath: join(userHome, ".skiloom", "store"),
    sourceCachePath: join(userHome, ".skiloom", "cache", "sources"),
    backupsPath: join(userHome, ".skiloom", "backups")
  });
});

test("Package Store publishes, re-verifies, and reuses immutable content", async () => {
  await withTempHome(async (paths) => {
    const snapshot = await fixtureSnapshot();

    const published = await publishPackageSnapshot(paths, snapshot);
    assert.equal(published.ok, true);
    if (!published.ok) {
      return;
    }
    assert.equal(published.value.status, "published");
    assert.equal(published.value.contentDigest, snapshot.contentDigest);
    assert.equal(
      await readFile(join(published.value.payloadPath, "SKILL.md"), "utf8"),
      fixtureSkillMarkdown()
    );

    const verified = await verifyPackageStoreEntry(paths, snapshot.contentDigest);
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.value.contentDigest, snapshot.contentDigest);
      assert.deepEqual(
        verified.value.snapshot.entries.map((entry) => ({
          path: entry.path,
          executable: entry.executable,
          content: Buffer.from(entry.content).toString("utf8")
        })),
        snapshot.entries.map((entry) => ({
          path: entry.path,
          executable: entry.executable,
          content: Buffer.from(entry.content).toString("utf8")
        }))
      );
    }

    const reused = await publishPackageSnapshot(paths, snapshot);
    assert.equal(reused.ok, true);
    if (reused.ok) {
      assert.equal(reused.value.status, "existing");
      assert.equal(reused.value.payloadPath, published.value.payloadPath);
    }
  });
});

test("Package Store rejects an input snapshot whose claimed digest does not match its bytes", async () => {
  await withTempHome(async (paths) => {
    const snapshot = await fixtureSnapshot();
    const tampered = {
      ...snapshot,
      entries: snapshot.entries.map((entry, index) =>
        index === 0
          ? { ...entry, content: Buffer.from("tampered\n", "utf8") }
          : entry
      )
    } satisfies PackageSnapshot;

    const result = await publishPackageSnapshot(paths, tampered);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "PackageContentDigestMismatch");
      if (result.error.code === "PackageContentDigestMismatch") {
        assert.equal(result.error.facts.expectedDigest, snapshot.contentDigest);
        assert.notEqual(result.error.facts.actualDigest, snapshot.contentDigest);
      }
    }

    const missing = await verifyPackageStoreEntry(paths, snapshot.contentDigest);
    assert.deepEqual(missing, {
      ok: false,
      error: {
        code: "StoreEntryNotFound",
        facts: { contentDigest: snapshot.contentDigest }
      }
    });

    const storeNames = await readdir(paths.storePath).catch(() => [] as string[]);
    assert.deepEqual(storeNames, []);
  });
});

test("Package Store rejects a digest entry path that is replaced by a symlink", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows symlink creation is privilege-sensitive");
    return;
  }

  await withTempHome(async (paths) => {
    const snapshot = await fixtureSnapshot();
    const published = await publishPackageSnapshot(paths, snapshot);
    assert.equal(published.ok, true);
    if (!published.ok) {
      return;
    }

    const replacement = join(paths.homeRoot, "replacement-entry");
    await rm(published.value.entryPath, { recursive: true, force: true });
    await symlink(replacement, published.value.entryPath, "dir");

    const verified = await verifyPackageStoreEntry(paths, snapshot.contentDigest);
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.equal(verified.error.code, "CorruptStoreEntry");
      if (verified.error.code === "CorruptStoreEntry") {
        assert.equal(verified.error.facts.reason, "unsupported-store-entry-type");
      }
    }
  });
});

test("Package Store detects executable-mode drift in an existing entry", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows Store executable identity is represented by the private manifest");
    return;
  }

  await withTempHome(async (paths) => {
    const snapshot = await fixtureSnapshot();
    const published = await publishPackageSnapshot(paths, snapshot);
    assert.equal(published.ok, true);
    if (!published.ok) {
      return;
    }

    await chmod(join(published.value.payloadPath, "scripts", "run.sh"), 0o644);
    const verified = await verifyPackageStoreEntry(paths, snapshot.contentDigest);
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.equal(verified.error.code, "CorruptStoreEntry");
      if (verified.error.code === "CorruptStoreEntry") {
        assert.equal(verified.error.facts.reason, "content-digest-mismatch");
      }
    }
  });
});

test("Package Store fails closed when an existing immutable entry is corrupted", async () => {
  await withTempHome(async (paths) => {
    const snapshot = await fixtureSnapshot();
    const published = await publishPackageSnapshot(paths, snapshot);
    assert.equal(published.ok, true);
    if (!published.ok) {
      return;
    }

    await writeFile(
      join(published.value.payloadPath, "SKILL.md"),
      "corrupted after publication\n",
      "utf8"
    );

    const verified = await verifyPackageStoreEntry(paths, snapshot.contentDigest);
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.equal(verified.error.code, "CorruptStoreEntry");
      assert.equal(verified.error.facts.contentDigest, snapshot.contentDigest);
      assert.equal(verified.error.facts.reason, "content-digest-mismatch");
    }

    const republish = await publishPackageSnapshot(paths, snapshot);
    assert.equal(republish.ok, false);
    if (!republish.ok) {
      assert.equal(republish.error.code, "CorruptStoreEntry");
      assert.equal(republish.error.facts.contentDigest, snapshot.contentDigest);
    }

    await access(join(published.value.payloadPath, "SKILL.md"));
    assert.equal(
      await readFile(join(published.value.payloadPath, "SKILL.md"), "utf8"),
      "corrupted after publication\n"
    );
  });
});

async function fixtureSnapshot(): Promise<PackageSnapshot> {
  const fixture = await readFixture();
  const entries: RepositorySnapshotEntry[] = fixture.snapshot.entries.map((entry) => ({
    pathBytes: Buffer.from(entry.path, "utf8"),
    fileType: "regular",
    gitMode: entry.executable ? "100755" : "100644",
    content: Buffer.from(entry.contentUtf8, "utf8")
  }));
  const snapshot = buildPackageSnapshot({
    packageRoot: ".",
    discoveredPackageRoots: ["."],
    entries
  });
  if (!snapshot.ok) {
    throw new Error(`invalid Store fixture: ${snapshot.error.code}`);
  }
  return snapshot.value;
}

async function readFixture(): Promise<Fixture> {
  const raw = await readFile(
    join("behavior-fixtures", "store", "cases.json"),
    "utf8"
  );
  return JSON.parse(raw) as Fixture;
}

function fixtureSkillMarkdown(): string {
  return "---\nname: store-demo\ndescription: Package Store fixture\n---\n";
}

async function withTempHome(
  run: (paths: SkiloomHomePaths) => Promise<void>
): Promise<void> {
  const userHome = await mkdtemp(join(tmpdir(), "skiloom-store-"));
  try {
    await run(resolveSkiloomHomePaths(userHome));
  } finally {
    await rm(userHome, { recursive: true, force: true });
  }
}
