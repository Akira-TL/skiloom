import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import {
  lstat,
  readFile,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  parseExactExportPackage,
  writeExactExportPackage,
  type ExactExportFileFrame
} from "../../../../src/domain/export-package/index.js";
import {
  createUserPayload,
  type UserPayload
} from "../../../../src/domain/user-payload/index.js";
import {
  createPackageSnapshot
} from "../../../../src/domain/snapshot/index.js";
import {
  importExactPackage
} from "../../../../src/runtime/import/index.js";
import type {
  MachineRegistry
} from "../../../../src/runtime/registry/index.js";
import {
  readTargetStateMarkerFile
} from "../../../../src/runtime/target-state-marker.js";
import {
  requireRegistry,
  withRealLock,
  withRuntime
} from "../lifecycle/completion-fixture.js";

const importedTargetId =
  "99999999-9999-4999-8999-999999999999";

test("dependencies exact import is fully offline and commits Store then DB then Target then marker with a new identity", async () => {
  const bytes = await dependenciesFixtureBytes();

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const opened = await requireRegistry(paths, lock);
      const events: string[] = [];
      const registry = observeRegistry(opened, () => {
        assert.equal(existsSync(paths.storePath), true);
        assert.equal(readdirSync(paths.storePath).length, 1);
        assert.equal(
          existsSync(join(targetRoot, "demo")),
          false,
          "live projection must not exist before Registry authority commits"
        );
        events.push("registry-commit");
      });
      try {
        const imported = await importExactPackage({
          home: paths,
          targetRoot,
          lock,
          registry,
          bytes,
          acceptSources: (facts) => {
            assert.equal(existsSync(paths.storePath), false);
            assert.deepEqual(
              facts.sources.map((source) => [
                source.repositoryCoordinate,
                source.sourceKind,
                source.exactCommit
              ]),
              [[
                "acme/demo",
                "github-release",
                "0123456789abcdef0123456789abcdef01234567"
              ]]
            );
            events.push("source-acceptance");
            return true;
          },
          createTargetId: () => importedTargetId,
          createOperationId: () => "offline-import-dependencies"
        });

        assert.equal(imported.ok, true);
        if (!imported.ok || imported.value.status !== "imported") {
          return;
        }
        assert.equal(imported.value.state.targetId, importedTargetId);
        assert.equal(imported.value.state.generation, 1);
        assert.deepEqual(events, [
          "source-acceptance",
          "registry-commit"
        ]);
        assert.equal(existsSync(join(targetRoot, "demo")), true);
        assert.match(
          await readFile(
            join(targetRoot, "demo", "SKILL.md"),
            "utf8"
          ),
          /name: demo/u
        );
        const marker = await readTargetStateMarkerFile(targetRoot);
        assert.equal(marker.ok, true);
        if (marker.ok) {
          assert.equal(marker.value?.targetId, importedTargetId);
          assert.equal(marker.value?.generation, 1);
        }
      } finally {
        opened.close();
      }
    });
  });
});

test("declined source acceptance and corrupt package bytes stop before Store Registry or Target mutation", async () => {
  const bytes = await dependenciesFixtureBytes();

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      try {
        const declined = await importExactPackage({
          home: paths,
          targetRoot,
          lock,
          registry,
          bytes,
          acceptSources: () => false,
          createTargetId: () => importedTargetId,
          createOperationId: () => "declined-import"
        });
        assert.equal(declined.ok, true);
        if (declined.ok) {
          assert.equal(declined.value.status, "declined");
        }
        assert.equal(existsSync(paths.storePath), false);
        assert.deepEqual(
          registry.readTargetState(importedTargetId),
          { ok: true, value: undefined }
        );
        assert.deepEqual(readdirSync(targetRoot), []);

        const corrupt = Buffer.from(bytes);
        corrupt[corrupt.length - 1] =
          (corrupt[corrupt.length - 1] ?? 0) ^ 0xff;
        let acceptanceCalls = 0;
        const invalid = await importExactPackage({
          home: paths,
          targetRoot,
          lock,
          registry,
          bytes: corrupt,
          acceptSources: () => {
            acceptanceCalls += 1;
            return true;
          },
          createTargetId: () => importedTargetId,
          createOperationId: () => "corrupt-import"
        });
        assert.equal(invalid.ok, false);
        assert.equal(acceptanceCalls, 0);
        assert.equal(existsSync(paths.storePath), false);
        assert.deepEqual(
          registry.readTargetState(importedTargetId),
          { ok: true, value: undefined }
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("shared managed payloads are re-admitted for every Package coordinate before source acceptance", async () => {
  const bytes = await mismatchedSharedPayloadBytes();

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      let acceptanceCalls = 0;
      try {
        const imported = await importExactPackage({
          home: paths,
          targetRoot,
          lock,
          registry,
          bytes,
          acceptSources: () => {
            acceptanceCalls += 1;
            return true;
          },
          createTargetId: () => importedTargetId,
          createOperationId: () => "shared-payload-name-mismatch"
        });

        assert.equal(imported.ok, false);
        if (!imported.ok) {
          assert.equal(
            imported.error.code,
            "InvalidExactImportPackageFacts"
          );
          if (
            imported.error.code ===
            "InvalidExactImportPackageFacts"
          ) {
            assert.equal(
              imported.error.facts.reason,
              "managed-skill-invalid"
            );
            assert.equal(
              imported.error.facts.subject,
              "acme/demo/other"
            );
          }
        }
        assert.equal(acceptanceCalls, 0);
        assert.equal(existsSync(paths.storePath), false);
        assert.deepEqual(readdirSync(targetRoot), []);
      } finally {
        registry.close();
      }
    });
  });
});

test("managed package metadata dependency coordinates must match the recorded exact graph before acceptance", async () => {
  const bytes = await metadataMismatchBytes();

  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      let acceptanceCalls = 0;
      try {
        const imported = await importExactPackage({
          home: paths,
          targetRoot,
          lock,
          registry,
          bytes,
          acceptSources: () => {
            acceptanceCalls += 1;
            return true;
          },
          createTargetId: () => importedTargetId,
          createOperationId: () => "metadata-graph-mismatch"
        });

        assert.equal(imported.ok, false);
        if (!imported.ok) {
          assert.equal(
            imported.error.code,
            "InvalidExactImportPackageFacts"
          );
          if (
            imported.error.code ===
            "InvalidExactImportPackageFacts"
          ) {
            assert.equal(
              imported.error.facts.reason,
              "managed-dependency-mismatch"
            );
          }
        }
        assert.equal(acceptanceCalls, 0);
        assert.equal(existsSync(paths.storePath), false);
        assert.deepEqual(readdirSync(targetRoot), []);
      } finally {
        registry.close();
      }
    });
  });
});

test("exact import refuses a non-empty selected Target without adopting or overwriting foreign bytes", async () => {
  const bytes = await dependenciesFixtureBytes();

  await withRuntime(async ({ paths, targetRoot }) => {
    await writeFile(join(targetRoot, "KEEP"), "foreign\n");
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
          createTargetId: () => importedTargetId,
          createOperationId: () => "foreign-target-import"
        });
        assert.equal(imported.ok, false);
        if (!imported.ok) {
          assert.equal(
            imported.error.code,
            "ExactImportTargetNotEmpty"
          );
        }
        assert.equal(
          await readFile(join(targetRoot, "KEEP"), "utf8"),
          "foreign\n"
        );
        assert.equal(existsSync(paths.storePath), false);
      } finally {
        registry.close();
      }
    });
  });
});

test("full exact import restores detached and manual user payloads as user-owned content while retaining managed baseline Store state", async () => {
  const bytes = await fullFixtureBytes();

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
          createTargetId: () => importedTargetId,
          createOperationId: () => "offline-import-full"
        });
        assert.equal(imported.ok, true);
        if (!imported.ok || imported.value.status !== "imported") {
          return;
        }

        const state = imported.value.state;
        assert.equal(state.generation, 1);
        assert.equal(
          state.projections.find(
            (entry) => entry.packageCoordinate === "acme/demo/demo"
          )?.ownership,
          "detached"
        );
        assert.equal(state.detachedBaselines.length, 1);
        assert.equal(readdirSync(paths.storePath).length, 1);
        assert.match(
          await readFile(
            join(targetRoot, "demo", "SKILL.md"),
            "utf8"
          ),
          /detached import bytes/u
        );
        assert.equal(
          await readFile(
            join(targetRoot, "demo", "USER-NOTE"),
            "utf8"
          ),
          "detached-user-note\n"
        );
        assert.match(
          await readFile(
            join(targetRoot, "local", "SKILL.md"),
            "utf8"
          ),
          /manual import bytes/u
        );
        assert.equal(
          state.projections.some(
            (entry) => entry.activationName === "local"
          ),
          false
        );
        assert.equal(
          state.resolvedPackages.some(
            (entry) => entry.packageCoordinate.includes("local")
          ),
          false
        );
        const demo = await lstat(join(targetRoot, "demo"));
        const local = await lstat(join(targetRoot, "local"));
        assert.equal(demo.isDirectory(), true);
        assert.equal(demo.isSymbolicLink(), false);
        assert.equal(local.isDirectory(), true);

        const marker = await readTargetStateMarkerFile(targetRoot);
        assert.equal(marker.ok, true);
        if (marker.ok) {
          assert.equal(marker.value?.generation, 1);
          assert.equal(marker.value?.detached.length, 1);
          assert.equal(
            marker.value?.detached[0]?.packageCoordinate,
            "acme/demo/demo"
          );
        }
      } finally {
        registry.close();
      }
    });
  });
});

function observeRegistry(
  registry: MachineRegistry,
  afterReplace: () => void
): MachineRegistry {
  return {
    close: () => registry.close(),
    pragmas: () => registry.pragmas(),
    readTargetState: (id) => registry.readTargetState(id),
    readPendingOperations: () => registry.readPendingOperations(),
    beginPendingOperation: (id, pending) =>
      registry.beginPendingOperation(id, pending),
    beginPendingReconciliation: (id, pending) =>
      registry.beginPendingReconciliation(id, pending),
    completePendingOperation: (operationId) =>
      registry.completePendingOperation(operationId),
    replaceTargetState: (state, pendingOperationId) => {
      const result = registry.replaceTargetState(
        state,
        pendingOperationId
      );
      if (result.ok) {
        afterReplace();
      }
      return result;
    }
  };
}

async function dependenciesFixtureBytes(): Promise<Uint8Array> {
  const fixture = JSON.parse(
    await readFile(
      join(
        "behavior-fixtures",
        "export",
        "package-v1.json"
      ),
      "utf8"
    )
  ) as { valid: { containerBase64: string } };
  return Uint8Array.from(
    Buffer.from(fixture.valid.containerBase64, "base64")
  );
}

async function mismatchedSharedPayloadBytes(): Promise<Uint8Array> {
  const base = parseExactExportPackage(
    await dependenciesFixtureBytes()
  );
  if (!base.ok) {
    throw new Error("base exact-export fixture did not parse");
  }
  const packageFact = base.value.manifest.packages[0]!;
  const written = writeExactExportPackage({
    manifest: {
      ...base.value.manifest,
      requirements: [
        ...base.value.manifest.requirements,
        {
          kind: "package",
          coordinate: "acme/demo/other",
          sourceKind: "github-release",
          versionRequirement: "^1.0.0"
        }
      ],
      packages: [
        packageFact,
        {
          ...packageFact,
          packageCoordinate: "acme/demo/other"
        }
      ],
      projections: [
        ...base.value.manifest.projections,
        {
          packageCoordinate: "acme/demo/other",
          activationName: "other"
        }
      ]
    },
    frames: base.value.frames
  });
  if (!written.ok) {
    throw new Error("mismatched shared-payload fixture did not encode");
  }
  return written.value;
}

async function metadataMismatchBytes(): Promise<Uint8Array> {
  const base = parseExactExportPackage(
    await dependenciesFixtureBytes()
  );
  if (!base.ok) {
    throw new Error("base exact-export fixture did not parse");
  }

  const snapshot = createPackageSnapshot([
    {
      path: "SKILL.md",
      executable: false,
      content: Uint8Array.from(
        Buffer.from(
          "---\nname: demo\ndescription: metadata mismatch fixture\n---\n",
          "utf8"
        )
      )
    },
    {
      path: "skiloom-package.toml",
      executable: false,
      content: Uint8Array.from(
        Buffer.from(
          'schema = 1\n\n[dependencies]\n"acme/missing/missing" = "^1.0.0"\n',
          "utf8"
        )
      )
    }
  ]);
  if (!snapshot.ok) {
    throw new Error("metadata mismatch snapshot failed");
  }
  const payloadId = `package:${snapshot.value.contentDigest}`;
  const packageFact = base.value.manifest.packages[0]!;
  const written = writeExactExportPackage({
    manifest: {
      ...base.value.manifest,
      packages: [
        {
          ...packageFact,
          contentDigest: snapshot.value.contentDigest,
          payloadId
        }
      ]
    },
    frames: snapshot.value.entries.map((entry) => ({
      payloadId,
      path: entry.path,
      executable: entry.executable,
      content: entry.content
    }))
  });
  if (!written.ok) {
    throw new Error("metadata mismatch fixture did not encode");
  }
  return written.value;
}

async function fullFixtureBytes(): Promise<Uint8Array> {
  const baseBytes = await dependenciesFixtureBytes();
  const base = parseExactExportPackage(baseBytes);
  if (!base.ok) {
    throw new Error("base exact-export fixture did not parse");
  }

  const detachedPayload = createUserPayload([
    userEntry(
      "SKILL.md",
      "---\nname: demo\ndescription: detached import bytes\n---\n"
    ),
    userEntry("USER-NOTE", "detached-user-note\n")
  ]);
  const manualPayload = createUserPayload([
    userEntry(
      "SKILL.md",
      "---\nname: local\ndescription: manual import bytes\n---\n"
    )
  ]);
  assert.equal(detachedPayload.ok, true);
  assert.equal(manualPayload.ok, true);
  if (!detachedPayload.ok || !manualPayload.ok) {
    throw new Error("user payload fixture failed");
  }

  const managed = base.value.manifest;
  const source = managed.sources[0]!;
  assert.equal(source.sourceKind, "github-release");
  if (source.sourceKind !== "github-release") {
    throw new Error("expected release source fixture");
  }
  const packageFact = managed.packages[0]!;
  const fullManifest = {
    ...managed,
    mode: "full" as const,
    detached: [
      {
        packageCoordinate: packageFact.packageCoordinate,
        activationName: "demo",
        payloadId: detachedPayload.value.payloadId,
        userContentDigest:
          detachedPayload.value.contentDigest,
        sourceKind: "github-release" as const,
        version: source.version,
        actualTag: source.actualTag,
        exactCommit: source.exactCommit,
        packageRoot: packageFact.packageRoot,
        contentDigest: packageFact.contentDigest
      }
    ],
    userSkills: [
      {
        activationName: "local",
        skillName: "local",
        payloadId: manualPayload.value.payloadId,
        userContentDigest: manualPayload.value.contentDigest
      }
    ]
  };
  const userFrames: ExactExportFileFrame[] = [
    ...framesFor(detachedPayload.value),
    ...framesFor(manualPayload.value)
  ];
  const written = writeExactExportPackage({
    manifest: fullManifest,
    frames: [...base.value.frames, ...userFrames]
  });
  if (!written.ok) {
    throw new Error("full exact-export fixture did not encode");
  }
  return written.value;
}

function userEntry(path: string, content: string) {
  return {
    path,
    executable: false,
    content: Uint8Array.from(Buffer.from(content, "utf8"))
  };
}

function framesFor(
  payload: UserPayload
): ExactExportFileFrame[] {
  return payload.entries.map((entry) => ({
    payloadId: payload.payloadId,
    path: entry.path,
    executable: entry.executable,
    content: entry.content
  }));
}
