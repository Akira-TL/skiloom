import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  admitSkillPackage,
  type AdmittedSkillPackage,
  type PackageAdmissionErrorReason
} from "../../../src/domain/package/index.js";

type Fixture = Readonly<{
  valid: ReadonlyArray<Readonly<{
    rootBasename: string;
    skillMarkdown: string;
    expected: AdmittedSkillPackage;
  }>>;
  invalid: ReadonlyArray<Readonly<{
    rootBasename: string;
    skillMarkdown: string;
    reason: PackageAdmissionErrorReason;
  }>>;
}>;

test("SKILL.md Package admission behavior fixtures", async () => {
  const raw = await readFile(
    resolve("behavior-fixtures", "package-admission", "cases.json"),
    "utf8"
  );
  const fixture = JSON.parse(raw) as Fixture;

  for (const example of fixture.valid) {
    const result = admitSkillPackage(example);
    assert.equal(result.ok, true, example.rootBasename);
    if (result.ok) {
      assert.deepEqual(result.value, example.expected);
    }
  }

  for (const example of fixture.invalid) {
    const result = admitSkillPackage(example);
    assert.equal(result.ok, false, example.rootBasename);
    if (!result.ok) {
      assert.deepEqual(result.error, {
        code: "InvalidSkillPackage",
        facts: {
          rootBasename: example.rootBasename,
          reason: example.reason
        }
      });
    }
  }
});
