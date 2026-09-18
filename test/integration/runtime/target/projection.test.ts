import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildPackageSnapshot,
  type PackageSnapshot,
  type RepositorySnapshotEntry
} from "../../../../src/domain/snapshot/index.js";
import type { TargetProjection } from "../../../../src/domain/target/index.js";
import {
  resolveSkiloomHomePaths,
  type SkiloomHomePaths
} from "../../../../src/runtime/home.js";
import { publishPackageSnapshot } from "../../../../src/runtime/store.js";
import {
  managedProjectionMaterializationCandidates,
  materializeManagedProjection,
  verifyManagedProjection
} from "../../../../src/runtime/target-projection/index.js";

test("projection materialization candidates are deterministic and transformed copies force copy", () => {
  assert.deepEqual(
    managedProjectionMaterializationCandidates("linux", false),
    ["symlink", "copy"]
  );
  assert.deepEqual(
    managedProjectionMaterializationCandidates("darwin", false),
    ["symlink", "copy"]
  );
  assert.deepEqual(
    managedProjectionMaterializationCandidates("win32", false),
    ["junction", "copy"]
  );
  assert.deepEqual(
    managedProjectionMaterializationCandidates("linux", true),
    ["copy"]
  );
  assert.deepEqual(
    managedProjectionMaterializationCandidates("win32", true),
    ["copy"]
  );
});

test("untransformed projection materializes with platform link strategy and verifies exact Store target", async () => {
  await withRuntime(async ({ home, targetRoot }) => {
    const snapshot = snapshotFor("demo", "direct body\n");
    await publish(home, snapshot);
    const projection = directProjection(snapshot);

    const created = await materializeManagedProjection({
      home,
      targetRoot,
      projection,
      materialization: "auto"
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    assert.equal(created.value.status, "created");
    assert.equal(
      process.platform === "win32"
        ? ["junction", "copy"].includes(created.value.materialization)
        : ["symlink", "copy"].includes(created.value.materialization),
      true
    );

    const verified = await verifyManagedProjection({
      home,
      targetRoot,
      expected: {
        projection,
        materialization: created.value.materialization
      }
    });
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.value.materialization, created.value.materialization);
      assert.equal(verified.value.contentDigest, snapshot.contentDigest);
    }

    const storeSkill = await readFile(
      join(created.value.storePayloadPath, "SKILL.md"),
      "utf8"
    );
    assert.equal(storeSkill, skillMarkdown("demo", "direct body\n"));
  });
});

test("transformed projection rewrites only approved SKILL.md bytes and preserves Store content", async () => {
  await withRuntime(async ({ home, targetRoot }) => {
    const originalSkill =
      "---\r\n" +
      "name: \"demo\"\r\n" +
      "description: transformed fixture\r\n" +
      "---\r\n" +
      "Use helper when needed.\r\n";
    const snapshot = snapshotForSkill("demo", originalSkill);
    const published = await publish(home, snapshot);
    const projection = transformedProjection(snapshot);

    const result = await materializeManagedProjection({
      home,
      targetRoot,
      projection,
      materialization: "auto"
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.materialization, "copy");

    const expectedSkill =
      "---\r\n" +
      "name: demo-local\r\n" +
      "description: transformed fixture\r\n" +
      "---\r\n" +
      "Use helper when needed.\r\n" +
      "\n" +
      "<!-- SKILOOM-DEPENDENCY-ROUTING-V1:BEGIN -->\n" +
      "## Skiloom dependency routing\n" +
      "\n" +
      "The following Skill dependencies use Target-local activation names. Use the listed Skill name when invoking each dependency; do not infer a filesystem path.\n" +
      "\n" +
      "- `org/dep/helper`: use Skill `helper-local`\n" +
      "<!-- SKILOOM-DEPENDENCY-ROUTING-V1:END -->\n";

    assert.equal(
      await readFile(join(targetRoot, "demo-local", "SKILL.md"), "utf8"),
      expectedSkill
    );
    assert.equal(
      await readFile(join(targetRoot, "demo-local", "README.md"), "utf8"),
      "unchanged\n"
    );
    assert.equal(
      await readFile(join(published.payloadPath, "SKILL.md"), "utf8"),
      originalSkill
    );

    const verified = await verifyManagedProjection({
      home,
      targetRoot,
      expected: {
        projection,
        materialization: "copy"
      }
    });
    assert.equal(verified.ok, true);
  });
});

test("rename transform fails closed when exact YAML source-range replacement cannot re-admit", async () => {
  await withRuntime(async ({ home, targetRoot }) => {
    const snapshot = snapshotForSkill(
      "demo",
      "---\nname: |-\n  demo\ndescription: block scalar fixture\n---\nbody\n"
    );
    await publish(home, snapshot);
    const projection = {
      ...transformedProjection(snapshot),
      transform: {
        rename: { fromActivationName: "demo", toActivationName: "demo-local" },
        dependencyRoutes: []
      }
    } satisfies TargetProjection;

    const result = await materializeManagedProjection({
      home,
      targetRoot,
      projection,
      materialization: "copy"
    });
    assertErrorCode(result, "UnsupportedManagedTransform");
    assert.deepEqual(await readdir(targetRoot), []);
  });
});

test("copy verification distinguishes missing extra modified executable and special-file drift", async (context) => {
  await withRuntime(async ({ home, targetRoot }) => {
    const snapshot = snapshotFor("demo", "verification\n");
    await publish(home, snapshot);
    const projection = directProjection(snapshot);

    const missing = await verifyManagedProjection({
      home,
      targetRoot,
      expected: { projection, materialization: "copy" }
    });
    assertErrorCode(missing, "ManagedProjectionMissing");

    await materializeCopy(home, targetRoot, projection);
    await rm(join(targetRoot, "demo", "README.md"));
    const missingEntry = await verifyManagedProjection({
      home,
      targetRoot,
      expected: { projection, materialization: "copy" }
    });
    assertErrorCode(missingEntry, "ManagedProjectionMissingEntry");

    await rm(join(targetRoot, "demo"), { recursive: true, force: true });
    await materializeCopy(home, targetRoot, projection);
    await writeFile(join(targetRoot, "demo", "extra.txt"), "foreign\n");
    const extra = await verifyManagedProjection({
      home,
      targetRoot,
      expected: { projection, materialization: "copy" }
    });
    assertErrorCode(extra, "ManagedProjectionUnexpectedEntry");

    await rm(join(targetRoot, "demo"), { recursive: true, force: true });
    await materializeCopy(home, targetRoot, projection);
    await mkdir(join(targetRoot, "demo", "empty-extra"));
    const extraDirectory = await verifyManagedProjection({
      home,
      targetRoot,
      expected: { projection, materialization: "copy" }
    });
    assertErrorCode(extraDirectory, "ManagedProjectionUnexpectedEntry");

    await rm(join(targetRoot, "demo"), { recursive: true, force: true });
    await materializeCopy(home, targetRoot, projection);
    await writeFile(join(targetRoot, "demo", "README.md"), "modified\n");
    const modified = await verifyManagedProjection({
      home,
      targetRoot,
      expected: { projection, materialization: "copy" }
    });
    assertErrorCode(modified, "ManagedProjectionContentMismatch");

    if (process.platform !== "win32") {
      await rm(join(targetRoot, "demo"), { recursive: true, force: true });
      await materializeCopy(home, targetRoot, projection);
      await chmod(join(targetRoot, "demo", "scripts", "run.sh"), 0o644);
      const executable = await verifyManagedProjection({
        home,
        targetRoot,
        expected: { projection, materialization: "copy" }
      });
      assertErrorCode(executable, "ManagedProjectionExecutableMismatch");
    } else {
      context.diagnostic("Windows has no POSIX executable-bit Target signal");
    }

    if (process.platform !== "win32") {
      await rm(join(targetRoot, "demo"), { recursive: true, force: true });
      await materializeCopy(home, targetRoot, projection);
      await symlink(
        join(targetRoot, "demo", "README.md"),
        join(targetRoot, "demo", "unexpected-link")
      );
      const special = await verifyManagedProjection({
        home,
        targetRoot,
        expected: { projection, materialization: "copy" }
      });
      assertErrorCode(special, "ManagedProjectionUnsupportedEntry");
    }
  });
});

test("link verification reports a wrong target without following it", async (context) => {
  if (process.platform === "win32") {
    context.skip("junction target normalization is covered by Windows CI once Node Target jobs are enabled");
    return;
  }

  await withRuntime(async ({ home, targetRoot }) => {
    const snapshot = snapshotFor("demo", "wrong-link\n");
    await publish(home, snapshot);
    const projection = directProjection(snapshot);

    const created = await materializeManagedProjection({
      home,
      targetRoot,
      projection,
      materialization: "symlink"
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }

    await unlink(join(targetRoot, "demo"));
    const foreignTarget = join(targetRoot, "foreign");
    await mkdir(foreignTarget);
    await symlink(foreignTarget, join(targetRoot, "demo"), "dir");

    const verified = await verifyManagedProjection({
      home,
      targetRoot,
      expected: { projection, materialization: "symlink" }
    });
    assertErrorCode(verified, "ManagedProjectionWrongLink");
  });
});

test("target root must be a real directory and is never followed through a symlink", async (context) => {
  await withRuntime(async ({ home, targetRoot }) => {
    const snapshot = snapshotFor("demo", "root safety\n");
    await publish(home, snapshot);
    const projection = directProjection(snapshot);

    await rm(targetRoot, { recursive: true, force: true });
    await writeFile(targetRoot, "foreign root file\n");
    const fileRoot = await materializeManagedProjection({
      home,
      targetRoot,
      projection,
      materialization: "copy"
    });
    assertErrorCode(fileRoot, "InvalidManagedProjectionInput");
    assert.equal(await readFile(targetRoot, "utf8"), "foreign root file\n");

    if (process.platform === "win32") {
      context.diagnostic("Windows symlink creation is privilege-sensitive");
      return;
    }

    await rm(targetRoot, { force: true });
    const foreignRoot = resolve(targetRoot, "..", "foreign-target-root");
    await mkdir(foreignRoot);
    await writeFile(join(foreignRoot, "KEEP"), "outside\n");
    await symlink(foreignRoot, targetRoot, "dir");

    const linkedRoot = await materializeManagedProjection({
      home,
      targetRoot,
      projection,
      materialization: "copy"
    });
    assertErrorCode(linkedRoot, "InvalidManagedProjectionInput");
    assert.equal(await readFile(join(foreignRoot, "KEEP"), "utf8"), "outside\n");
  });
});

test("replacement activates only after staging succeeds and never removes unproved foreign content", async () => {
  await withRuntime(async ({ home, targetRoot }) => {
    const currentSnapshot = snapshotFor("demo", "current\n");
    const nextSnapshot = snapshotFor("demo", "next\n");
    await publish(home, currentSnapshot);
    await publish(home, nextSnapshot);

    const current = directProjection(currentSnapshot);
    const next = directProjection(nextSnapshot);

    const initial = await materializeManagedProjection({
      home,
      targetRoot,
      projection: current,
      materialization: "copy"
    });
    assert.equal(initial.ok, true);

    const replaced = await materializeManagedProjection({
      home,
      targetRoot,
      projection: next,
      materialization: "copy",
      current: { projection: current, materialization: "copy" }
    });
    assert.equal(replaced.ok, true);
    if (replaced.ok) {
      assert.equal(replaced.value.status, "replaced");
    }
    assert.match(
      await readFile(join(targetRoot, "demo", "SKILL.md"), "utf8"),
      /next/u
    );
    assert.deepEqual(
      (await readdir(targetRoot)).filter((name) => name.startsWith(".skiloom-")),
      []
    );

    const foreignPath = join(targetRoot, "foreign-skill");
    await mkdir(foreignPath);
    await writeFile(join(foreignPath, "KEEP"), "user-owned\n");

    const foreignProjection = {
      ...transformedProjection(nextSnapshot),
      activationName: "foreign-skill",
      transform: {
        rename: { fromActivationName: "demo", toActivationName: "foreign-skill" },
        dependencyRoutes: []
      }
    } satisfies TargetProjection;
    const blocked = await materializeManagedProjection({
      home,
      targetRoot,
      projection: foreignProjection,
      materialization: "copy"
    });
    assertErrorCode(blocked, "TargetPathOccupied");
    assert.equal(await readFile(join(foreignPath, "KEEP"), "utf8"), "user-owned\n");

    const validTransformed = {
      ...transformedProjection(currentSnapshot),
      activationName: "demo-local",
      transform: {
        rename: { fromActivationName: "demo", toActivationName: "demo-local" },
        dependencyRoutes: []
      }
    } satisfies TargetProjection;
    const transformedCurrent = await materializeManagedProjection({
      home,
      targetRoot,
      projection: validTransformed,
      materialization: "copy"
    });
    assert.equal(transformedCurrent.ok, true);
    const before = await readFile(join(targetRoot, "demo-local", "SKILL.md"), "utf8");

    const badSnapshot = snapshotForSkill(
      "demo",
      skillMarkdown(
        "demo",
        "<!-- SKILOOM-DEPENDENCY-ROUTING-V1:BEGIN -->\nsource-owned marker\n"
      )
    );
    await publish(home, badSnapshot);
    const badDesired = transformedProjection(badSnapshot);
    const failed = await materializeManagedProjection({
      home,
      targetRoot,
      projection: badDesired,
      materialization: "copy",
      current: {
        projection: validTransformed,
        materialization: "copy"
      }
    });
    assertErrorCode(failed, "ManagedTransformMarkerConflict");
    assert.equal(
      await readFile(join(targetRoot, "demo-local", "SKILL.md"), "utf8"),
      before
    );
  });
});

async function materializeCopy(
  home: SkiloomHomePaths,
  targetRoot: string,
  projection: TargetProjection
): Promise<void> {
  const result = await materializeManagedProjection({
    home,
    targetRoot,
    projection,
    materialization: "copy"
  });
  assert.equal(result.ok, true);
}

function directProjection(snapshot: PackageSnapshot): TargetProjection {
  return {
    packageCoordinate: "org/app/demo",
    packageRoot: ".",
    contentDigest: snapshot.contentDigest,
    activationName: "demo",
    projectionKind: "direct",
    transform: null
  };
}

function transformedProjection(snapshot: PackageSnapshot): TargetProjection {
  return {
    packageCoordinate: "org/app/demo",
    packageRoot: ".",
    contentDigest: snapshot.contentDigest,
    activationName: "demo-local",
    projectionKind: "transformed-copy",
    transform: {
      rename: {
        fromActivationName: "demo",
        toActivationName: "demo-local"
      },
      dependencyRoutes: [
        {
          dependencyPackageCoordinate: "org/dep/helper",
          fromActivationName: "helper",
          toActivationName: "helper-local"
        }
      ]
    }
  };
}

function snapshotFor(name: string, body: string): PackageSnapshot {
  return snapshotForSkill(name, skillMarkdown(name, body));
}

function snapshotForSkill(name: string, skill: string): PackageSnapshot {
  const entries: RepositorySnapshotEntry[] = [
    {
      pathBytes: Buffer.from("SKILL.md"),
      fileType: "regular",
      gitMode: "100644",
      content: Buffer.from(skill)
    },
    {
      pathBytes: Buffer.from("README.md"),
      fileType: "regular",
      gitMode: "100644",
      content: Buffer.from("unchanged\n")
    },
    {
      pathBytes: Buffer.from("scripts/run.sh"),
      fileType: "regular",
      gitMode: "100755",
      content: Buffer.from("#!/bin/sh\nexit 0\n")
    }
  ];
  const built = buildPackageSnapshot({
    packageRoot: ".",
    discoveredPackageRoots: ["."],
    entries
  });
  if (!built.ok) {
    throw new Error(`${name}: invalid Package Snapshot fixture`);
  }
  return built.value;
}

function skillMarkdown(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: Target projection fixture\n---\n${body}`;
}

async function publish(
  home: SkiloomHomePaths,
  snapshot: PackageSnapshot
): Promise<Readonly<{ payloadPath: string }>> {
  const result = await publishPackageSnapshot(home, snapshot);
  if (!result.ok) {
    throw new Error(`failed to publish projection fixture: ${result.error.code}`);
  }
  return result.value;
}

function assertErrorCode(
  result: Readonly<{ ok: boolean; error?: Readonly<{ code: string }> }>,
  code: string
): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error?.code, code);
  }
}

async function withRuntime(
  run: (input: Readonly<{
    home: SkiloomHomePaths;
    targetRoot: string;
  }>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skiloom-target-projection-"));
  const home = resolveSkiloomHomePaths(join(root, "home"));
  const targetRoot = join(root, "target");
  await mkdir(targetRoot, { recursive: true });
  try {
    await run({ home, targetRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
