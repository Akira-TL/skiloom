import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import type { SkiloomHomePaths } from "../home.js";
import type {
  RegistryPendingOperation,
  RegistryPendingOperationInput,
  RegistryTargetState,
  RegistryTargetStateInput
} from "./model.js";
import { readPendingOperations as readPendingOperationRows, readTargetRows } from "./read.js";
import {
  configureRegistryConnection,
  CURRENT_REGISTRY_SCHEMA_VERSION,
  initializeRegistrySchema
} from "./schema.js";
import {
  beginPendingOperationRows,
  completePendingOperationRows,
  RegistryPendingOperationConflictError,
  replaceTargetRows
} from "./write.js";

export type RegistrySchemaUnsupported = ProductError<
  "RegistrySchemaUnsupported",
  Readonly<{
    actualVersion: number;
    currentVersion: number;
  }>
>;

export type RegistryStateRejected = ProductError<
  "RegistryStateRejected",
  Readonly<{
    targetId: string;
    reason: "constraint";
  }>
>;

export type RegistryOpenError = RegistrySchemaUnsupported;
export type RegistryPendingOperationRejected = ProductError<
  "RegistryPendingOperationRejected",
  Readonly<{
    targetId: string;
    reason: "conflict";
  }>
>;
export type RegistryReplaceError =
  | RegistryStateRejected
  | RegistryPendingOperationRejected;

export type RegistryConnectionPragmas = Readonly<{
  foreignKeys: boolean;
  journalMode: "wal";
  synchronous: "full";
  userVersion: number;
}>;

export class MachineRegistry {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  close(): void {
    this.#database.close();
  }

  pragmas(): RegistryConnectionPragmas {
    const foreignKeys = pragmaNumber(this.#database, "foreign_keys") === 1;
    const journalMode = pragmaString(this.#database, "journal_mode");
    const synchronous = pragmaNumber(this.#database, "synchronous");
    const userVersion = pragmaNumber(this.#database, "user_version");
    if (journalMode !== "wal" || synchronous !== 2) {
      throw new Error("registry connection pragmas are not configured");
    }
    return {
      foreignKeys,
      journalMode,
      synchronous: "full",
      userVersion
    };
  }

  readTargetState(targetId: string): RegistryTargetState | undefined {
    return readTargetRows(this.#database, targetId);
  }

  readPendingOperations(): ReadonlyArray<RegistryPendingOperation> {
    return readPendingOperationRows(this.#database);
  }

  beginPendingOperation(
    targetId: string,
    pending: RegistryPendingOperationInput
  ): Result<RegistryPendingOperation, RegistryPendingOperationRejected> {
    try {
      return {
        ok: true,
        value: beginPendingOperationRows(this.#database, targetId, pending)
      };
    } catch (error) {
      if (
        error instanceof RegistryPendingOperationConflictError ||
        isConstraintError(error)
      ) {
        return {
          ok: false,
          error: productError("RegistryPendingOperationRejected", {
            targetId,
            reason: "conflict"
          })
        };
      }
      throw error;
    }
  }

  completePendingOperation(operationId: string): void {
    completePendingOperationRows(this.#database, operationId);
  }

  replaceTargetState(
    state: RegistryTargetStateInput,
    pendingOperationId?: string
  ): Result<RegistryTargetState, RegistryReplaceError> {
    try {
      replaceTargetRows(this.#database, state, pendingOperationId);
    } catch (error) {
      if (error instanceof RegistryPendingOperationConflictError) {
        return {
          ok: false,
          error: productError("RegistryPendingOperationRejected", {
            targetId: state.targetId,
            reason: "conflict"
          })
        };
      }
      if (isConstraintError(error)) {
        return {
          ok: false,
          error: productError("RegistryStateRejected", {
            targetId: state.targetId,
            reason: "constraint"
          })
        };
      }
      throw error;
    }

    const readback = readTargetRows(this.#database, state.targetId);
    if (readback === undefined) {
      throw new Error("registry target disappeared after committed replacement");
    }
    return { ok: true, value: readback };
  }
}

export function openMachineRegistry(
  paths: SkiloomHomePaths
): Result<MachineRegistry, RegistryOpenError> {
  mkdirSync(paths.homeRoot, { recursive: true });
  const database = new DatabaseSync(paths.registryPath, {
    enableForeignKeyConstraints: true,
    timeout: 0
  });

  try {
    configureRegistryConnection(database);
    const version = pragmaNumber(database, "user_version");
    if (version === 0 && countUserTables(database) === 0) {
      initializeRegistrySchema(database);
    } else if (version !== CURRENT_REGISTRY_SCHEMA_VERSION) {
      database.close();
      return {
        ok: false,
        error: productError("RegistrySchemaUnsupported", {
          actualVersion: version,
          currentVersion: CURRENT_REGISTRY_SCHEMA_VERSION
        })
      };
    }
    return { ok: true, value: new MachineRegistry(database) };
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the original open/configuration failure.
    }
    throw error;
  }
}

function countUserTables(database: DatabaseSync): number {
  const row = database
    .prepare(`
      SELECT COUNT(*) AS table_count
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `)
    .get();
  const count = row?.table_count;
  if (typeof count !== "number" || !Number.isSafeInteger(count)) {
    throw new Error("invalid registry table count");
  }
  return count;
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  if (row === undefined) {
    throw new Error(`missing registry pragma: ${name}`);
  }
  const value = Object.values(row)[0];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid registry pragma: ${name}`);
  }
  return value;
}

function pragmaString(database: DatabaseSync, name: string): string {
  const row = database.prepare(`PRAGMA ${name}`).get();
  if (row === undefined) {
    throw new Error(`missing registry pragma: ${name}`);
  }
  const value = Object.values(row)[0];
  if (typeof value !== "string") {
    throw new Error(`invalid registry pragma: ${name}`);
  }
  return value;
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_SQLITE_ERROR" &&
    /constraint failed/iu.test(error.message)
  );
}
