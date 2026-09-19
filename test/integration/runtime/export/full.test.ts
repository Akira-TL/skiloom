import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  parseExactExportPackage
} from "../../../../src/domain/export-package/index.js";
import type {
  TargetOwnedProjection
} from "../../../../src/domain/target/preflight.js";
import {
  exportFullTarget
} from "../../../../src/runtime/export/full.js";
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
  targetStateMarkerFactsFromRegistryState
} from "../../../../src/runtime/target-state-recovery.js";
import {
  writeTargetStateMarkerFile
} from "../../../../src/runtime/target-state-marker.js";
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

test("full exact export preserves detached and manual user bytes while deduplicating equal user payloads", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const state = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: lifecycleFixture("v1.0.0"),
          requirements: [
            releasePackageRequirement(
              "acme/app/app",
              "^1.0.0"
            )
          ]
        });
        await writeMarker(targetRoot, state);

        const plan = acceptedTargetPlan(state);
        assert.equal(plan.ok, true);
        if (!plan.ok) {
          return;
        }
        const projection = plan.value.projections.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        );
        const registryProjection = state.projections.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        );
        assert.notEqual(projection, undefined);
        assert.notEqual(registryProjection, undefined);
        const current: TargetOwnedProjection = {
          projection: projection!,
          ownership: "managed",
          materialization: registryProjection!.materialization
        };
        const detached = await detachTargetProjection({
          home: paths,
          targetRoot,
          operationId: "full-export-detach-app",
          lock,
          registry,
          acceptedState: withoutGeneration(state),
          packageCoordinate: "acme/app/app",
          current
        });
        assert.equal(detached.ok, true);
        if (!detached.ok) {
          return;
        }
        await writeMarker(targetRoot, detached.value);

        const sharedUserSkill =
          "---\nname: local\ndescription: full export user skill\n---\nUSER-FULL-PAYLOAD\n";
        await writeFile(
          join(targetRoot, "app", "SKILL.md"),
          sharedUserSkill,
          "utf8"
        );
        const appManifest = await readFile(
          join(targetRoot, "app", "skiloom-package.toml")
        );
        const manualRoot = join(targetRoot, "local");
        await mkdir(manualRoot);
        await writeFile(
          join(manualRoot, "SKILL.md"),
          sharedUserSkill,
          "utf8"
        );
        await writeFile(
          join(manualRoot, "skiloom-package.toml"),
          appManifest
        );

        const declaredRoot = join(targetRoot, "declared");
        await mkdir(declaredRoot);
        await writeFile(
          join(declaredRoot, "SKILL.md"),
          "---\nname: declared\ndescription: unresolved declaration fixture\n---\n",
          "utf8"
        );
        await writeFile(
          join(declaredRoot, "skiloom-package.toml"),
          'schema = 1\n\n[dependencies]\n"missing/repo/skill" = "^1.0.0"\n',
          "utf8"
        );

        const destination = join(
          targetRoot,
          "full.skiloom-export"
        );
        const exported = await exportFullTarget({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: destination,
          lock,
          registry
        });
        assert.equal(exported.ok, true);
        if (!exported.ok) {
          return;
        }

        const bytes = await readFile(destination);
        const parsed = parseExactExportPackage(bytes);
        assert.equal(parsed.ok, true);
        if (!parsed.ok) {
          return;
        }
        assert.equal(parsed.value.manifest.mode, "full");
        assert.equal(parsed.value.manifest.detached.length, 1);
        assert.deepEqual(
          parsed.value.manifest.detached.map((entry) => ({
            package: entry.packageCoordinate,
            activation: entry.activationName,
            source: entry.sourceKind,
            baselineDigest: entry.contentDigest
          })),
          [
            {
              package: "acme/app/app",
              activation: "app",
              source: "github-release",
              baselineDigest:
                detached.value.detachedBaselines[0]?.contentDigest
            }
          ]
        );
        assert.deepEqual(
          parsed.value.manifest.userSkills.map((entry) => [
            entry.activationName,
            entry.skillName
          ]),
          [
            ["declared", "declared"],
            ["local", "local"]
          ]
        );

        const detachedPayload =
          parsed.value.manifest.detached[0]!.payloadId;
        const manualPayload =
          parsed.value.manifest.userSkills.find(
            (entry) => entry.activationName === "local"
          )!.payloadId;
        assert.equal(detachedPayload, manualPayload);
        assert.equal(
          parsed.value.frames.filter(
            (frame) => frame.payloadId === detachedPayload
          ).length,
          2,
          "equal user trees must be framed once, with one frame per file"
        );
        assert.equal(
          Buffer.from(bytes).includes(
            Buffer.from("USER-FULL-PAYLOAD", "utf8")
          ),
          true
        );
        assert.equal(
          Buffer.from(bytes).includes(
            Buffer.from("missing/repo/skill", "utf8")
          ),
          true,
          "manual dependency declarations are payload bytes, not resolver input"
        );

        const secondDestination = join(
          targetRoot,
          "full-repeat.skiloom-export"
        );
        const repeated = await exportFullTarget({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: secondDestination,
          lock,
          registry
        });
        assert.equal(repeated.ok, true);
        assert.deepEqual(
          await readFile(secondDestination),
          bytes,
          "equivalent full exports must be byte-identical"
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("full exact export rejects detached ownership without its recorded baseline", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const state = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: lifecycleFixture("v1.0.0"),
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });

        const corrupted = registry.replaceTargetState({
          ...withoutGeneration(state),
          projections: state.projections.map((projection) =>
            projection.packageCoordinate === "acme/app/app"
              ? { ...projection, ownership: "detached" as const }
              : projection
          ),
          detachedBaselines: []
        });
        assert.equal(corrupted.ok, true);
        if (!corrupted.ok) {
          return;
        }
        await writeMarker(targetRoot, corrupted.value);

        const exported = await exportFullTarget({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: join(
            targetRoot,
            "missing-baseline.skiloom-export"
          ),
          lock,
          registry
        });
        assert.equal(exported.ok, false);
        if (!exported.ok) {
          assert.equal(
            exported.error.code,
            "InvalidFullExportTargetState"
          );
          if (
            exported.error.code ===
            "InvalidFullExportTargetState"
          ) {
            assert.equal(
              exported.error.facts.reason,
              "detached-baseline-missing"
            );
          }
        }
      } finally {
        registry.close();
      }
    });
  });
});

test("full exact export rejects a non-regular SKILL.md instead of silently omitting the manual root", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const state = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: lifecycleFixture("v1.0.0"),
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        await writeMarker(targetRoot, state);

        const manualRoot = join(targetRoot, "local");
        await mkdir(join(manualRoot, "SKILL.md"), {
          recursive: true
        });

        const exported = await exportFullTarget({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: join(
            targetRoot,
            "non-regular-skill.skiloom-export"
          ),
          lock,
          registry
        });
        assert.equal(exported.ok, false);
        if (!exported.ok) {
          assert.equal(
            exported.error.code,
            "FullExportTargetScanFailed"
          );
        }
      } finally {
        registry.close();
      }
    });
  });
});

test("full exact export rejects special entries inside a recognizable manual Skill without following them", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const state = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: lifecycleFixture("v1.0.0"),
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        await writeMarker(targetRoot, state);

        const manualRoot = join(targetRoot, "local");
        await mkdir(manualRoot);
        await writeFile(
          join(manualRoot, "SKILL.md"),
          "---\nname: local\ndescription: special entry fixture\n---\n",
          "utf8"
        );
        await symlink(
          "SKILL.md",
          join(manualRoot, "linked.md")
        );

        const exported = await exportFullTarget({
          home: paths,
          targetId,
          targetRoot,
          destinationPath: join(
            targetRoot,
            "special.skiloom-export"
          ),
          lock,
          registry
        });
        assert.equal(exported.ok, false);
        if (!exported.ok) {
          assert.equal(
            exported.error.code,
            "UnsupportedUserPayloadEntry"
          );
        }
      } finally {
        registry.close();
      }
    });
  });
});

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
