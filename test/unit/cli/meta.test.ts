import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readSkiloomPackageVersion
} from "../../../src/cli/meta/index.js";

test("installed version discovery follows nearest Skiloom package metadata instead of a hard-coded constant", async () => {
  const root = await mkdtemp(join(tmpdir(), "skiloom-meta-version-"));
  try {
    const nested = join(root, "dist", "cli", "meta");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "skiloom", version: "9.8.7-test" }),
      "utf8"
    );
    await writeFile(
      join(root, "dist", "package.json"),
      JSON.stringify({ name: "not-skiloom", version: "1.0.0" }),
      "utf8"
    );

    assert.equal(
      await readSkiloomPackageVersion(join(nested, "index.js")),
      "9.8.7-test"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
