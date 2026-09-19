import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  parseTargetStateMarker,
  writeTargetStateMarker
} from "../../../../src/domain/target/state-marker.js";
import type {
  TargetOwnedProjection
} from "../../../../src/domain/target/preflight.js";
import {
  exportManagedDependencies
} from "../../../../src/runtime/export/dependencies.js";
import {
  exportFullTarget
} from "../../../../src/runtime/export/full.js";
import {
  importExactPackage
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
  targetStateMarkerFactsFromRegistryState
} from "../../../../src/runtime/target-state-recovery.js";
import {
  readTargetStateMarkerFile,
  TARGET_STATE_MARKER_FILENAME,
  writeTargetStateMarkerFile
} from "../../../../src/runtime/target-state-marker.js";
import {
  install,
  lifecycleFixture,
  requireRegistry,
  targetId as sourceTargetId,
  withRealLock,
  withRuntime
} from "../lifecycle/completion-fixture.js";
import {
  releasePackageRequirement
} from "../lifecycle/github-source-fixture.js";

const importedDependenciesTargetId =
  "99999999-9999-4999-8999-999999999999";
const importedFullTargetId =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("dependencies export reproduces exact managed state offline across HOME boundaries and re-exports byte-identically", async () => {
  let exportedBytes: Uint8Array | undefined;
  let sourceState: RegistryTargetState | undefined;

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        sourceState = await install({
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
        await writeMarker(targetRoot, sourceState);

        const markerBytes = await readFile(
          join(targetRoot, TARGET_STATE_MARKER_FILENAME),
          "utf8"
        );
        const parsedMarker = parseTargetStateMarker(markerBytes);
        assert.equal(parsedMarker.ok, true);
        if (parsedMarker.ok) {
          assert.equal(
            writeTargetStateMarker(parsedMarker.value),
            markerBytes,
            "public marker must round-trip canonically"
          );
        }

        const destination = join(
          targetRoot,
          "dependencies.skiloom-export"
        );
        const exported = await exportManagedDependencies({
          home: paths,
          targetId: sourceTargetId,
          targetRoot,
          destinationPath: destination,
          lock,
          registry
        });
        assert.equal(exported.ok, true);
        if (!exported.ok) {
          return;
        }
        exportedBytes = Uint8Array.from(
          await readFile(destination)
        );
        assertNoMachineIdentity(
          exportedBytes,
          sourceTargetId,
          [
            targetRoot,
            paths.homeRoot,
            paths.storePath,
            paths.sourceCachePath,
            paths.operationLockPath
          ]
        );
      } finally {
        registry.close();
      }
    });
  });

  assert.notEqual(exportedBytes, undefined);
  assert.notEqual(sourceState, undefined);
  const bytes = exportedBytes!;
  const expectedState = sourceState!;

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        let sourceAcceptanceCalls = 0;
        const imported = await importExactPackage({
          home: paths,
          targetRoot,
          lock,
          registry,
          bytes,
          acceptSources: (facts) => {
            sourceAcceptanceCalls += 1;
            assert.deepEqual(
              facts.sources.map(
                (source) => source.repositoryCoordinate
              ),
              ["acme/app", "acme/shared"]
            );
            return true;
          },
          createTargetId: () =>
            importedDependenciesTargetId,
          createOperationId: () =>
            "reproduction-dependencies-import"
        });
        assert.equal(imported.ok, true);
        if (!imported.ok || imported.value.status !== "imported") {
          return;
        }
        assert.equal(sourceAcceptanceCalls, 1);
        assert.equal(
          imported.value.state.targetId,
          importedDependenciesTargetId
        );
        assert.equal(imported.value.state.generation, 1);
        assert.notEqual(
          imported.value.state.targetId,
          expectedState.targetId
        );
        assert.deepEqual(
          exactManagedSemantics(imported.value.state),
          exactManagedSemantics(expectedState)
        );

        const marker = await readTargetStateMarkerFile(targetRoot);
        assert.equal(marker.ok, true);
        if (marker.ok) {
          assert.equal(
            marker.value?.targetId,
            importedDependenciesTargetId
          );
          assert.equal(marker.value?.generation, 1);
        }

        const reexportPath = join(
          targetRoot,
          "dependencies-repeat.skiloom-export"
        );
        const reexported = await exportManagedDependencies({
          home: paths,
          targetId: importedDependenciesTargetId,
          targetRoot,
          destinationPath: reexportPath,
          lock,
          registry
        });
        assert.equal(reexported.ok, true);
        assert.deepEqual(
          Uint8Array.from(await readFile(reexportPath)),
          bytes,
          "new target identity/generation must not perturb exact export bytes"
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("full export reproduces detached and manual user bytes offline without adopting ownership and re-exports byte-identically", async () => {
  let exportedBytes: Uint8Array | undefined;
  let detachedBaseline: RegistryTargetState["detachedBaselines"][number] | undefined;
  const detachedNote = "detached-user-note\n";
  const manualSkill =
    "---\nname: local\ndescription: manual reproduction skill\n---\nMANUAL-BYTES\n";

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const installed = await install({
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
        const plan = acceptedTargetPlan(installed);
        assert.equal(plan.ok, true);
        if (!plan.ok) {
          return;
        }
        const appPlan = plan.value.projections.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        )!;
        const appRegistry = installed.projections.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        )!;
        const current: TargetOwnedProjection = {
          projection: appPlan,
          ownership: "managed",
          materialization: appRegistry.materialization
        };
        const detached = await detachTargetProjection({
          home: paths,
          targetRoot,
          operationId: "reproduction-detach-app",
          lock,
          registry,
          acceptedState: withoutGeneration(installed),
          packageCoordinate: "acme/app/app",
          current
        });
        assert.equal(detached.ok, true);
        if (!detached.ok) {
          return;
        }
        detachedBaseline = detached.value.detachedBaselines.find(
          (entry) => entry.packageCoordinate === "acme/app/app"
        );
        assert.notEqual(detachedBaseline, undefined);
        await writeMarker(targetRoot, detached.value);
        await writeFile(
          join(targetRoot, "app", "USER-NOTE"),
          detachedNote,
          "utf8"
        );

        const localRoot = join(targetRoot, "local");
        await mkdir(localRoot);
        await writeFile(
          join(localRoot, "SKILL.md"),
          manualSkill,
          "utf8"
        );

        const destination = join(
          targetRoot,
          "full.skiloom-export"
        );
        const exported = await exportFullTarget({
          home: paths,
          targetId: sourceTargetId,
          targetRoot,
          destinationPath: destination,
          lock,
          registry
        });
        assert.equal(exported.ok, true);
        if (!exported.ok) {
          return;
        }
        exportedBytes = Uint8Array.from(
          await readFile(destination)
        );
        assertNoMachineIdentity(
          exportedBytes,
          sourceTargetId,
          [
            targetRoot,
            paths.homeRoot,
            paths.storePath,
            paths.sourceCachePath,
            paths.operationLockPath
          ]
        );
      } finally {
        registry.close();
      }
    });
  });

  const bytes = exportedBytes!;
  const expectedBaseline = detachedBaseline!;
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const imported = await importExactPackage({
          home: paths,
          targetRoot,
          lock,
          registry,
          bytes,
          acceptSources: () => true,
          createTargetId: () => importedFullTargetId,
          createOperationId: () =>
            "reproduction-full-import"
        });
        assert.equal(imported.ok, true);
        if (!imported.ok || imported.value.status !== "imported") {
          return;
        }
        assert.equal(imported.value.state.generation, 1);
        assert.equal(
          imported.value.state.projections.find(
            (entry) => entry.packageCoordinate === "acme/app/app"
          )?.ownership,
          "detached"
        );
        assert.deepEqual(
          imported.value.state.detachedBaselines.find(
            (entry) => entry.packageCoordinate === "acme/app/app"
          ),
          expectedBaseline
        );
        assert.equal(
          await readFile(
            join(targetRoot, "app", "USER-NOTE"),
            "utf8"
          ),
          detachedNote
        );
        assert.equal(
          await readFile(
            join(targetRoot, "local", "SKILL.md"),
            "utf8"
          ),
          manualSkill
        );
        assert.equal(
          imported.value.state.projections.some(
            (entry) => entry.activationName === "local"
          ),
          false,
          "manual Skill must remain user-owned/foreign"
        );
        assert.equal(
          imported.value.state.resolvedPackages.some(
            (entry) => entry.packageCoordinate.endsWith("/local")
          ),
          false
        );

        const reexportPath = join(
          targetRoot,
          "full-repeat.skiloom-export"
        );
        const reexported = await exportFullTarget({
          home: paths,
          targetId: importedFullTargetId,
          targetRoot,
          destinationPath: reexportPath,
          lock,
          registry
        });
        assert.equal(reexported.ok, true);
        assert.deepEqual(
          Uint8Array.from(await readFile(reexportPath)),
          bytes,
          "full reproduction must be canonical across target identities"
        );
      } finally {
        registry.close();
      }
    });
  });
});

function exactManagedSemantics(
  state: RegistryTargetState
): Readonly<Record<string, unknown>> {
  return {
    requirements: state.directRequirements,
    sources: state.resolvedSources,
    packages: state.resolvedPackages,
    edges: state.dependencyEdges,
    projections: state.projections.map((entry) => ({
      packageCoordinate: entry.packageCoordinate,
      activationName: entry.activationName,
      ownership: entry.ownership,
      transformJson: entry.transformJson
    })),
    detachedBaselines: state.detachedBaselines
  };
}

function assertNoMachineIdentity(
  bytes: Uint8Array,
  oldTargetId: string,
  paths: ReadonlyArray<string>
): void {
  const buffer = Buffer.from(bytes);
  const forbidden = [
    oldTargetId,
    "target-id",
    "generation =",
    "credential",
    "token",
    ...paths
  ];
  for (const value of forbidden) {
    assert.equal(
      buffer.includes(Buffer.from(value, "utf8")),
      false,
      `exact export leaked machine-local fact: ${value}`
    );
  }
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
