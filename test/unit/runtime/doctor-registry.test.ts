import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import {
  readDoctorRegistrySnapshot
} from "../../../src/runtime/doctor/registry.js";
import {
  resolveSkiloomHomePaths
} from "../../../src/runtime/home.js";
import {
  openMachineRegistry
} from "../../../src/runtime/registry/database.js";
import type {
  RegistryTargetStateInput
} from "../../../src/runtime/registry/model.js";

type Fixture = Readonly<{
  state: RegistryTargetStateInput;
}>;

test("doctor accepted state and pending-operation facts share one Registry snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "skiloom-doctor-snapshot-"));
  try {
    const home = resolveSkiloomHomePaths(root);
    const fixture = await readFixture();
    const seed = openMachineRegistry(home);
    assert.equal(seed.ok, true);
    if (!seed.ok) return;
    assert.equal(seed.value.replaceTargetState(fixture.state).ok, true);
    const pending = seed.value.beginPendingOperation(
      fixture.state.targetId,
      {
        operationId: "snapshot-pending",
        actions: []
      }
    );
    assert.equal(pending.ok, true);
    seed.value.close();

    const writerOpen = openMachineRegistry(home);
    assert.equal(writerOpen.ok, true);
    if (!writerOpen.ok) return;
    const writer = writerOpen.value;
    const rawReader = new DatabaseSync(home.registryPath);
    let writerCommitted = false;
    const reader = interceptGenerationRead(rawReader, () => {
      if (writerCommitted) return;
      writerCommitted = true;
      writer.completePendingOperation("snapshot-pending");
      const replaced = writer.replaceTargetState({
        ...fixture.state,
        directRequirements: fixture.state.directRequirements.slice(0, 1)
      });
      assert.equal(replaced.ok, true);
    });

    try {
      const snapshot = readDoctorRegistrySnapshot(
        reader,
        fixture.state.locations[0]!.path,
        fixture.state.targetId
      );
      assert.equal(writerCommitted, true);
      assert.equal(snapshot.state?.generation, 1);
      assert.equal(
        snapshot.state?.directRequirements.length,
        fixture.state.directRequirements.length
      );
      assert.deepEqual(
        snapshot.pendingOperations.map((entry) => entry.operationId),
        ["snapshot-pending"]
      );

      const current = writer.readTargetState(fixture.state.targetId);
      assert.equal(current?.generation, 2);
      assert.deepEqual(writer.readPendingOperations(), []);
    } finally {
      rawReader.close();
      writer.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function interceptGenerationRead(
  database: DatabaseSync,
  afterGenerationRead: () => void
): DatabaseSync {
  let intercepted = false;
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("SELECT generation FROM targets")) {
            return statement;
          }
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "get") {
                return (...parameters: SQLInputValue[]) => {
                  const row = statementTarget.get(...parameters);
                  if (!intercepted) {
                    intercepted = true;
                    afterGenerationRead();
                  }
                  return row;
                };
              }
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget
              );
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            }
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function readFixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      "behavior-fixtures/registry/current-state.json",
      "utf8"
    )
  ) as Fixture;
}
