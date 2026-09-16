import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("behavior harness reads repository fixtures without network access", async () => {
  const raw = await readFile(
    resolve("behavior-fixtures", "foundation", "harness.json"),
    "utf8"
  );
  const fixture = JSON.parse(raw) as {
    "fixture-version": number;
    kind: string;
    offline: boolean;
  };

  assert.deepEqual(fixture, {
    "fixture-version": 1,
    kind: "foundation-harness",
    offline: true
  });
});
