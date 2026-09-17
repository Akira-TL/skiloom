import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync, type SQLOutputValue } from "node:sqlite";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../native/skiloom-lock.js";
import type { SkiloomHomePaths } from "../home.js";
import {
  configureRegistryConnection,
  CURRENT_REGISTRY_SCHEMA_VERSION,
  initializeRegistrySchema
} from "./schema.js";

export type RegistrySchemaTooNew = ProductError<
  "RegistrySchemaTooNew",
  Readonly<{
    actualVersion: number;
    currentVersion: number;
  }>
>;

export type RegistryMigrationUnsupported = ProductError<
  "RegistryMigrationUnsupported",
  Readonly<{
    actualVersion: number;
    currentVersion: number;
  }>
>;

export type RegistryMigrationFailed = ProductError<
  "RegistryMigrationFailed",
  Readonly<{
    fromVersion: number;
    toVersion: number;
    backupPath: string;
    reason: "foreign-key-violation" | "step-failed";
  }>
>;

export type RegistryCorrupt = ProductError<
  "RegistryCorrupt",
  Readonly<{
    reason: "integrity-check" | "schema-shape" | "foreign-key-violation";
  }>
>;

export type RegistryBackupFailed = ProductError<
  "RegistryBackupFailed",
  Readonly<{
    reason: "registry-missing" | "backup-failed" | "backup-invalid";
  }>
>;

export type RegistryRestoreFailed = ProductError<
  "RegistryRestoreFailed",
  Readonly<{
    reason: "backup-invalid" | "restore-failed";
  }>
>;

export type RegistryBackupInfo = Readonly<{
  path: string;
  schemaVersion: number;
}>;

export type RegistryMaintenanceError =
  | OperationLockLost
  | RegistrySchemaTooNew
  | RegistryMigrationUnsupported
  | RegistryMigrationFailed
  | RegistryCorrupt
  | RegistryBackupFailed;

export type RegistryRestoreError =
  | OperationLockLost
  | RegistryCorrupt
  | RegistryRestoreFailed;

const CURRENT_TABLES = [
  "dependency_edges",
  "dependency_observations",
  "detached_baselines",
  "direct_requirements",
  "pending_operations",
  "pending_projection_actions",
  "projections",
  "resolved_packages",
  "resolved_sources",
  "target_locations",
  "targets"
] as const;

let canonicalSchemaSql: ReadonlyMap<string, string> | undefined;

export async function prepareMachineRegistry(
  paths: SkiloomHomePaths,
  lock: OperationLockSession
): Promise<Result<void, RegistryMaintenanceError>> {
  const held = lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  await mkdir(paths.homeRoot, { recursive: true });
  let database: DatabaseSync;
  try {
    database = openDatabase(paths.registryPath);
  } catch (error) {
    if (isCorruptionError(error)) {
      return { ok: false, error: registryCorrupt("integrity-check") };
    }
    throw error;
  }

  try {
    configureRegistryConnection(database);
    const integrity = verifyQuickCheck(database);
    if (!integrity.ok) {
      return integrity;
    }

    let version = pragmaNumber(database, "user_version");
    const tableCount = userTableNames(database).length;
    if (version === 0 && tableCount === 0) {
      const stillHeld = lock.checkHeld();
      if (!stillHeld.ok) {
        return stillHeld;
      }
      initializeRegistrySchema(database);
      return verifyCurrentRegistry(database);
    }

    if (version > CURRENT_REGISTRY_SCHEMA_VERSION) {
      return {
        ok: false,
        error: productError("RegistrySchemaTooNew", {
          actualVersion: version,
          currentVersion: CURRENT_REGISTRY_SCHEMA_VERSION
        })
      };
    }

    if (version === CURRENT_REGISTRY_SCHEMA_VERSION) {
      return verifyCurrentRegistry(database);
    }

    if (version !== 0 || !hasCurrentSchemaShape(database)) {
      return {
        ok: false,
        error: productError("RegistryMigrationUnsupported", {
          actualVersion: version,
          currentVersion: CURRENT_REGISTRY_SCHEMA_VERSION
        })
      };
    }

    const backupResult = await backupOpenRegistry(
      database,
      paths,
      version,
      `migration-v${version}-to-v${CURRENT_REGISTRY_SCHEMA_VERSION}`
    );
    if (!backupResult.ok) {
      return backupResult;
    }

    const afterBackup = lock.checkHeld();
    if (!afterBackup.ok) {
      return afterBackup;
    }

    while (version < CURRENT_REGISTRY_SCHEMA_VERSION) {
      if (version !== 0) {
        return {
          ok: false,
          error: productError("RegistryMigrationUnsupported", {
            actualVersion: version,
            currentVersion: CURRENT_REGISTRY_SCHEMA_VERSION
          })
        };
      }

      const step = migrateZeroToOne(database, backupResult.value.path);
      if (!step.ok) {
        return step;
      }
      version = pragmaNumber(database, "user_version");
    }

    const finalHeld = lock.checkHeld();
    if (!finalHeld.ok) {
      return finalHeld;
    }
    return verifyCurrentRegistry(database);
  } catch (error) {
    if (isCorruptionError(error)) {
      return { ok: false, error: registryCorrupt("integrity-check") };
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function createRegistryBackup(
  paths: SkiloomHomePaths,
  lock: OperationLockSession
): Promise<Result<RegistryBackupInfo, OperationLockLost | RegistryCorrupt | RegistryBackupFailed>> {
  const held = lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(paths.registryPath, { readOnly: true });
  } catch (error) {
    if (isMissingDatabaseError(error)) {
      return {
        ok: false,
        error: productError("RegistryBackupFailed", { reason: "registry-missing" })
      };
    }
    if (isCorruptionError(error)) {
      return { ok: false, error: registryCorrupt("integrity-check") };
    }
    throw error;
  }

  try {
    const integrity = verifyQuickCheck(database);
    if (!integrity.ok) {
      return integrity;
    }
    const version = pragmaNumber(database, "user_version");
    return await backupOpenRegistry(database, paths, version, "explicit");
  } finally {
    database.close();
  }
}

export async function restoreRegistryBackup(
  paths: SkiloomHomePaths,
  backupPath: string,
  lock: OperationLockSession
): Promise<Result<void, RegistryRestoreError>> {
  const held = lock.checkHeld();
  if (!held.ok) {
    return held;
  }

  let source: DatabaseSync;
  try {
    source = new DatabaseSync(backupPath, { readOnly: true });
  } catch (error) {
    if (isCorruptionError(error) || isMissingDatabaseError(error)) {
      return {
        ok: false,
        error: productError("RegistryRestoreFailed", { reason: "backup-invalid" })
      };
    }
    throw error;
  }

  try {
    const sourceIntegrity = verifyRegistryImage(source);
    if (!sourceIntegrity) {
      return {
        ok: false,
        error: productError("RegistryRestoreFailed", { reason: "backup-invalid" })
      };
    }

    const beforeRestore = lock.checkHeld();
    if (!beforeRestore.ok) {
      return beforeRestore;
    }

    await rm(`${paths.registryPath}-wal`, { force: true });
    await rm(`${paths.registryPath}-shm`, { force: true });
    try {
      await backup(source, paths.registryPath);
    } catch {
      return {
        ok: false,
        error: productError("RegistryRestoreFailed", { reason: "restore-failed" })
      };
    }

    const afterRestore = lock.checkHeld();
    if (!afterRestore.ok) {
      return afterRestore;
    }
  } finally {
    source.close();
  }

  let restored: DatabaseSync;
  try {
    restored = new DatabaseSync(paths.registryPath, { readOnly: true });
  } catch {
    return {
      ok: false,
      error: productError("RegistryRestoreFailed", { reason: "restore-failed" })
    };
  }
  try {
    if (!verifyRegistryImage(restored)) {
      return {
        ok: false,
        error: productError("RegistryRestoreFailed", { reason: "restore-failed" })
      };
    }
  } finally {
    restored.close();
  }

  return { ok: true, value: undefined };
}

async function backupOpenRegistry(
  database: DatabaseSync,
  paths: SkiloomHomePaths,
  schemaVersion: number,
  label: string
): Promise<Result<RegistryBackupInfo, RegistryBackupFailed>> {
  await mkdir(paths.backupsPath, { recursive: true });
  const path = join(
    paths.backupsPath,
    `registry-${label}-${randomUUID()}.sqlite3`
  );
  try {
    await backup(database, path);
  } catch {
    return {
      ok: false,
      error: productError("RegistryBackupFailed", { reason: "backup-failed" })
    };
  }

  let verification: DatabaseSync;
  try {
    verification = new DatabaseSync(path, { readOnly: true });
  } catch {
    return {
      ok: false,
      error: productError("RegistryBackupFailed", { reason: "backup-invalid" })
    };
  }
  try {
    if (!verifyQuickCheck(verification).ok) {
      return {
        ok: false,
        error: productError("RegistryBackupFailed", { reason: "backup-invalid" })
      };
    }
  } finally {
    verification.close();
    await removeSqliteSidecars(path);
  }

  return { ok: true, value: { path, schemaVersion } };
}

function migrateZeroToOne(
  database: DatabaseSync,
  backupPath: string
): Result<void, RegistryMigrationFailed> {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (foreignKeyViolationCount(database) !== 0) {
      throw new MigrationStepError("foreign-key-violation");
    }
    database.exec("PRAGMA user_version = 1");
    database.exec("COMMIT");
    return { ok: true, value: undefined };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure that caused rollback.
    }
    return {
      ok: false,
      error: productError("RegistryMigrationFailed", {
        fromVersion: 0,
        toVersion: 1,
        backupPath,
        reason:
          error instanceof MigrationStepError
            ? error.reason
            : "step-failed"
      })
    };
  }
}

function verifyRegistryImage(database: DatabaseSync): boolean {
  const quick = verifyQuickCheck(database);
  if (!quick.ok) {
    return false;
  }
  const version = pragmaNumber(database, "user_version");
  if (version !== 0 && version !== CURRENT_REGISTRY_SCHEMA_VERSION) {
    return false;
  }
  return hasCurrentSchemaShape(database) && foreignKeyViolationCount(database) === 0;
}

function verifyCurrentRegistry(
  database: DatabaseSync
): Result<void, RegistryCorrupt> {
  const quick = verifyQuickCheck(database);
  if (!quick.ok) {
    return quick;
  }
  if (!hasCurrentSchemaShape(database)) {
    return { ok: false, error: registryCorrupt("schema-shape") };
  }
  if (foreignKeyViolationCount(database) !== 0) {
    return { ok: false, error: registryCorrupt("foreign-key-violation") };
  }
  return { ok: true, value: undefined };
}

function verifyQuickCheck(database: DatabaseSync): Result<void, RegistryCorrupt> {
  try {
    const rows = database.prepare("PRAGMA quick_check").all();
    if (
      rows.length !== 1 ||
      firstValue(rows[0]) !== "ok"
    ) {
      return { ok: false, error: registryCorrupt("integrity-check") };
    }
    return { ok: true, value: undefined };
  } catch (error) {
    if (isCorruptionError(error)) {
      return { ok: false, error: registryCorrupt("integrity-check") };
    }
    throw error;
  }
}

function hasCurrentSchemaShape(database: DatabaseSync): boolean {
  const actual = schemaSqlByName(database);
  const expected = currentSchemaSql();
  if (actual.size !== expected.size) {
    return false;
  }
  for (const name of CURRENT_TABLES) {
    if (actual.get(name) !== expected.get(name)) {
      return false;
    }
  }
  return true;
}

function currentSchemaSql(): ReadonlyMap<string, string> {
  if (canonicalSchemaSql !== undefined) {
    return canonicalSchemaSql;
  }
  const database = new DatabaseSync(":memory:");
  try {
    initializeRegistrySchema(database);
    canonicalSchemaSql = schemaSqlByName(database);
    return canonicalSchemaSql;
  } finally {
    database.close();
  }
}

function schemaSqlByName(database: DatabaseSync): ReadonlyMap<string, string> {
  const rows = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all();
  const result = new Map<string, string>();
  for (const row of rows) {
    const name = fieldString(row, "name");
    const sql = fieldString(row, "sql");
    result.set(name, normalizeSql(sql));
  }
  return result;
}

function userTableNames(database: DatabaseSync): ReadonlyArray<string> {
  return database
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all()
    .map((row) => fieldString(row, "name"));
}

function foreignKeyViolationCount(database: DatabaseSync): number {
  return database.prepare("PRAGMA foreign_key_check").all().length;
}

function openDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 0
  });
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  const value = row === undefined ? undefined : firstValue(row);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid registry pragma: ${name}`);
  }
  return value;
}

function firstValue(row: Record<string, SQLOutputValue> | undefined): SQLOutputValue | undefined {
  return row === undefined ? undefined : Object.values(row)[0];
}

function fieldString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`invalid registry schema field: ${key}`);
  }
  return value;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

async function removeSqliteSidecars(path: string): Promise<void> {
  await rm(`${path}-wal`, { force: true });
  await rm(`${path}-shm`, { force: true });
}

function registryCorrupt(reason: RegistryCorrupt["facts"]["reason"]): RegistryCorrupt {
  return productError("RegistryCorrupt", { reason });
}

function isCorruptionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /file is not a database|database disk image is malformed|malformed|corrupt/iu.test(error.message)
  );
}

function isMissingDatabaseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ERR_SQLITE_CANTOPEN")
  );
}

class MigrationStepError extends Error {
  readonly reason: RegistryMigrationFailed["facts"]["reason"];

  constructor(reason: RegistryMigrationFailed["facts"]["reason"]) {
    super(reason);
    this.reason = reason;
  }
}
