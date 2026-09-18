import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createNonInteractiveLifecycleAcceptance
} from "../../../../../src/runtime/orchestration/lifecycle/acceptance.js";
import {
  executeFirstAcceptedInstall
} from "../../../../../src/runtime/orchestration/lifecycle/first-install.js";
import {
  removeAcceptedTargetRequirement
} from "../../../../../src/runtime/orchestration/lifecycle/remove.js";
import {
  updateAcceptedTarget
} from "../../../../../src/runtime/orchestration/lifecycle/update.js";
import {
  release,
  releasePackageRequirement,
  releaseRepository,
  skillPackage,
  sourceFixture
} from "../github-source-fixture.js";
import {
  install,
  requireRegistry,
  targetId,
  withRealLock,
  withRuntime
} from "../completion-fixture.js";

test("non-interactive install without ordinary approval returns InteractionRequired before commit", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = singleAppFixture(
        "v1.0.0",
        "1",
        "Approval required."
      );
      const policy = createNonInteractiveLifecycleAcceptance({
        mode: "apply",
        ordinaryApproval: false,
        releaseRetargetApproval: false
      });
      let markerCalls = 0;

      try {
        const result = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry,
          directRequirements: [
            releasePackageRequirement("acme/app/app")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: policy.acceptCandidate,
          createTargetId: () => targetId,
          createOperationId: () => "policy-must-not-commit",
          syncMarker: () => {
            markerCalls += 1;
          }
        });

        assert.deepEqual(result, {
          ok: false,
          error: {
            code: "InteractionRequired",
            facts: {
              reason: "ordinary-approval-required",
              repositories: []
            }
          }
        });
        assert.equal(markerCalls, 0);
        assert.equal(existsSync(paths.storePath), false);
        assert.equal(existsSync(join(targetRoot, "app")), false);
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: undefined }
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("non-interactive ordinary approval applies install but does not bypass ownership safety", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    const foreign = join(targetRoot, "app");
    await mkdir(foreign);
    await writeFile(join(foreign, "KEEP"), "foreign\n");

    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = singleAppFixture(
        "v1.0.0",
        "2",
        "Approved but colliding."
      );
      const policy = createNonInteractiveLifecycleAcceptance({
        mode: "apply",
        ordinaryApproval: true,
        releaseRetargetApproval: false
      });

      try {
        const result = await executeFirstAcceptedInstall({
          home: paths,
          targetRoot,
          lock,
          registry,
          directRequirements: [
            releasePackageRequirement("acme/app/app")
          ],
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: policy.acceptCandidate,
          createTargetId: () => targetId,
          createOperationId: () => "policy-foreign",
          syncMarker: () => {}
        });

        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error.code, "ForeignTargetPathConflict");
        }
        assert.equal(
          await readFile(join(foreign, "KEEP"), "utf8"),
          "foreign\n"
        );
        assert.equal(existsSync(paths.storePath), false);
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: undefined }
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("plan-only policy returns remove candidate without changing accepted state Store or Target", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = singleAppFixture(
        "v1.0.0",
        "3",
        "Plan-only remove."
      );

      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture,
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        const storeBefore = [...readdirSync(paths.storePath)].sort();
        const liveBefore = await readFile(
          join(targetRoot, "app", "SKILL.md"),
          "utf8"
        );
        const policy = createNonInteractiveLifecycleAcceptance({
          mode: "plan",
          ordinaryApproval: false,
          releaseRetargetApproval: false
        });
        let markerCalls = 0;

        const result = await removeAcceptedTargetRequirement({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          remove: {
            kind: "package",
            coordinate: "acme/app/app"
          },
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          acceptCandidate: policy.acceptCandidate,
          createOperationId: () => "plan-remove-must-not-run",
          syncMarker: () => {
            markerCalls += 1;
          }
        });

        assert.equal(result.ok, true);
        if (!result.ok) {
          return;
        }
        assert.equal(result.value.status, "planned");
        assert.equal(result.value.plan.noChange, false);
        assert.deepEqual(
          result.value.plan.directRequirements,
          []
        );
        assert.equal(markerCalls, 0);
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: initial }
        );
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );
        assert.equal(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          liveBefore
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("non-interactive identical update succeeds as no-op without ordinary approval", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const fixture = singleAppFixture(
        "v1.0.0",
        "4",
        "No-op policy."
      );

      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture,
          requirements: [
            releasePackageRequirement("acme/app/app")
          ]
        });
        const policy = createNonInteractiveLifecycleAcceptance({
          mode: "apply",
          ordinaryApproval: false,
          releaseRetargetApproval: false
        });

        const result = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          repositoryTransport: fixture.repositoryTransport,
          transport: fixture.transport,
          authorizeReleaseRetarget:
            policy.authorizeReleaseRetarget,
          acceptCandidate: policy.acceptCandidate,
          createOperationId: () => "no-op-policy-must-not-run",
          syncMarker: () => {
            assert.fail("no-op must not sync marker");
          }
        });

        assert.equal(result.ok, true);
        if (!result.ok) {
          return;
        }
        assert.equal(result.value.status, "no-op");
        assert.equal(result.value.state.generation, 1);
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: initial }
        );
      } finally {
        registry.close();
      }
    });
  });
});

test("non-interactive Release retarget requires separate retarget approval even with ordinary approval", async () => {
  await withRuntime(async ({ paths, targetRoot }) => {
    await withRealLock(paths, async (lock) => {
      const registry = await requireRegistry(paths, lock);
      const initialFixture = singleAppFixture(
        "v1.0.0",
        "5",
        "Retarget original."
      );

      try {
        const initial = await install({
          paths,
          targetRoot,
          lock,
          registry,
          fixture: initialFixture,
          requirements: [
            releasePackageRequirement(
              "acme/app/app",
              "^1.0.0"
            )
          ]
        });
        const retargetFixture = singleAppFixture(
          "v1.0.0",
          "6",
          "Retarget replacement."
        );
        const policy = createNonInteractiveLifecycleAcceptance({
          mode: "apply",
          ordinaryApproval: true,
          releaseRetargetApproval: false
        });
        const storeBefore = [...readdirSync(paths.storePath)].sort();

        const blocked = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          repositoryTransport:
            retargetFixture.repositoryTransport,
          transport: retargetFixture.transport,
          authorizeReleaseRetarget:
            policy.authorizeReleaseRetarget,
          acceptCandidate: policy.acceptCandidate,
          createOperationId: () => "retarget-policy-blocked",
          syncMarker: () => {}
        });

        assert.deepEqual(blocked, {
          ok: false,
          error: {
            code: "InteractionRequired",
            facts: {
              reason:
                "release-retarget-authorization-required",
              repositories: ["acme/app"]
            }
          }
        });
        assert.deepEqual(
          registry.readTargetState(targetId),
          { ok: true, value: initial }
        );
        assert.deepEqual(
          [...readdirSync(paths.storePath)].sort(),
          storeBefore
        );

        const approvedPolicy =
          createNonInteractiveLifecycleAcceptance({
            mode: "apply",
            ordinaryApproval: true,
            releaseRetargetApproval: true
          });
        const accepted = await updateAcceptedTarget({
          home: paths,
          targetId,
          targetRoot,
          lock,
          registry,
          repositoryTransport:
            retargetFixture.repositoryTransport,
          transport: retargetFixture.transport,
          authorizeReleaseRetarget:
            approvedPolicy.authorizeReleaseRetarget,
          acceptCandidate: approvedPolicy.acceptCandidate,
          createOperationId: () => "retarget-policy-approved",
          syncMarker: () => {}
        });

        assert.equal(accepted.ok, true);
        if (!accepted.ok || accepted.value.status !== "updated") {
          return;
        }
        assert.equal(accepted.value.state.generation, 2);
        assert.match(
          await readFile(join(targetRoot, "app", "SKILL.md"), "utf8"),
          /Retarget replacement\./u
        );
      } finally {
        registry.close();
      }
    });
  });
});

function singleAppFixture(
  tag: string,
  commitSeed: string,
  description: string
) {
  return sourceFixture([
    releaseRepository("acme/app", [
      release(tag, commitSeed, [
        skillPackage(".", "app", description)
      ])
    ])
  ]);
}
