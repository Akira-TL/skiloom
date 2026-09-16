import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildPackageSnapshot,
  type PackageSnapshot,
  type RepositorySnapshotEntry
} from "../../../src/domain/snapshot/index.js";

type FixtureEntry = Readonly<{
  path?: string;
  pathHex?: string;
  fileType: RepositorySnapshotEntry["fileType"];
  gitMode?: "100644" | "100755";
  contentHex?: string;
}>;

type ExpectedSnapshot = Readonly<{
  entries: ReadonlyArray<Readonly<{
    path: string;
    executable: boolean;
    contentHex: string;
    fileDigest: string;
  }>>;
  contentDigest: string;
}>;

type StructuredError = Readonly<{
  code: string;
  facts: Readonly<Record<string, unknown>>;
}>;

type SnapshotCase = Readonly<{
  name: string;
  packageRoot: string;
  discoveredPackageRoots: ReadonlyArray<string>;
  entries: ReadonlyArray<FixtureEntry>;
}>;

type Fixture = Readonly<{
  valid: ReadonlyArray<SnapshotCase & Readonly<{ expected: ExpectedSnapshot }>>;
  invalid: ReadonlyArray<SnapshotCase & Readonly<{ error: StructuredError }>>;
}>;

function bytesFromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function entryFromFixture(entry: FixtureEntry): RepositorySnapshotEntry {
  const pathBytes = entry.pathHex === undefined
    ? new TextEncoder().encode(entry.path ?? "")
    : bytesFromHex(entry.pathHex);

  if (entry.fileType !== "regular") {
    return {
      pathBytes,
      fileType: entry.fileType
    };
  }

  assert.ok(entry.gitMode !== undefined);
  assert.ok(entry.contentHex !== undefined);
  return {
    pathBytes,
    fileType: "regular",
    gitMode: entry.gitMode,
    content: bytesFromHex(entry.contentHex)
  };
}

function snapshotView(snapshot: PackageSnapshot): ExpectedSnapshot {
  return {
    entries: snapshot.entries.map((entry) => ({
      path: entry.path,
      executable: entry.executable,
      contentHex: Buffer.from(entry.content).toString("hex"),
      fileDigest: entry.fileDigest
    })),
    contentDigest: snapshot.contentDigest
  };
}

test("Package Snapshot and SKILOOM-PACKAGE-V1 behavior fixtures", async () => {
  const raw = await readFile(
    resolve("behavior-fixtures", "snapshot", "cases.json"),
    "utf8"
  );
  const fixture = JSON.parse(raw) as Fixture;

  for (const example of fixture.valid) {
    const input = {
      packageRoot: example.packageRoot,
      discoveredPackageRoots: example.discoveredPackageRoots,
      entries: example.entries.map(entryFromFixture)
    };
    const result = buildPackageSnapshot(input);
    assert.equal(result.ok, true, example.name);
    if (result.ok) {
      assert.deepEqual(snapshotView(result.value), example.expected, example.name);
    }

    const reversed = buildPackageSnapshot({
      ...input,
      entries: [...input.entries].reverse()
    });
    assert.deepEqual(reversed, result, `${example.name}: input order`);
  }

  for (const example of fixture.invalid) {
    const result = buildPackageSnapshot({
      packageRoot: example.packageRoot,
      discoveredPackageRoots: example.discoveredPackageRoots,
      entries: example.entries.map(entryFromFixture)
    });
    assert.equal(result.ok, false, example.name);
    if (!result.ok) {
      assert.deepEqual(result.error, example.error, example.name);
    }
  }
});
