import assert from "node:assert/strict";
import test from "node:test";

import {
  asciiLowercase,
  isValidSkillName,
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../../../src/domain/coordinate/index.js";

test("ASCII lowercase canonicalization does not apply Unicode case folding", () => {
  assert.equal(asciiLowercase("ÄKIRA/Repo"), "Äkira/repo");
});

test("repository and package coordinates remain distinct shapes", () => {
  assert.equal(parseRepositoryCoordinate("owner/repo/package").ok, false);
  assert.equal(parsePackageCoordinate("owner/repo").ok, false);
});

test("Skill names use the Agent Skills name grammar", () => {
  assert.equal(isValidSkillName("ask-matt"), true);
  assert.equal(isValidSkillName("a1-b2"), true);
  assert.equal(isValidSkillName("Ask-Matt"), false);
  assert.equal(isValidSkillName("ask--matt"), false);
  assert.equal(isValidSkillName("a".repeat(64)), true);
  assert.equal(isValidSkillName("a".repeat(65)), false);
});
