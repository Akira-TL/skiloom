import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  assertNoUnexpectedStderr,
  parseJson,
  runGateCli,
  withGateRuntime
} from "./fixture.js";

type LifecycleOutput = Readonly<{
  result: Readonly<{
    status: string;
    acceptedState?: Readonly<{
      generation: number;
    }> | null;
    sources?: ReadonlyArray<Readonly<{
      repositoryCoordinate: string;
      version?: string;
    }>>;
    projections?: ReadonlyArray<Readonly<{
      packageCoordinate: string;
      activationName: string;
      ownership: string;
    }>>;
    generation?: number;
  }>;
}>;

type StatusOutput = Readonly<{
  result: Readonly<{
    marker: Readonly<{
      targetId: string;
      generation: number;
    }> | null;
    registry: Readonly<{
      targetId: string;
      generation: number;
    }> | null;
  }>;
}>;

test("fresh Target crosses install update status export and offline import through the executable boundary", async () => {
  await withGateRuntime(async ({ home, cwd, target }) => {
    const installed = await runGateCli(
      ["install", "acme/app/app", "--yes", "--json"],
      { home, cwd, githubMode: "base" }
    );
    assert.equal(installed.code, 0);
    assertNoUnexpectedStderr(installed.stderr);
    const installedOutput =
      parseJson<LifecycleOutput>(installed.stdout);
    assert.equal(
      installedOutput.result.status,
      "installed"
    );
    assert.equal(
      installedOutput.result.acceptedState?.generation,
      1
    );
    assert.equal(
      existsSync(join(target, "skiloom")),
      false,
      "first-party Skills must remain optional UX"
    );

    const updated = await runGateCli(
      ["update", "--yes", "--json"],
      { home, cwd, githubMode: "versions" }
    );
    assert.equal(updated.code, 0);
    assertNoUnexpectedStderr(updated.stderr);
    const updatedOutput =
      parseJson<LifecycleOutput>(updated.stdout);
    assert.equal(updatedOutput.result.status, "updated");
    assert.equal(
      updatedOutput.result.acceptedState?.generation,
      2
    );
    assert.equal(
      updatedOutput.result.sources?.[0]?.version,
      "2.0.0"
    );
    assert.match(
      await readFile(
        join(target, "app", "SKILL.md"),
        "utf8"
      ),
      /Version two application\./u
    );

    const status = await runGateCli(
      ["status", "--json"],
      { home, cwd, githubMode: "forbid-network" }
    );
    assert.equal(status.code, 0);
    const statusOutput =
      parseJson<StatusOutput>(status.stdout);
    assert.equal(
      statusOutput.result.registry?.generation,
      2
    );
    assert.equal(
      statusOutput.result.marker?.generation,
      2
    );
    const originalTargetId =
      statusOutput.result.registry?.targetId;
    assert.notEqual(originalTargetId, undefined);

    const exportFile = "gate.skiloom-export";
    const exported = await runGateCli(
      ["export", exportFile, "--json"],
      { home, cwd, githubMode: "forbid-network" }
    );
    assert.equal(exported.code, 0);
    assert.equal(
      existsSync(join(cwd, exportFile)),
      true
    );

    const importedTarget = join(
      cwd,
      "offline-import-target"
    );
    const imported = await runGateCli(
      [
        "import",
        exportFile,
        "--target",
        importedTarget,
        "--yes",
        "--json"
      ],
      { home, cwd, githubMode: "forbid-network" }
    );
    assert.equal(imported.code, 0);
    assertNoUnexpectedStderr(imported.stderr);
    const importedOutput =
      parseJson<LifecycleOutput>(imported.stdout);
    assert.equal(
      importedOutput.result.status,
      "imported"
    );
    assert.equal(
      importedOutput.result.generation,
      1
    );
    assert.match(
      await readFile(
        join(importedTarget, "app", "SKILL.md"),
        "utf8"
      ),
      /Version two application\./u
    );

    const importedStatus = await runGateCli(
      [
        "status",
        "--target",
        importedTarget,
        "--json"
      ],
      { home, cwd, githubMode: "forbid-network" }
    );
    assert.equal(importedStatus.code, 0);
    const importedStatusOutput =
      parseJson<StatusOutput>(importedStatus.stdout);
    assert.equal(
      importedStatusOutput.result.registry?.generation,
      1
    );
    assert.notEqual(
      importedStatusOutput.result.registry?.targetId,
      originalTargetId
    );
  });
});

test("local ownership operations survive DB-loss recovery and preserve user bytes", async () => {
  await withGateRuntime(async ({ home, cwd, target }) => {
    assert.equal(
      (
        await runGateCli(
          [
            "install",
            "acme/app/app",
            "--yes",
            "--json"
          ],
          { home, cwd, githubMode: "base" }
        )
      ).code,
      0
    );

    const renamed = await runGateCli(
      [
        "rename",
        "acme/app/app",
        "app-local",
        "--json"
      ],
      { home, cwd, githubMode: "forbid-network" }
    );
    assert.equal(renamed.code, 0);

    const detached = await runGateCli(
      ["detach", "acme/app/app", "--json"],
      { home, cwd, githubMode: "forbid-network" }
    );
    assert.equal(detached.code, 0);
    const detachedOutput =
      parseJson<LifecycleOutput>(detached.stdout);
    assert.equal(
      detachedOutput.result.projections?.[0]
        ?.ownership,
      "detached"
    );

    await writeFile(
      join(target, "app-local", "USER-NOTE"),
      "gate user bytes\n",
      "utf8"
    );
    await rename(
      join(target, "app-local"),
      join(target, "app-moved")
    );

    const rebound = await runGateCli(
      [
        "rebind",
        "acme/app/app",
        "app-moved",
        "--json"
      ],
      { home, cwd, githubMode: "forbid-network" }
    );
    assert.equal(rebound.code, 0);
    assert.equal(
      await readFile(
        join(target, "app-moved", "USER-NOTE"),
        "utf8"
      ),
      "gate user bytes\n"
    );

    await deleteRegistry(home);

    const recovered = await runGateCli(
      ["recover", "--yes", "--json"],
      { home, cwd, githubMode: "base" }
    );
    assert.equal(recovered.code, 0);
    assertNoUnexpectedStderr(recovered.stderr);
    const recoveredOutput =
      parseJson<LifecycleOutput>(recovered.stdout);
    assert.equal(
      recoveredOutput.result.status,
      "recovered"
    );
    assert.equal(
      recoveredOutput.result.projections?.[0]
        ?.ownership,
      "detached"
    );
    assert.equal(
      await readFile(
        join(target, "app-moved", "USER-NOTE"),
        "utf8"
      ),
      "gate user bytes\n"
    );

    const forgotten = await runGateCli(
      ["forget", "acme/app/app", "--json"],
      { home, cwd, githubMode: "forbid-network" }
    );
    assert.equal(forgotten.code, 0);
    assert.equal(
      await readFile(
        join(target, "app-moved", "USER-NOTE"),
        "utf8"
      ),
      "gate user bytes\n"
    );
  });
});

async function deleteRegistry(home: string): Promise<void> {
  const registry = join(
    home,
    ".skiloom",
    "registry.sqlite3"
  );
  await rm(registry, { force: true });
  await rm(registry + "-shm", { force: true });
  await rm(registry + "-wal", { force: true });
}
