import assert from "node:assert/strict";
import test from "node:test";

import { admitSkillPackage } from "../../../src/domain/package/index.js";

test("Package name comes only from SKILL.md name", () => {
  const result = admitSkillPackage({
    rootBasename: "real-name",
    skillMarkdown: [
      "---",
      "name: real-name",
      "description: Valid Skill metadata.",
      "metadata:",
      "  name: fake-name",
      "---"
    ].join("\n")
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.name, "real-name");
  }
});

test("description length is measured by Unicode code points", () => {
  const result = admitSkillPackage({
    rootBasename: "unicode-description",
    skillMarkdown: [
      "---",
      "name: unicode-description",
      `description: '${"界".repeat(1024)}'`,
      "---"
    ].join("\n")
  });

  assert.equal(result.ok, true);
});

test("known optional Agent Skills fields are type-checked", () => {
  const result = admitSkillPackage({
    rootBasename: "optional-fields",
    skillMarkdown: [
      "---",
      "name: optional-fields",
      "description: Valid Skill with optional fields.",
      "license: MIT",
      "compatibility: Requires Node.js.",
      "metadata:",
      "  author: example",
      "allowed-tools: Read Write",
      "---"
    ].join("\n")
  });

  assert.equal(result.ok, true);
});
