import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  TargetRecoveryMarkerFacts
} from "../../../src/domain/target/recovery.js";
import {
  readTargetStateMarkerFile,
  TARGET_STATE_MARKER_FILENAME,
  writeTargetStateMarkerFile
} from "../../../src/runtime/target-state-marker.js";

const first: TargetRecoveryMarkerFacts = {
  targetId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
  requirements: [],
  projectionOverrides: [],
  detached: []
};

const second: TargetRecoveryMarkerFacts = {
  targetId: "11111111-1111-4111-8111-111111111111",
  generation: 2,
  requirements: [
    {
      kind: "package",
      coordinate: "akira-tl/skills/ask-matt",
      sourceKind: "github-release",
      versionRequirement: "^1.4.0"
    }
  ],
  projectionOverrides: [
    {
      packageCoordinate: "akira-tl/skills/ask-matt",
      activationName: "matt"
    }
  ],
  detached: []
};

test("atomic target marker persistence replaces only complete canonical files", async () => {
  const root = await mkdtemp(join(tmpdir(), "skiloom-marker-"));
  try {
    assert.deepEqual(
      await readTargetStateMarkerFile(root),
      { ok: true, value: null }
    );

    assert.deepEqual(
      await writeTargetStateMarkerFile(root, first),
      { ok: true, value: undefined }
    );
    assert.deepEqual(
      await readTargetStateMarkerFile(root),
      { ok: true, value: first }
    );

    assert.deepEqual(
      await writeTargetStateMarkerFile(root, second),
      { ok: true, value: undefined }
    );
    assert.deepEqual(
      await readTargetStateMarkerFile(root),
      { ok: true, value: second }
    );

    const bytes = await readFile(
      join(root, TARGET_STATE_MARKER_FILENAME),
      "utf8"
    );
    assert.equal(
      bytes,
      'format = "SKILOOM-STATE-V1"\n' +
        'target-id = "11111111-1111-4111-8111-111111111111"\n' +
        'generation = 2\n\n' +
        '[[requirements]]\n' +
        'kind = "package"\n' +
        'coordinate = "akira-tl/skills/ask-matt"\n' +
        'source = "github-release"\n' +
        'version = "^1.4.0"\n\n' +
        '[[projection-overrides]]\n' +
        'package = "akira-tl/skills/ask-matt"\n' +
        'activation-name = "matt"\n'
    );
    assert.deepEqual(
      (await readdir(root)).filter((name) =>
        name.startsWith(`${TARGET_STATE_MARKER_FILENAME}.tmp-`)
      ),
      []
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed marker persistence does not create a partial final marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "skiloom-marker-missing-"));
  const missing = join(root, "missing-target");
  try {
    const result = await writeTargetStateMarkerFile(missing, first);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "TargetStateMarkerWriteFailed");
    }
    await assert.rejects(
      readFile(join(missing, TARGET_STATE_MARKER_FILENAME))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
