import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseExactExportManifest,
  parseExactExportPackage,
  writeExactExportManifest,
  writeExactExportPackage,
  type ExactExportFileFrame,
  type ExactExportManifest,
  type ExactExportParseError
} from "../../../../src/domain/export-package/index.js";

type UserPayloadFixture = Readonly<{
  fixtureVersion: 1;
  digest: string;
  payloadId: string;
  entries: ReadonlyArray<Readonly<{
    path: string;
    executable: boolean;
    contentBase64: string;
    fileDigest: string;
  }>>;
}>;

type Fixture = Readonly<{
  fixtureVersion: 1;
  valid: Readonly<{
    manifest: string;
    managedContent: string;
    contentDigest: string;
    payloadId: string;
    containerBase64: string;
  }>;
  invalidManifests: ReadonlyArray<Readonly<{
    id: string;
    source: string;
    code: ExactExportParseError["code"];
    reason?: string;
    path?: string;
    format?: string;
  }>>;
}>;

test("SKILOOM-EXPORT-V1 known-good manifest and container bytes round-trip canonically", async () => {
  const fixture = await readFixture();
  const bytes = Buffer.from(
    fixture.valid.containerBase64,
    "base64"
  );
  const expected = expectedManifest(fixture);

  assert.deepEqual(
    parseExactExportManifest(fixture.valid.manifest),
    { ok: true, value: expected }
  );
  assert.equal(
    writeExactExportManifest(expected),
    fixture.valid.manifest
  );

  const parsed = parseExactExportPackage(bytes);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.deepEqual(parsed.value.manifest, expected);
  assert.deepEqual(parsed.value.frames, [
    {
      payloadId: fixture.valid.payloadId,
      path: "SKILL.md",
      executable: false,
      content: Uint8Array.from(
        Buffer.from(
          fixture.valid.managedContent,
          "utf8"
        )
      )
    }
  ]);

  const written = writeExactExportPackage({
    manifest: {
      ...expected,
      projections: [...expected.projections].reverse(),
      packages: [...expected.packages].reverse(),
      sources: [...expected.sources].reverse(),
      requirements: [...expected.requirements].reverse()
    },
    frames: [...parsed.value.frames].reverse()
  });
  assert.equal(written.ok, true);
  if (written.ok) {
    assert.deepEqual(Buffer.from(written.value), bytes);
  }
});

test("strict export manifest fixtures reject future, unknown, duplicate and cross-record-invalid facts", async () => {
  const fixture = await readFixture();
  for (const example of fixture.invalidManifests) {
    const result = parseExactExportManifest(example.source);
    assert.equal(result.ok, false, example.id);
    if (result.ok) {
      continue;
    }
    assert.equal(result.error.code, example.code, example.id);
    if (result.error.code === "InvalidExportPackage") {
      assert.equal(result.error.facts.reason, example.reason, example.id);
      assert.equal(result.error.facts.path, example.path, example.id);
    } else {
      assert.equal(result.error.facts.format, example.format, example.id);
    }
  }
});

test("full manifest accepts detached and user-skill records but dependencies mode forbids them", async () => {
  const fixture = await readFixture();
  const digest = "sha256:" + "0".repeat(64);
  const fullSource =
    fixture.valid.manifest.replace(
      'mode = "dependencies"',
      'mode = "full"'
    ) +
    `\n[[detached]]\n` +
    `package = "acme/demo/demo"\n` +
    `activation-name = "demo"\n` +
    `payload = "user:${digest}"\n` +
    `content-digest = "${digest}"\n` +
    `baseline-source = "github-release"\n` +
    `baseline-version = "1.0.0"\n` +
    `baseline-tag = "v1.0.0"\n` +
    `baseline-commit = "0123456789abcdef0123456789abcdef01234567"\n` +
    `baseline-package-root = "."\n` +
    `baseline-content-digest = "${fixture.valid.contentDigest}"\n` +
    `\n[[user-skills]]\n` +
    `activation-name = "local"\n` +
    `skill-name = "local"\n` +
    `payload = "user:${digest}"\n` +
    `content-digest = "${digest}"\n`;

  const parsed = parseExactExportManifest(fullSource);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.mode, "full");
    assert.equal(parsed.value.detached.length, 1);
    assert.equal(parsed.value.userSkills.length, 1);
    assert.deepEqual(
      parseExactExportManifest(writeExactExportManifest(parsed.value)),
      parsed
    );
  }
});

test("full export container verifies SKILOOM-USER-PAYLOAD-V1 frames before writing", async () => {
  const fixture = await readFixture();
  const userFixture = await readUserPayloadFixture();
  const parsed = parseExactExportPackage(
    Buffer.from(fixture.valid.containerBase64, "base64")
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  const userFrames: ExactExportFileFrame[] =
    userFixture.entries.map((entry) => ({
      payloadId: userFixture.payloadId,
      path: entry.path,
      executable: entry.executable,
      content: Uint8Array.from(
        Buffer.from(entry.contentBase64, "base64")
      )
    }));
  const full: ExactExportManifest = {
    ...parsed.value.manifest,
    mode: "full",
    userSkills: [
      {
        activationName: "local",
        skillName: "local",
        payloadId: userFixture.payloadId,
        userContentDigest: userFixture.digest
      }
    ]
  };

  const written = writeExactExportPackage({
    manifest: full,
    frames: [...parsed.value.frames, ...userFrames].reverse()
  });
  assert.equal(written.ok, true);
  if (written.ok) {
    const reparsed = parseExactExportPackage(written.value);
    assert.equal(reparsed.ok, true);
    if (reparsed.ok) {
      assert.equal(reparsed.value.manifest.mode, "full");
      assert.equal(reparsed.value.manifest.userSkills.length, 1);
    }
  }

  const corruptUserFrames = userFrames.map((frame, index) =>
    index === 0
      ? {
          ...frame,
          content: Uint8Array.from(
            Buffer.from("corrupt\n", "utf8")
          )
        }
      : frame
  );
  const corrupted = writeExactExportPackage({
    manifest: full,
    frames: [...parsed.value.frames, ...corruptUserFrames]
  });
  assert.equal(corrupted.ok, false);
  if (!corrupted.ok) {
    assert.equal(
      corrupted.error.code,
      "InvalidExportPackage"
    );
    if (corrupted.error.code === "InvalidExportPackage") {
      assert.equal(
        corrupted.error.facts.reason,
        "user-content-digest-mismatch"
      );
      assert.equal(
        corrupted.error.facts.path,
        userFixture.payloadId
      );
    }
  }
});

test("container accepts a declared empty user payload only when its digest is the canonical empty-tree digest", async () => {
  const fixture = await readFixture();
  const parsed = parseExactExportPackage(
    Buffer.from(fixture.valid.containerBase64, "base64")
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  const emptyDigest =
    "sha256:722162f94859056505db46525d097b4ce367dd255339d5eb6e8a48cadfd73967";
  const full: ExactExportManifest = {
    ...parsed.value.manifest,
    mode: "full",
    userSkills: [
      {
        activationName: "empty-local",
        skillName: "empty-local",
        payloadId: `user:${emptyDigest}`,
        userContentDigest: emptyDigest
      }
    ]
  };

  const written = writeExactExportPackage({
    manifest: full,
    frames: parsed.value.frames
  });
  assert.equal(written.ok, true);
  if (written.ok) {
    const reparsed = parseExactExportPackage(written.value);
    assert.equal(reparsed.ok, true);
    if (reparsed.ok) {
      assert.equal(
        reparsed.value.frames.some(
          (frame) => frame.payloadId === `user:${emptyDigest}`
        ),
        false
      );
    }
  }

  const wrongDigest = "sha256:" + "0".repeat(64);
  const missing = writeExactExportPackage({
    manifest: {
      ...full,
      userSkills: [
        {
          activationName: "empty-local",
          skillName: "empty-local",
          payloadId: `user:${wrongDigest}`,
          userContentDigest: wrongDigest
        }
      ]
    },
    frames: parsed.value.frames
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.code, "InvalidExportPackage");
    if (missing.error.code === "InvalidExportPackage") {
      assert.equal(
        missing.error.facts.reason,
        "missing-payload"
      );
    }
  }
});

test("container framing rejects future magic truncation illegal frames extra payloads duplicates and managed corruption", async () => {
  const fixture = await readFixture();
  const valid = Buffer.from(fixture.valid.containerBase64, "base64");
  const magicLength = Buffer.from("SKILOOM-EXPORT-V1\0", "ascii").length;
  const manifestLength = Number(
    valid.readBigUInt64LE(magicLength)
  );
  const frameOffset = magicLength + 8 + manifestLength;
  const validFrame = valid.subarray(frameOffset);

  const future = Buffer.from(valid);
  Buffer.from("SKILOOM-EXPORT-V2\0", "ascii").copy(future, 0);
  assertError(parseExactExportPackage(future), "UnsupportedExportVersion");

  assertInvalid(
    parseExactExportPackage(valid.subarray(0, magicLength + 7)),
    "truncated",
    "manifest-length"
  );

  const duplicated = Buffer.concat([valid, validFrame]);
  assertInvalid(
    parseExactExportPackage(duplicated),
    "duplicate-frame",
    fixture.valid.payloadId + ":SKILL.md"
  );

  const corrupted = Buffer.from(valid);
  const last = corrupted.length - 1;
  corrupted[last] = (corrupted[last] ?? 0) ^ 0xff;
  assertInvalid(
    parseExactExportPackage(corrupted),
    "managed-content-digest-mismatch",
    fixture.valid.payloadId
  );

  const extraFrame = encodeFrame({
    payloadId: "package:sha256:" + "0".repeat(64),
    path: "SKILL.md",
    executable: false,
    content: Buffer.from(fixture.valid.managedContent)
  });
  assertInvalid(
    parseExactExportPackage(
      Buffer.concat([valid.subarray(0, frameOffset), extraFrame])
    ),
    "undeclared-payload",
    "package:sha256:" + "0".repeat(64)
  );

  const invalidPath = encodeFrame({
    payloadId: fixture.valid.payloadId,
    path: "../SKILL.md",
    executable: false,
    content: Buffer.from(fixture.valid.managedContent)
  });
  assertInvalid(
    parseExactExportPackage(
      Buffer.concat([valid.subarray(0, frameOffset), invalidPath])
    ),
    "invalid-payload-path",
    fixture.valid.payloadId + ":../SKILL.md"
  );

  const invalidExecutable = Buffer.from(valid);
  const payloadLength = Number(invalidExecutable.readBigUInt64LE(frameOffset));
  const pathLengthOffset = frameOffset + 8 + payloadLength;
  const pathLength = Number(
    invalidExecutable.readBigUInt64LE(pathLengthOffset)
  );
  const executableOffset = pathLengthOffset + 8 + pathLength;
  invalidExecutable[executableOffset] = 2;
  assertInvalid(
    parseExactExportPackage(invalidExecutable),
    "invalid-executable",
    fixture.valid.payloadId + ":SKILL.md"
  );
});

function expectedManifest(fixture: Fixture): ExactExportManifest {
  return {
    format: "SKILOOM-EXPORT-V1",
    mode: "dependencies",
    requirements: [
      {
        kind: "package",
        coordinate: "acme/demo/demo",
        sourceKind: "github-release",
        versionRequirement: "^1.0.0"
      }
    ],
    sources: [
      {
        repositoryCoordinate: "acme/demo",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit: "0123456789abcdef0123456789abcdef01234567",
        immutable: true
      }
    ],
    packages: [
      {
        packageCoordinate: "acme/demo/demo",
        packageRoot: ".",
        contentDigest: fixture.valid.contentDigest,
        payloadId: fixture.valid.payloadId
      }
    ],
    dependencies: [],
    projections: [
      {
        packageCoordinate: "acme/demo/demo",
        activationName: "demo"
      }
    ],
    detached: [],
    userSkills: []
  };
}

function encodeFrame(frame: ExactExportFileFrame): Buffer {
  const payload = Buffer.from(frame.payloadId, "utf8");
  const path = Buffer.from(frame.path, "utf8");
  const content = Buffer.from(frame.content);
  return Buffer.concat([
    uint64le(payload.length),
    payload,
    uint64le(path.length),
    path,
    Buffer.from([frame.executable ? 1 : 0]),
    uint64le(content.length),
    content
  ]);
}

function uint64le(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function assertError(
  result: ReturnType<typeof parseExactExportPackage>,
  code: ExactExportParseError["code"]
): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, code);
  }
}

function assertInvalid(
  result: ReturnType<typeof parseExactExportPackage>,
  reason: string,
  path: string
): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "InvalidExportPackage");
    if (result.error.code === "InvalidExportPackage") {
      assert.equal(result.error.facts.reason, reason);
      assert.equal(result.error.facts.path, path);
    }
  }
}

async function readUserPayloadFixture(): Promise<UserPayloadFixture> {
  return JSON.parse(
    await readFile(
      resolve(
        "behavior-fixtures",
        "export",
        "user-payload-v1.json"
      ),
      "utf8"
    )
  ) as UserPayloadFixture;
}

async function readFixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      resolve("behavior-fixtures", "export", "package-v1.json"),
      "utf8"
    )
  ) as Fixture;
}
