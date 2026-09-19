import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseExactExportPackage,
  writeExactExportPackage,
  type ExactExportFileFrame
} from "../../../../../src/domain/export-package/index.js";
import {
  createUserPayload,
  type UserPayload
} from "../../../../../src/domain/user-payload/index.js";
import type {
  RegistryTargetState
} from "../../../../../src/runtime/registry/index.js";
import {
  targetStateMarkerFactsFromRegistryState
} from "../../../../../src/runtime/target-state-recovery.js";
import {
  writeTargetStateMarkerFile
} from "../../../../../src/runtime/target-state-marker.js";

export async function dependenciesFixtureBytes(): Promise<Uint8Array> {
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

export async function fullFixtureBytes(): Promise<Uint8Array> {
  const base = parseExactExportPackage(
    await dependenciesFixtureBytes()
  );
  if (!base.ok) {
    throw new Error("base exact-export fixture did not parse");
  }

  const detachedPayload = createUserPayload([
    userEntry(
      "SKILL.md",
      "---\nname: demo\ndescription: recovery detached bytes\n---\n"
    ),
    userEntry("USER-NOTE", "recovery-detached-note\n")
  ]);
  const manualPayload = createUserPayload([
    userEntry(
      "SKILL.md",
      "---\nname: local\ndescription: recovery manual bytes\n---\n"
    )
  ]);
  if (!detachedPayload.ok || !manualPayload.ok) {
    throw new Error("user payload fixture failed");
  }

  const managed = base.value.manifest;
  const source = managed.sources[0]!;
  if (source.sourceKind !== "github-release") {
    throw new Error("expected release source fixture");
  }
  const packageFact = managed.packages[0]!;
  const written = writeExactExportPackage({
    manifest: {
      ...managed,
      mode: "full",
      detached: [
        {
          packageCoordinate: packageFact.packageCoordinate,
          activationName: "demo",
          payloadId: detachedPayload.value.payloadId,
          userContentDigest:
            detachedPayload.value.contentDigest,
          sourceKind: "github-release",
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
          userContentDigest:
            manualPayload.value.contentDigest
        }
      ]
    },
    frames: [
      ...base.value.frames,
      ...framesFor(detachedPayload.value),
      ...framesFor(manualPayload.value)
    ]
  });
  if (!written.ok) {
    throw new Error("full recovery fixture did not encode");
  }
  return written.value;
}

export async function writeMarker(
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
