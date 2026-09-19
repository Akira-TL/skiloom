import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  parseExactExportPackage,
  writeExactExportPackage
} from "../../../../src/domain/export-package/index.js";
import {
  createPackageSnapshot
} from "../../../../src/domain/snapshot/index.js";
import type {
  TargetOwnedProjection
} from "../../../../src/domain/target/preflight.js";
import {
  createUserPayload
} from "../../../../src/domain/user-payload/index.js";
import {
  exportFullTarget
} from "../../../../src/runtime/export/full.js";
import {
  mergeExactPackage
} from "../../../../src/runtime/import/index.js";
import {
  detachTargetProjection
} from "../../../../src/runtime/orchestration/detached-lifecycle.js";
import {
  acceptedTargetPlan
} from "../../../../src/runtime/orchestration/lifecycle/recovery/target.js";
import type {
  RegistryTargetState,
  RegistryTargetStateInput
} from "../../../../src/runtime/registry/index.js";
import {
  readTargetStateMarkerFile,
  writeTargetStateMarkerFile
} from "../../../../src/runtime/target-state-marker.js";
import {
  targetStateMarkerFactsFromRegistryState
} from "../../../../src/runtime/target-state-recovery.js";
import {
  install,
  lifecycleFixture,
  requireRegistry,
  targetId,
  withRealLock,
  withRuntime
} from "../lifecycle/completion-fixture.js";
import {
  releasePackageRequirement
} from "../lifecycle/github-source-fixture.js";

test("merge requires separate explicit authorization before source acceptance or mutation", async () => {
  const bytes = await dependenciesFixtureBytes();
  await withExistingTarget(async (ctx) => {
    let sourceAcceptanceCalls = 0;
    const result = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: ctx.registry,
      bytes,
      authorizeMerge: () => false,
      acceptSources: () => {
        sourceAcceptanceCalls += 1;
        return true;
      },
      createOperationId: () => "merge-not-authorized"
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ExactMergeAuthorizationRequired");
    }
    assert.equal(sourceAcceptanceCalls, 0);
    await assertUnchanged(ctx);
  });
});

test("non-conflicting exact merge creates one complete new generation and preserves existing roots and Store", async () => {
  const bytes = await dependenciesFixtureBytes();
  await withExistingTarget(async (ctx) => {
    const result = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: ctx.registry,
      bytes,
      authorizeMerge: () => true,
      acceptSources: (facts) => {
        assert.deepEqual(
          facts.sources.map((source) => source.repositoryCoordinate),
          ["acme/demo"]
        );
        return true;
      },
      createOperationId: () => "merge-demo"
    });

    assert.equal(result.ok, true);
    if (!result.ok || result.value.status !== "merged") {
      return;
    }
    assert.equal(result.value.state.generation, 2);
    assert.deepEqual(
      result.value.state.directRequirements.map((entry) => entry.coordinate),
      ["acme/app/app", "acme/demo/demo"]
    );
    assert.equal(existsSync(join(ctx.targetRoot, "app")), true);
    assert.equal(existsSync(join(ctx.targetRoot, "demo")), true);
    assert.equal(
      readdirSync(ctx.paths.storePath).length,
      ctx.initialStoreEntries.length + 1
    );
    for (const entry of ctx.initialStoreEntries) {
      assert.equal(existsSync(join(ctx.paths.storePath, entry)), true);
    }

    const marker = await readTargetStateMarkerFile(ctx.targetRoot);
    assert.equal(marker.ok, true);
    if (marker.ok) {
      assert.equal(marker.value?.generation, 2);
      assert.deepEqual(
        marker.value?.requirements.map((entry) => entry.coordinate),
        ["acme/app/app", "acme/demo/demo"]
      );
    }
  });
});

test("successful merge preserves existing detached ownership baseline and user bytes", async () => {
  const bytes = await dependenciesFixtureBytes();
  await withExistingTarget(async (ctx) => {
    const plan = acceptedTargetPlan(ctx.initialState);
    assert.equal(plan.ok, true);
    if (!plan.ok) {
      return;
    }
    const projection = plan.value.projections.find(
      (entry) => entry.packageCoordinate === "acme/app/app"
    )!;
    const registryProjection =
      ctx.initialState.projections.find(
        (entry) =>
          entry.packageCoordinate === "acme/app/app"
      )!;
    const current: TargetOwnedProjection = {
      projection,
      ownership: "managed",
      materialization: registryProjection.materialization
    };

    const detached = await detachTargetProjection({
      home: ctx.paths,
      targetRoot: ctx.targetRoot,
      operationId: "detach-before-successful-merge",
      lock: ctx.lock,
      registry: ctx.registry,
      acceptedState: withoutGeneration(ctx.initialState),
      packageCoordinate: "acme/app/app",
      current
    });
    assert.equal(detached.ok, true);
    if (!detached.ok) {
      return;
    }
    await writeMarker(ctx.targetRoot, detached.value);
    await writeFile(
      join(ctx.targetRoot, "app", "USER-NOTE"),
      "preserve-me\n"
    );

    const baselineBefore =
      detached.value.detachedBaselines.find(
        (entry) => entry.packageCoordinate === "acme/app/app"
      );
    assert.notEqual(baselineBefore, undefined);

    const result = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: ctx.registry,
      bytes,
      authorizeMerge: () => true,
      acceptSources: () => true,
      createOperationId: () => "merge-preserve-detached"
    });

    assert.equal(result.ok, true);
    if (!result.ok || result.value.status !== "merged") {
      return;
    }
    assert.equal(result.value.state.generation, 3);
    assert.equal(
      result.value.state.projections.find(
        (entry) => entry.packageCoordinate === "acme/app/app"
      )?.ownership,
      "detached"
    );
    assert.deepEqual(
      result.value.state.detachedBaselines.find(
        (entry) => entry.packageCoordinate === "acme/app/app"
      ),
      baselineBefore
    );
    assert.equal(
      await readFile(
        join(ctx.targetRoot, "app", "USER-NOTE"),
        "utf8"
      ),
      "preserve-me\n"
    );
    assert.equal(
      result.value.state.projections.find(
        (entry) => entry.packageCoordinate === "acme/demo/demo"
      )?.ownership,
      "managed"
    );
  });
});

test("full merge restores a new manual Skill as user-owned bytes without adding managed ownership", async () => {
  const bytes = await fullUserSkillFixtureBytes("local");
  await withExistingTarget(async (ctx) => {
    const result = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: ctx.registry,
      bytes,
      authorizeMerge: () => true,
      acceptSources: () => true,
      createOperationId: () => "merge-user-skill-success"
    });

    assert.equal(result.ok, true);
    if (!result.ok || result.value.status !== "merged") {
      return;
    }
    assert.match(
      await readFile(
        join(ctx.targetRoot, "local", "SKILL.md"),
        "utf8"
      ),
      /imported user skill/u
    );
    assert.equal(
      result.value.state.projections.some(
        (projection) =>
          projection.activationName === "local"
      ),
      false,
      "manual Skill must remain outside managed Registry projections"
    );
    assert.equal(
      result.value.state.resolvedPackages.some(
        (entry) =>
          entry.packageCoordinate.endsWith("/local")
      ),
      false,
      "manual Skill must not enter managed Package graph"
    );
  });
});

test("repository source conflict fails before Store Registry or Target mutation", async () => {
  await withExistingTarget(async (ctx) => {
    const bytes = await conflictingSourceBytes(ctx.initialState);
    let sourceAcceptanceCalls = 0;
    const result = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: ctx.registry,
      bytes,
      authorizeMerge: () => true,
      acceptSources: () => {
        sourceAcceptanceCalls += 1;
        return true;
      },
      createOperationId: () => "merge-source-conflict"
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ExactMergeConflict");
      if (result.error.code === "ExactMergeConflict") {
        assert.equal(result.error.facts.reason, "repository-source");
        assert.equal(result.error.facts.subject, "acme/app");
      }
    }
    assert.equal(sourceAcceptanceCalls, 0);
    await assertUnchanged(ctx);
    assert.equal(existsSync(join(ctx.targetRoot, "other")), false);
  });
});

test("foreign managed activation and imported user-skill collisions fail without overwrite or adoption", async () => {
  const dependencies = await dependenciesFixtureBytes();
  await withExistingTarget(async (ctx) => {
    const foreignRoot = join(ctx.targetRoot, "demo");
    await mkdir(foreignRoot);
    await writeFile(join(foreignRoot, "KEEP"), "foreign-user-bytes\n");

    const result = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: ctx.registry,
      bytes: dependencies,
      authorizeMerge: () => true,
      acceptSources: () => true,
      createOperationId: () => "merge-foreign-path"
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ForeignTargetPathConflict");
    }
    assert.equal(
      await readFile(join(foreignRoot, "KEEP"), "utf8"),
      "foreign-user-bytes\n"
    );
    const current = ctx.registry.readTargetState(targetId);
    assert.equal(current.ok, true);
    if (current.ok) {
      assert.deepEqual(current.value, ctx.initialState);
    }
  });

  await withExistingTarget(async (ctx) => {
    const manualRoot = join(ctx.targetRoot, "local");
    await mkdir(manualRoot);
    await writeFile(
      join(manualRoot, "SKILL.md"),
      "---\nname: local\ndescription: existing user skill\n---\n"
    );
    const bytes = await fullUserSkillFixtureBytes("local");

    const result = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: ctx.registry,
      bytes,
      authorizeMerge: () => true,
      acceptSources: () => true,
      createOperationId: () => "merge-user-skill-conflict"
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ExactMergeConflict");
      if (result.error.code === "ExactMergeConflict") {
        assert.equal(result.error.facts.reason, "user-owned-path");
        assert.equal(result.error.facts.subject, "local");
      }
    }
    assert.match(
      await readFile(join(manualRoot, "SKILL.md"), "utf8"),
      /existing user skill/u
    );
    const current = ctx.registry.readTargetState(targetId);
    assert.equal(current.ok, true);
    if (current.ok) {
      assert.deepEqual(current.value, ctx.initialState);
    }
  });
});

test("existing detached ownership is preserved and incompatible imported detached bytes cannot overwrite it", async () => {
  await withExistingTarget(async (ctx) => {
    const plan = acceptedTargetPlan(ctx.initialState);
    assert.equal(plan.ok, true);
    if (!plan.ok) {
      return;
    }
    const projection = plan.value.projections.find(
      (entry) => entry.packageCoordinate === "acme/app/app"
    )!;
    const registryProjection = ctx.initialState.projections.find(
      (entry) => entry.packageCoordinate === "acme/app/app"
    )!;
    const current: TargetOwnedProjection = {
      projection,
      ownership: "managed",
      materialization: registryProjection.materialization
    };
    const detached = await detachTargetProjection({
      home: ctx.paths,
      targetRoot: ctx.targetRoot,
      operationId: "detach-before-merge",
      lock: ctx.lock,
      registry: ctx.registry,
      acceptedState: withoutGeneration(ctx.initialState),
      packageCoordinate: "acme/app/app",
      current
    });
    assert.equal(detached.ok, true);
    if (!detached.ok) {
      return;
    }
    await writeMarker(ctx.targetRoot, detached.value);
    await writeFile(
      join(ctx.targetRoot, "app", "USER-NOTE"),
      "keep-existing-detached\n"
    );

    const exportedPath = join(ctx.targetRoot, "existing-full.export");
    const exported = await exportFullTarget({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      destinationPath: exportedPath,
      lock: ctx.lock,
      registry: ctx.registry
    });
    assert.equal(exported.ok, true);
    if (!exported.ok) {
      return;
    }
    const bytes = await mutateDetachedPayload(
      await readFile(exportedPath)
    );
    await rm(exportedPath, { force: true });

    const result = await mergeExactPackage({
      home: ctx.paths,
      targetId,
      targetRoot: ctx.targetRoot,
      lock: ctx.lock,
      registry: ctx.registry,
      bytes,
      authorizeMerge: () => true,
      acceptSources: () => true,
      createOperationId: () => "merge-detached-conflict"
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ExactMergeConflict");
      if (result.error.code === "ExactMergeConflict") {
        assert.equal(
          result.error.facts.reason,
          "detached-user-content"
        );
      }
    }
    assert.equal(
      await readFile(join(ctx.targetRoot, "app", "USER-NOTE"), "utf8"),
      "keep-existing-detached\n"
    );
  });
});

type ExistingContext = Readonly<{
  paths: Parameters<typeof install>[0]["paths"];
  targetRoot: string;
  lock: Parameters<typeof install>[0]["lock"];
  registry: Awaited<ReturnType<typeof requireRegistry>>;
  initialState: Awaited<ReturnType<typeof install>>;
  initialStoreEntries: string[];
}>;

async function withExistingTarget(
  run: (input: ExistingContext) => Promise<void>
): Promise<void> {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const initialState = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: lifecycleFixture("v1.0.0"),
          requirements: [
            releasePackageRequirement("acme/app/app", "^1.0.0")
          ]
        });
        await writeMarker(targetRoot, initialState);
        await run({
          paths,
          targetRoot,
          lock,
          registry,
          initialState,
          initialStoreEntries:
            [...readdirSync(paths.storePath)].sort()
        });
      } finally {
        registry.close();
      }
    });
  });
}

async function assertUnchanged(ctx: ExistingContext): Promise<void> {
  assert.deepEqual(
    [...readdirSync(ctx.paths.storePath)].sort(),
    ctx.initialStoreEntries
  );
  const current = ctx.registry.readTargetState(targetId);
  assert.equal(current.ok, true);
  if (current.ok) {
    assert.deepEqual(current.value, ctx.initialState);
  }
  assert.equal(existsSync(join(ctx.targetRoot, "app")), true);
}

async function dependenciesFixtureBytes(): Promise<Uint8Array> {
  const fixture = JSON.parse(
    await readFile(
      join("behavior-fixtures", "export", "package-v1.json"),
      "utf8"
    )
  ) as { valid: { containerBase64: string } };
  return Uint8Array.from(
    Buffer.from(fixture.valid.containerBase64, "base64")
  );
}

async function conflictingSourceBytes(
  state: RegistryTargetState
): Promise<Uint8Array> {
  const currentSource = state.resolvedSources.find(
    (source) => source.repositoryCoordinate === "acme/app"
  )!;
  const snapshot = createPackageSnapshot([
    {
      path: "SKILL.md",
      executable: false,
      content: Uint8Array.from(
        Buffer.from(
          "---\nname: other\ndescription: source conflict fixture\n---\n"
        )
      )
    }
  ]);
  if (!snapshot.ok) {
    throw new Error("source conflict snapshot failed");
  }
  const payloadId = `package:${snapshot.value.contentDigest}`;
  const written = writeExactExportPackage({
    manifest: {
      format: "SKILOOM-EXPORT-V1",
      mode: "dependencies",
      requirements: [
        {
          kind: "package",
          coordinate: "acme/app/other",
          sourceKind: "github-release",
          versionRequirement: "^1.0.0"
        }
      ],
      sources: [
        {
          repositoryCoordinate: "acme/app",
          sourceKind: "github-release",
          version: "1.0.0",
          actualTag: "v1.0.0",
          exactCommit:
            currentSource.exactCommit === "f".repeat(40)
              ? "e".repeat(40)
              : "f".repeat(40),
          immutable: true
        }
      ],
      packages: [
        {
          packageCoordinate: "acme/app/other",
          packageRoot: ".",
          contentDigest: snapshot.value.contentDigest,
          payloadId
        }
      ],
      dependencies: [],
      projections: [
        {
          packageCoordinate: "acme/app/other",
          activationName: "other"
        }
      ],
      detached: [],
      userSkills: []
    },
    frames: snapshot.value.entries.map((entry) => ({
      payloadId,
      path: entry.path,
      executable: entry.executable,
      content: entry.content
    }))
  });
  if (!written.ok) {
    throw new Error("source conflict package failed");
  }
  return written.value;
}

async function fullUserSkillFixtureBytes(
  activationName: string
): Promise<Uint8Array> {
  const base = parseExactExportPackage(
    await dependenciesFixtureBytes()
  );
  if (!base.ok) {
    throw new Error("base fixture parse failed");
  }
  const payload = createUserPayload([
    {
      path: "SKILL.md",
      executable: false,
      content: Uint8Array.from(
        Buffer.from(
          `---\nname: ${activationName}\ndescription: imported user skill\n---\n`
        )
      )
    }
  ]);
  if (!payload.ok) {
    throw new Error("user fixture failed");
  }
  const written = writeExactExportPackage({
    manifest: {
      ...base.value.manifest,
      mode: "full",
      userSkills: [
        {
          activationName,
          skillName: activationName,
          payloadId: payload.value.payloadId,
          userContentDigest: payload.value.contentDigest
        }
      ]
    },
    frames: [
      ...base.value.frames,
      ...payload.value.entries.map((entry) => ({
        payloadId: payload.value.payloadId,
        path: entry.path,
        executable: entry.executable,
        content: entry.content
      }))
    ]
  });
  if (!written.ok) {
    throw new Error("full user fixture failed");
  }
  return written.value;
}

async function mutateDetachedPayload(
  bytes: Uint8Array
): Promise<Uint8Array> {
  const parsed = parseExactExportPackage(bytes);
  if (!parsed.ok) {
    throw new Error("existing full export parse failed");
  }
  const detached = parsed.value.manifest.detached[0]!;
  const payload = createUserPayload([
    {
      path: "SKILL.md",
      executable: false,
      content: Uint8Array.from(
        Buffer.from(
          "---\nname: app\ndescription: imported detached bytes\n---\n"
        )
      )
    }
  ]);
  if (!payload.ok) {
    throw new Error("detached mutation payload failed");
  }
  const frames = parsed.value.frames.filter(
    (frame) => frame.payloadId !== detached.payloadId
  );
  const written = writeExactExportPackage({
    manifest: {
      ...parsed.value.manifest,
      detached: [
        {
          ...detached,
          payloadId: payload.value.payloadId,
          userContentDigest: payload.value.contentDigest
        }
      ]
    },
    frames: [
      ...frames,
      ...payload.value.entries.map((entry) => ({
        payloadId: payload.value.payloadId,
        path: entry.path,
        executable: entry.executable,
        content: entry.content
      }))
    ]
  });
  if (!written.ok) {
    throw new Error("detached conflict package failed");
  }
  return written.value;
}

async function writeMarker(
  targetRoot: string,
  state: RegistryTargetState
): Promise<void> {
  const marker = targetStateMarkerFactsFromRegistryState(state);
  assert.equal(marker.ok, true);
  if (!marker.ok) {
    return;
  }
  assert.deepEqual(
    await writeTargetStateMarkerFile(targetRoot, marker.value),
    { ok: true, value: undefined }
  );
}

function withoutGeneration(
  state: RegistryTargetState
): RegistryTargetStateInput {
  const { generation: _generation, ...input } = state;
  return input;
}
