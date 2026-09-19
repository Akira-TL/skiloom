import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  TargetRecoveryMarkerFacts
} from "../../../src/domain/target/recovery.js";
import type {
  RegistryTargetState
} from "../../../src/runtime/registry/index.js";
import {
  inspectTargetRecovery,
  repairTargetStateMarkerFromRegistry,
  targetStateMarkerFactsFromRegistryState
} from "../../../src/runtime/target-state-recovery.js";
import {
  syncLifecycleMarker
} from "../../../src/runtime/orchestration/lifecycle/marker/index.js";
import {
  TARGET_STATE_MARKER_FILENAME,
  writeTargetStateMarkerFile
} from "../../../src/runtime/target-state-marker.js";

const state = registryState();
const marker = expectedMarker(5);

test("Registry marker facts omit default activation names from sparse projection overrides", () => {
  const defaultProjectionState: RegistryTargetState = {
    ...state,
    projections: [
      {
        packageCoordinate: "akira-tl/skills/ask-matt",
        activationName: "ask-matt",
        ownership: "managed",
        materialization: "symlink",
        transformJson: null
      }
    ]
  };

  const facts = targetStateMarkerFactsFromRegistryState(
    defaultProjectionState
  );

  assert.equal(facts.ok, true);
  if (facts.ok) {
    assert.deepEqual(facts.value.projectionOverrides, []);
  }
});

test("runtime Target recovery inspection delegates current stale ahead and identity semantics to the domain decision", async () => {
  await withTarget(async (targetRoot) => {
    assert.deepEqual(
      targetStateMarkerFactsFromRegistryState(state),
      { ok: true, value: marker }
    );

    assert.deepEqual(
      await writeTargetStateMarkerFile(targetRoot, marker),
      { ok: true, value: undefined }
    );
    const current = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      },
      staleChoice: null
    });
    assert.deepEqual(current, {
      ok: true,
      value: {
        markerStatus: "valid",
        markerError: null,
        decision: {
          kind: "current",
          targetId: state.targetId,
          generation: 5
        }
      }
    });

    assert.deepEqual(
      await writeTargetStateMarkerFile(
        targetRoot,
        expectedMarker(4)
      ),
      { ok: true, value: undefined }
    );
    const stale = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      },
      staleChoice: null
    });
    assert.equal(stale.ok, true);
    if (stale.ok) {
      assert.deepEqual(stale.value.decision, {
        kind: "choice-required",
        targetId: state.targetId,
        markerGeneration: 4,
        registryGeneration: 5,
        choices: ["sync", "fork"]
      });
    }

    const forkChoice = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      },
      staleChoice: {
        kind: "fork",
        newTargetId: "33333333-3333-4333-8333-333333333333"
      }
    });
    assert.equal(forkChoice.ok, true);
    if (forkChoice.ok) {
      assert.equal(forkChoice.value.decision.kind, "fork-candidate");
      if (forkChoice.value.decision.kind === "fork-candidate") {
        assert.equal(
          forkChoice.value.decision.targetId,
          "33333333-3333-4333-8333-333333333333"
        );
        assert.equal(
          forkChoice.value.decision.requiresSourceConfirmation,
          true
        );
      }
    }

    const syncChoice = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      },
      staleChoice: { kind: "sync" }
    });
    assert.equal(syncChoice.ok, true);
    if (syncChoice.ok) {
      assert.deepEqual(syncChoice.value.decision, {
        kind: "sync-to-registry",
        targetId: state.targetId,
        fromGeneration: 4,
        toGeneration: 5
      });
    }

    await writeTargetStateMarkerFile(
      targetRoot,
      expectedMarker(6)
    );
    const ahead = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      },
      staleChoice: null
    });
    assert.equal(ahead.ok, false);
    if (!ahead.ok) {
      assert.equal(ahead.error.code, "TargetRecoveryConflict");
      assert.equal(
        ahead.error.facts.reason,
        "marker-generation-ahead"
      );
    }

    await writeTargetStateMarkerFile(targetRoot, {
      ...marker,
      targetId: "22222222-2222-4222-8222-222222222222"
    });
    const mismatch = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      },
      staleChoice: null
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.error.code, "TargetRecoveryConflict");
      assert.equal(
        mismatch.error.facts.reason,
        "target-id-mismatch"
      );
    }
  });
});

test("missing or invalid marker is repairable only when Registry projections were proven exact", async () => {
  await withTarget(async (targetRoot) => {
    const missing = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      },
      staleChoice: null
    });
    assert.equal(missing.ok, true);
    if (missing.ok) {
      assert.equal(missing.value.markerStatus, "missing");
      assert.deepEqual(missing.value.decision, {
        kind: "repair-marker",
        targetId: state.targetId,
        generation: 5
      });
    }

    const drift = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: false
      },
      staleChoice: null
    });
    assert.equal(drift.ok, true);
    if (drift.ok) {
      assert.deepEqual(drift.value.decision, {
        kind: "reconcile-to-registry",
        targetId: state.targetId,
        generation: 5,
        reason: "missing-marker"
      });
    }

    await writeFile(
      join(targetRoot, TARGET_STATE_MARKER_FILENAME),
      'format = "SKILOOM-STATE-V1"\ninvalid = true\n',
      "utf8"
    );
    const invalid = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      },
      staleChoice: null
    });
    assert.equal(invalid.ok, true);
    if (invalid.ok) {
      assert.equal(invalid.value.markerStatus, "invalid");
      assert.equal(
        invalid.value.markerError?.code,
        "InvalidTargetState"
      );
      assert.equal(invalid.value.decision.kind, "repair-marker");
    }

    const repaired = await repairTargetStateMarkerFromRegistry({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      }
    });
    assert.deepEqual(repaired, {
      ok: true,
      value: marker
    });

    const after = await inspectTargetRecovery({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: true
      },
      staleChoice: null
    });
    assert.equal(after.ok, true);
    if (after.ok) {
      assert.equal(after.value.markerStatus, "valid");
      assert.equal(after.value.decision.kind, "current");
    }

    const notAllowed = await repairTargetStateMarkerFromRegistry({
      targetRoot,
      registryState: state,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: false
      }
    });
    assert.equal(notAllowed.ok, false);
    if (!notAllowed.ok) {
      assert.equal(
        notAllowed.error.code,
        "TargetStateMarkerRepairNotAllowed"
      );
    }
  });
});

test("lifecycle marker handoff rejects non-canonical facts before callback or filesystem persistence", async () => {
  await withTarget(async (targetRoot) => {
    let callbackCalls = 0;
    const result = await syncLifecycleMarker({
      targetRoot,
      marker: {
        ...marker,
        targetId: "not-a-valid-target-id"
      },
      override: () => {
        callbackCalls += 1;
      }
    });

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "LifecycleMarkerSyncFailed",
        facts: {
          targetId: "not-a-valid-target-id",
          generation: marker.generation
        }
      }
    });
    assert.equal(callbackCalls, 0);
  });
});

test("Registry loss uses only valid marker intent and never infers recovery facts from Target bytes", async () => {
  await withTarget(async (targetRoot) => {
    await writeTargetStateMarkerFile(targetRoot, marker);
    const recovered = await inspectTargetRecovery({
      targetRoot,
      registryState: null,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: false
      },
      staleChoice: null
    });
    assert.equal(recovered.ok, true);
    if (recovered.ok) {
      assert.deepEqual(recovered.value.decision, {
        kind: "recover-candidate",
        targetId: marker.targetId,
        intent: {
          requirements: marker.requirements,
          projectionOverrides: marker.projectionOverrides,
          detached: marker.detached
        },
        requiresSourceConfirmation: true
      });
    }
  });

  await withTarget(async (targetRoot) => {
    const unavailable = await inspectTargetRecovery({
      targetRoot,
      registryState: null,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: false
      },
      staleChoice: null
    });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) {
      assert.equal(unavailable.error.code, "TargetRecoveryConflict");
      assert.equal(
        unavailable.error.facts.reason,
        "registry-and-marker-unavailable"
      );
    }
  });

  await withTarget(async (targetRoot) => {
    await writeFile(
      join(targetRoot, TARGET_STATE_MARKER_FILENAME),
      "not = [valid",
      "utf8"
    );
    const invalid = await inspectTargetRecovery({
      targetRoot,
      registryState: null,
      target: {
        pathPresent: true,
        projectionsVerifiedExact: false
      },
      staleChoice: null
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.error.code, "InvalidTargetState");
    }
  });
});

function registryState(): RegistryTargetState {
  return {
    targetId: "11111111-1111-4111-8111-111111111111",
    generation: 5,
    locations: [
      { path: "/machine/local/target", observedGeneration: 5 }
    ],
    directRequirements: [
      {
        kind: "package",
        coordinate: "akira-tl/skills/ask-matt",
        sourceKind: "github-release",
        versionRequirement: "^1.4.0"
      }
    ],
    resolvedSources: [],
    resolvedPackages: [],
    dependencyEdges: [],
    projections: [
      {
        packageCoordinate: "akira-tl/skills/ask-matt",
        activationName: "matt",
        ownership: "managed",
        materialization: "symlink",
        transformJson: null
      }
    ],
    detachedBaselines: [
      {
        packageCoordinate: "akira-tl/skills/local-helper",
        repositoryCoordinate: "akira-tl/skills",
        sourceKind: "git",
        requestedRef: "main",
        exactCommit:
          "0123456789abcdef0123456789abcdef01234567",
        packageRoot: "skills/local-helper",
        contentDigest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    ],
    dependencyObservations: []
  };
}

function expectedMarker(
  generation: number
): TargetRecoveryMarkerFacts {
  return {
    targetId: state.targetId,
    generation,
    requirements: state.directRequirements,
    projectionOverrides: [
      {
        packageCoordinate: "akira-tl/skills/ask-matt",
        activationName: "matt"
      }
    ],
    detached: [
      {
        packageCoordinate: "akira-tl/skills/local-helper",
        sourceKind: "git",
        requestedRef: "main",
        exactCommit:
          "0123456789abcdef0123456789abcdef01234567",
        packageRoot: "skills/local-helper",
        contentDigest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    ]
  };
}

async function withTarget(
  run: (targetRoot: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skiloom-recovery-marker-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
