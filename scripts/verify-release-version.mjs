import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PLATFORM_PACKAGES = [
  "skiloom-lock-darwin-arm64",
  "skiloom-lock-darwin-x64",
  "skiloom-lock-linux-x64-gnu",
  "skiloom-lock-win32-x64"
];

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (
  tag === undefined ||
  !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)
) {
  throw new Error(
    "release tag must match vX.Y.Z with numeric stable components"
  );
}
const version = tag.slice(1);

const root = await readJson("package.json");
assert.equal(root.name, "skiloom");
assert.equal(
  root.version,
  version,
  `package.json version must match ${tag}`
);

for (const packageName of PLATFORM_PACKAGES) {
  const helper = await readJson(
    resolve("packages", packageName, "package.json")
  );
  assert.equal(helper.name, packageName);
  assert.equal(
    helper.version,
    version,
    `${packageName} version must match ${tag}`
  );
  assert.equal(
    root.optionalDependencies?.[packageName],
    version,
    `skiloom optional dependency on ${packageName} must be exact ${version}`
  );
}

const cargoToml = await readFile(
  resolve("native/skiloom-lock/Cargo.toml"),
  "utf8"
);
const cargoVersion = /^version\s*=\s*"([^"]+)"\s*$/mu.exec(
  cargoToml
)?.[1];
assert.equal(
  cargoVersion,
  version,
  `native/skiloom-lock/Cargo.toml version must match ${tag}`
);

const cargoLock = await readFile(
  resolve("native/skiloom-lock/Cargo.lock"),
  "utf8"
);
const lockPackage = /\[\[package\]\]\s*name\s*=\s*"skiloom-lock"\s*version\s*=\s*"([^"]+)"/mu.exec(
  cargoLock
)?.[1];
assert.equal(
  lockPackage,
  version,
  `native/skiloom-lock/Cargo.lock version must match ${tag}`
);

process.stdout.write(
  `release version metadata matches ${tag} across main, helper, and Rust packages\n`
);

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}
