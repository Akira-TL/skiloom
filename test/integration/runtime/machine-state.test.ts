import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createPackageSnapshot } from "../../../src/domain/snapshot/index.js";
import {
  acquireOperationLock,
  type OperationLockSession
} from "../../../src/native/skiloom-lock.js";
import { resolveSkiloomHomePaths, type SkiloomHomePaths } from "../../../src/runtime/home.js";
import { openMachineRegistry as openRawMachineRegistry } from "../../../src/runtime/registry/database.js";
import {
  createRegistryBackup,
  openMachineRegistry,
  restoreRegistryBackup,
  type RegistryTargetStateInput
} from "../../../src/runtime/registry/index.js";
import { publishPackageSnapshot, verifyPackageStoreEntry } from "../../../src/runtime/store.js";

const helperExecutable = requiredHelperExecutable();

test("older recognized Registry migrates under the real lock after a verifiable pre-migration backup", async () => {
  await withTempHome(async (paths) => {
    const state = minimalState("migration-target", fixedDigest("a"));
    seedRawState(paths, state);
    setUserVersion(paths.registryPath, 0);

    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      try {
        const pragmas = opened.value.pragmas();
        assert.equal(pragmas.ok, true);
        if (pragmas.ok) {
          assert.equal(pragmas.value.userVersion, 1);
        }
        const readback = opened.value.readTargetState(state.targetId);
        assert.equal(readback.ok, true);
        if (readback.ok) {
          assert.equal(readback.value?.generation, 1);
        }
      } finally {
        opened.value.close();
      }

      const backups = await readdir(paths.backupsPath);
      assert.equal(backups.length, 1);
      const backupPath = join(paths.backupsPath, backups[0]!);
      const backupDb = new DatabaseSync(backupPath, { readOnly: true });
      try {
        assert.equal(pragmaNumber(backupDb, "user_version"), 0);
        assert.equal(firstValue(backupDb.prepare("PRAGMA quick_check").get()), "ok");
      } finally {
        backupDb.close();
      }
    });
  });
});

test("migration failure preserves schema version and the pre-migration backup", async () => {
  await withTempHome(async (paths) => {
    seedRawState(paths, minimalState("failed-migration-target", fixedDigest("b")));
    const database = new DatabaseSync(paths.registryPath, {
      enableForeignKeyConstraints: false
    });
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("PRAGMA user_version = 0");
      database.prepare(`
        INSERT INTO resolved_packages(
          target_id, package_coordinate, repository_coordinate, package_root, content_digest
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        "failed-migration-target",
        "missing/repo/pkg",
        "missing/repo",
        ".",
        fixedDigest("c")
      );
    } finally {
      database.close();
    }

    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      if (opened.ok) {
        opened.value.close();
        assert.fail("migration with foreign-key violations must fail");
      }
      assert.equal(opened.error.code, "RegistryMigrationFailed");
      if (opened.error.code !== "RegistryMigrationFailed") {
        return;
      }
      assert.equal(opened.error.facts.reason, "foreign-key-violation");

      const live = new DatabaseSync(paths.registryPath, { readOnly: true });
      try {
        assert.equal(pragmaNumber(live, "user_version"), 0);
      } finally {
        live.close();
      }

      const backup = new DatabaseSync(opened.error.facts.backupPath, { readOnly: true });
      try {
        assert.equal(pragmaNumber(backup, "user_version"), 0);
        assert.equal(firstValue(backup.prepare("PRAGMA quick_check").get()), "ok");
      } finally {
        backup.close();
      }
    });
  });
});

test("unknown legacy schema fails closed instead of guessing a migration", async () => {
  await withTempHome(async (paths) => {
    await mkdir(paths.homeRoot, { recursive: true });
    const database = new DatabaseSync(paths.registryPath);
    try {
      database.exec("CREATE TABLE legacy_unknown(value TEXT NOT NULL)");
      database.exec("INSERT INTO legacy_unknown(value) VALUES ('preserve-me')");
      database.exec("PRAGMA user_version = 0");
    } finally {
      database.close();
    }

    await withRealLock(paths, async (lock) => {
      const opened = await openMachineRegistry(paths, lock);
      assert.deepEqual(opened, {
        ok: false,
        error: {
          code: "RegistryMigrationUnsupported",
          facts: { actualVersion: 0, currentVersion: 1 }
        }
      });
    });

    const preserved = new DatabaseSync(paths.registryPath, { readOnly: true });
    try {
      assert.equal(
        firstValue(preserved.prepare("SELECT value FROM legacy_unknown").get()),
        "preserve-me"
      );
      assert.equal(pragmaNumber(preserved, "user_version"), 0);
    } finally {
      preserved.close();
    }
  });
});

test("too-new and corrupt Registries fail closed without replacing database bytes", async () => {
  await withTempHome(async (paths) => {
    seedRawState(paths, minimalState("too-new-target", fixedDigest("d")));
    setUserVersion(paths.registryPath, 2);

    await withRealLock(paths, async (lock) => {
      const tooNew = await openMachineRegistry(paths, lock);
      assert.equal(tooNew.ok, false);
      if (!tooNew.ok) {
        assert.deepEqual(tooNew.error, {
          code: "RegistrySchemaTooNew",
          facts: { actualVersion: 2, currentVersion: 1 }
        });
      }
    });
  });

  await withTempHome(async (paths) => {
    const corruptBytes = Buffer.from("not-a-sqlite-registry\u0000still-not-sqlite", "utf8");
    await mkdir(paths.homeRoot, { recursive: true });
    await writeFile(paths.registryPath, corruptBytes);

    await withRealLock(paths, async (lock) => {
      const corrupt = await openMachineRegistry(paths, lock);
      assert.equal(corrupt.ok, false);
      if (!corrupt.ok) {
        assert.equal(corrupt.error.code, "RegistryCorrupt");
      }
      assert.deepEqual(await readFile(paths.registryPath), corruptBytes);
    });
  });
});

test("explicit backup and restore preserve the accepted Registry state under one real lock session", async () => {
  await withTempHome(async (paths) => {
    await withRealLock(paths, async (lock) => {
      const initial = minimalState("restore-target", fixedDigest("e"));
      const first = await openMachineRegistry(paths, lock);
      assert.equal(first.ok, true);
      if (!first.ok) {
        return;
      }
      const written = first.value.replaceTargetState(initial);
      assert.equal(written.ok, true);
      first.value.close();

      const backup = await createRegistryBackup(paths, lock);
      assert.equal(backup.ok, true);
      if (!backup.ok) {
        return;
      }

      const changed = minimalState("restore-target", fixedDigest("f"));
      const second = await openMachineRegistry(paths, lock);
      assert.equal(second.ok, true);
      if (!second.ok) {
        return;
      }
      const changedWrite = second.value.replaceTargetState(changed);
      assert.equal(changedWrite.ok, true);
      if (changedWrite.ok) {
        assert.equal(changedWrite.value.generation, 2);
      }
      second.value.close();

      const restored = await restoreRegistryBackup(paths, backup.value.path, lock);
      assert.deepEqual(restored, { ok: true, value: undefined });

      const third = await openMachineRegistry(paths, lock);
      assert.equal(third.ok, true);
      if (!third.ok) {
        return;
      }
      try {
        const readback = third.value.readTargetState(initial.targetId);
        assert.equal(readback.ok, true);
        if (readback.ok) {
          assert.equal(readback.value?.generation, 1);
          assert.equal(readback.value?.resolvedPackages[0]?.contentDigest, fixedDigest("e"));
        }
      } finally {
        third.value.close();
      }
    });
  });
});

test("Store-verified candidate state persists under the real lock without Target materialization", async () => {
  await withTempHome(async (paths) => {
    await withRealLock(paths, async (lock) => {
      const snapshot = createPackageSnapshot([
        {
          path: "SKILL.md",
          executable: false,
          content: Buffer.from("---\nname: demo\ndescription: Machine-state fixture.\n---\n", "utf8")
        }
      ]);
      assert.equal(snapshot.ok, true);
      if (!snapshot.ok) {
        return;
      }

      const published = await publishPackageSnapshot(paths, snapshot.value);
      assert.equal(published.ok, true);
      if (!published.ok) {
        return;
      }
      const verified = await verifyPackageStoreEntry(paths, snapshot.value.contentDigest);
      assert.equal(verified.ok, true);
      if (!verified.ok) {
        return;
      }

      const targetPath = join(paths.userHome, "target-must-not-be-created");
      const state: RegistryTargetStateInput = {
        targetId: "store-candidate-target",
        locations: [{ path: targetPath, observedGeneration: null }],
        directRequirements: [
          {
            kind: "package",
            coordinate: "acme/demo/demo",
            sourceKind: "github-release",
            versionRequirement: "^1"
          }
        ],
        resolvedSources: [
          {
            repositoryCoordinate: "acme/demo",
            sourceKind: "github-release",
            version: "1.0.0",
            actualTag: "v1.0.0",
            exactCommit: "1111111111111111111111111111111111111111",
            immutable: true
          }
        ],
        resolvedPackages: [
          {
            packageCoordinate: "acme/demo/demo",
            repositoryCoordinate: "acme/demo",
            packageRoot: ".",
            contentDigest: verified.value.contentDigest
          }
        ],
        dependencyEdges: [],
        projections: [],
        detachedBaselines: [],
        dependencyObservations: []
      };

      const opened = await openMachineRegistry(paths, lock);
      assert.equal(opened.ok, true);
      if (!opened.ok) {
        return;
      }
      try {
        const write = opened.value.replaceTargetState(state);
        assert.equal(write.ok, true);
        const readback = opened.value.readTargetState(state.targetId);
        assert.equal(readback.ok, true);
        if (readback.ok) {
          assert.equal(
            readback.value?.resolvedPackages[0]?.contentDigest,
            snapshot.value.contentDigest
          );
        }
      } finally {
        opened.value.close();
      }

      await assert.rejects(readFile(targetPath));
    });
  });
});

test("post-acquisition helper loss prevents later protected Registry side effects", async () => {
  await withTempHome(async (paths) => {
    await mkdir(paths.homeRoot, { recursive: true });
    const acquired = await acquireOperationLock({
      helperExecutable,
      lockPath: paths.operationLockPath
    });
    assert.equal(acquired.ok, true);
    if (!acquired.ok) {
      return;
    }

    const opened = await openMachineRegistry(paths, acquired.value);
    assert.equal(opened.ok, true);
    if (!opened.ok) {
      await acquired.value.release();
      return;
    }

    const pid = requireHelperPid(acquired.value);
    process.kill(pid);
    const lost = await withTimeout(
      acquired.value.waitForLoss(),
      5_000,
      "machine-state operation lock loss"
    );
    assert.equal(lost.code, "OperationLockLost");

    const blocked = opened.value.replaceTargetState(
      minimalState("must-not-commit", fixedDigest("9"))
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.error.code, "OperationLockLost");
    }
    opened.value.close();

    const raw = openRawMachineRegistry(paths);
    assert.equal(raw.ok, true);
    if (raw.ok) {
      try {
        assert.equal(raw.value.readTargetState("must-not-commit"), undefined);
      } finally {
        raw.value.close();
      }
    }
  });
});

function minimalState(targetId: string, contentDigest: string): RegistryTargetStateInput {
  return {
    targetId,
    locations: [],
    directRequirements: [
      {
        kind: "package",
        coordinate: "acme/demo/demo",
        sourceKind: "github-release",
        versionRequirement: "^1"
      }
    ],
    resolvedSources: [
      {
        repositoryCoordinate: "acme/demo",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit: "1111111111111111111111111111111111111111",
        immutable: true
      }
    ],
    resolvedPackages: [
      {
        packageCoordinate: "acme/demo/demo",
        repositoryCoordinate: "acme/demo",
        packageRoot: ".",
        contentDigest
      }
    ],
    dependencyEdges: [],
    projections: [],
    detachedBaselines: [],
    dependencyObservations: []
  };
}

function seedRawState(paths: SkiloomHomePaths, state: RegistryTargetStateInput): void {
  const opened = openRawMachineRegistry(paths);
  if (!opened.ok) {
    throw new Error(opened.error.code);
  }
  try {
    const written = opened.value.replaceTargetState(state);
    assert.equal(written.ok, true);
  } finally {
    opened.value.close();
  }
}

function setUserVersion(registryPath: string, version: number): void {
  const database = new DatabaseSync(registryPath);
  try {
    database.exec(`PRAGMA user_version = ${version}`);
  } finally {
    database.close();
  }
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const value = firstValue(database.prepare(`PRAGMA ${name}`).get());
  if (typeof value !== "number") {
    throw new Error(`invalid pragma ${name}`);
  }
  return value;
}

function firstValue(row: Record<string, unknown> | undefined): unknown {
  return row === undefined ? undefined : Object.values(row)[0];
}

function fixedDigest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function requiredHelperExecutable(): string {
  const configured = process.env.SKILOOM_LOCK_TEST_BINARY;
  if (configured === undefined || configured.length === 0) {
    throw new Error("SKILOOM_LOCK_TEST_BINARY must point to a real skiloom-lock executable");
  }
  return resolve(configured);
}

function requireHelperPid(session: OperationLockSession): number {
  const pid = session.helperPid;
  if (pid === undefined) {
    throw new Error("operation-lock helper has no pid after acquisition");
  }
  return pid;
}

async function withRealLock(
  paths: SkiloomHomePaths,
  run: (lock: OperationLockSession) => Promise<void>
): Promise<void> {
  await mkdir(paths.homeRoot, { recursive: true });
  const acquired = await acquireOperationLock({
    helperExecutable,
    lockPath: paths.operationLockPath
  });
  assert.equal(acquired.ok, true);
  if (!acquired.ok) {
    return;
  }
  try {
    await run(acquired.value);
  } finally {
    if (acquired.value.held) {
      assert.deepEqual(await acquired.value.release(), { ok: true, value: undefined });
    }
  }
}

async function withTempHome(run: (paths: SkiloomHomePaths) => Promise<void>): Promise<void> {
  const userHome = await mkdtemp(join(tmpdir(), "skiloom-machine-state-"));
  try {
    await run(resolveSkiloomHomePaths(userHome));
  } finally {
    await rm(userHome, { recursive: true, force: true });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
