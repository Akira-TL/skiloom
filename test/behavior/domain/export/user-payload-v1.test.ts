import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  createUserPayload,
  verifyUserPayload,
  type UserPayloadContentEntry
} from "../../../../src/domain/user-payload/index.js";

type Fixture = Readonly<{
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

test("SKILOOM-USER-PAYLOAD-V1 matches the independent big-endian digest fixture", async () => {
  const fixture = await readFixture();
  const entries = fixture.entries.map(toEntry).reverse();
  const payload = createUserPayload(entries);

  assert.equal(payload.ok, true);
  if (!payload.ok) {
    return;
  }
  assert.equal(payload.value.contentDigest, fixture.digest);
  assert.equal(payload.value.payloadId, fixture.payloadId);
  assert.deepEqual(
    payload.value.entries.map((entry) => ({
      path: entry.path,
      executable: entry.executable,
      fileDigest: entry.fileDigest
    })),
    fixture.entries.map((entry) => ({
      path: entry.path,
      executable: entry.executable,
      fileDigest: entry.fileDigest
    }))
  );
});

test("empty user payload uses the canonical zero-entry digest", () => {
  const payload = createUserPayload([]);
  assert.deepEqual(payload, {
    ok: true,
    value: {
      entries: [],
      contentDigest:
        "sha256:722162f94859056505db46525d097b4ce367dd255339d5eb6e8a48cadfd73967",
      payloadId:
        "user:sha256:722162f94859056505db46525d097b4ce367dd255339d5eb6e8a48cadfd73967"
    }
  });
});

test("user payload domain is distinct from SKILOOM-PACKAGE-V1 and detects byte/executable drift", async () => {
  const fixture = await readFixture();
  const entries = fixture.entries.map(toEntry);

  const verified = verifyUserPayload(fixture.digest, entries);
  assert.equal(verified.ok, true);

  const byteDrift = entries.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          content: Uint8Array.from(
            Buffer.from("changed\n", "utf8")
          )
        }
      : entry
  );
  const byteResult = verifyUserPayload(
    fixture.digest,
    byteDrift
  );
  assert.equal(byteResult.ok, false);
  if (!byteResult.ok) {
    assert.equal(
      byteResult.error.code,
      "UserPayloadDigestMismatch"
    );
  }

  const modeDrift = entries.map((entry, index) =>
    index === 1
      ? { ...entry, executable: false }
      : entry
  );
  const modeResult = verifyUserPayload(
    fixture.digest,
    modeDrift
  );
  assert.equal(modeResult.ok, false);
  if (!modeResult.ok) {
    assert.equal(
      modeResult.error.code,
      "UserPayloadDigestMismatch"
    );
  }
});

test("user payload rejects path traversal and Unicode casefold collisions", () => {
  const traversal = createUserPayload([
    entry("../outside", false, "x")
  ]);
  assert.equal(traversal.ok, false);
  if (!traversal.ok) {
    assert.equal(traversal.error.code, "InvalidUserPayload");
    assert.equal(
      traversal.error.facts.reason,
      "invalid-path"
    );
  }

  const collision = createUserPayload([
    entry("Readme.md", false, "a"),
    entry("README.md", false, "b")
  ]);
  assert.equal(collision.ok, false);
  if (!collision.ok) {
    assert.equal(collision.error.code, "InvalidUserPayload");
    assert.equal(
      collision.error.facts.reason,
      "casefold-collision"
    );
  }
});

function toEntry(
  entry: Fixture["entries"][number]
): UserPayloadContentEntry {
  return {
    path: entry.path,
    executable: entry.executable,
    content: Uint8Array.from(
      Buffer.from(entry.contentBase64, "base64")
    )
  };
}

function entry(
  path: string,
  executable: boolean,
  content: string
): UserPayloadContentEntry {
  return {
    path,
    executable,
    content: Uint8Array.from(Buffer.from(content, "utf8"))
  };
}

async function readFixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      resolve(
        "behavior-fixtures",
        "export",
        "user-payload-v1.json"
      ),
      "utf8"
    )
  ) as Fixture;
}
