import {
  lstat,
  readFile,
  readdir,
  readlink
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import {
  isValidSkillName
} from "../../domain/coordinate/index.js";
import {
  productError,
  type Result
} from "../../domain/errors/index.js";
import {
  verifyPackageStoreEntry
} from "../store.js";
import { buildManagedProjectionTree } from "./transform.js";
import type {
  InvalidManagedProjectionInput,
  ManagedProjectionMaterialization,
  ManagedProjectionMaterializationMismatch,
  ManagedProjectionUnexpectedEntry,
  ManagedProjectionUnsupportedEntry,
  ManagedProjectionVerificationError,
  ManagedProjectionTree,
  VerifiedManagedProjection,
  VerifyManagedProjectionInput
} from "./types.js";

type CollectedCopyEntry = Readonly<{
  path: string;
  content: Uint8Array;
  executable: boolean;
}>;

export async function verifyManagedProjection(
  input: VerifyManagedProjectionInput
): Promise<Result<VerifiedManagedProjection, ManagedProjectionVerificationError>> {
  const rootValidation = await validateTargetRoot(input.targetRoot);
  if (!rootValidation.ok) {
    return rootValidation;
  }
  if (!isValidSkillName(input.expected.projection.activationName)) {
    return invalidProjection(
      "invalid-activation-name",
      input.expected.projection.activationName
    );
  }

  const store = await verifyPackageStoreEntry(
    input.home,
    input.expected.projection.contentDigest
  );
  if (!store.ok) {
    return store;
  }
  const tree = buildManagedProjectionTree(
    store.value.snapshot,
    input.expected.projection
  );
  if (!tree.ok) {
    return tree;
  }

  const activationPath = join(
    input.targetRoot,
    input.expected.projection.activationName
  );
  const verified = await verifyProjectionAtPath({
    activationPath,
    activationName: input.expected.projection.activationName,
    expectedMaterialization: input.expected.materialization,
    expectedLinkTarget: store.value.payloadPath,
    tree: tree.value
  });
  if (!verified.ok) {
    return verified;
  }

  return {
    ok: true,
    value: {
      activationPath,
      materialization: input.expected.materialization,
      storePayloadPath: store.value.payloadPath,
      packageCoordinate: input.expected.projection.packageCoordinate,
      contentDigest: input.expected.projection.contentDigest
    }
  };
}

export async function verifyManagedProjectionAtPath(
  input: Readonly<{
    home: VerifyManagedProjectionInput["home"];
    activationPath: string;
    activationName: string;
    projection: VerifyManagedProjectionInput["expected"]["projection"];
    materialization: VerifyManagedProjectionInput["expected"]["materialization"];
  }>
): Promise<Result<true, ManagedProjectionVerificationError>> {
  const store = await verifyPackageStoreEntry(
    input.home,
    input.projection.contentDigest
  );
  if (!store.ok) {
    return store;
  }
  const tree = buildManagedProjectionTree(
    store.value.snapshot,
    input.projection
  );
  if (!tree.ok) {
    return tree;
  }
  return verifyProjectionAtPath({
    activationPath: input.activationPath,
    activationName: input.activationName,
    expectedMaterialization: input.materialization,
    expectedLinkTarget: store.value.payloadPath,
    tree: tree.value
  });
}

export async function verifyProjectionAtPath(input: Readonly<{
  activationPath: string;
  activationName: string;
  expectedMaterialization: ManagedProjectionMaterialization;
  expectedLinkTarget: string;
  tree: ManagedProjectionTree;
}>): Promise<Result<true, ManagedProjectionVerificationError>> {
  let stat;
  try {
    stat = await lstat(input.activationPath);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        ok: false,
        error: productError("ManagedProjectionMissing", {
          activationName: input.activationName,
          activationPath: input.activationPath
        })
      };
    }
    throw error;
  }

  if (input.expectedMaterialization === "copy") {
    if (stat.isSymbolicLink()) {
      return materializationMismatch(input.activationName, "copy", "link");
    }
    if (!stat.isDirectory()) {
      return materializationMismatch(input.activationName, "copy", "other");
    }
    return verifyCopyTree(input.activationPath, input.activationName, input.tree);
  }

  if (!stat.isSymbolicLink()) {
    return materializationMismatch(
      input.activationName,
      input.expectedMaterialization,
      stat.isDirectory() ? "directory" : "other"
    );
  }

  const rawTarget = await readlink(input.activationPath);
  const actualTarget = normalizeLinkTarget(
    input.activationPath,
    rawTarget
  );
  const expectedTarget = normalizeExpectedTarget(input.expectedLinkTarget);
  if (actualTarget !== expectedTarget) {
    return {
      ok: false,
      error: productError("ManagedProjectionWrongLink", {
        activationName: input.activationName,
        expectedTarget,
        actualTarget
      })
    };
  }

  return { ok: true, value: true };
}

export async function validateTargetRoot(
  targetRoot: string
): Promise<Result<string, InvalidManagedProjectionInput>> {
  if (!isAbsolute(targetRoot)) {
    return invalidProjection("target-root-not-absolute", targetRoot);
  }

  let stat;
  try {
    stat = await lstat(targetRoot);
  } catch (error) {
    if (isNotFound(error)) {
      return { ok: true, value: targetRoot };
    }
    throw error;
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return invalidProjection("target-root-not-directory", targetRoot);
  }
  return { ok: true, value: targetRoot };
}

async function verifyCopyTree(
  root: string,
  activationName: string,
  tree: ManagedProjectionTree
): Promise<Result<true, ManagedProjectionVerificationError>> {
  const collected = await collectCopyEntries(
    root,
    activationName,
    expectedDirectoryPaths(tree)
  );
  if (!collected.ok) {
    return collected;
  }

  const expectedByPath = new Map(
    tree.entries.map((entry) => [entry.path, entry])
  );
  const actualByPath = new Map(
    collected.value.map((entry) => [entry.path, entry])
  );

  for (const path of [...expectedByPath.keys()].sort(compareUtf8)) {
    if (!actualByPath.has(path)) {
      return {
        ok: false,
        error: productError("ManagedProjectionMissingEntry", {
          activationName,
          path
        })
      };
    }
  }
  for (const path of [...actualByPath.keys()].sort(compareUtf8)) {
    if (!expectedByPath.has(path)) {
      return {
        ok: false,
        error: productError("ManagedProjectionUnexpectedEntry", {
          activationName,
          path
        })
      };
    }
  }

  for (const path of [...expectedByPath.keys()].sort(compareUtf8)) {
    const expected = expectedByPath.get(path)!;
    const actual = actualByPath.get(path)!;
    if (!sameBytes(expected.content, actual.content)) {
      return {
        ok: false,
        error: productError("ManagedProjectionContentMismatch", {
          activationName,
          path
        })
      };
    }
    if (
      process.platform !== "win32" &&
      expected.executable !== actual.executable
    ) {
      return {
        ok: false,
        error: productError("ManagedProjectionExecutableMismatch", {
          activationName,
          path
        })
      };
    }
  }

  return { ok: true, value: true };
}

async function collectCopyEntries(
  root: string,
  activationName: string,
  expectedDirectories: ReadonlySet<string>
): Promise<
  Result<
    ReadonlyArray<CollectedCopyEntry>,
    ManagedProjectionUnsupportedEntry | ManagedProjectionUnexpectedEntry
  >
> {
  const files: CollectedCopyEntry[] = [];
  const directories = [root];

  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) {
      continue;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const stat = await lstat(absolutePath);
      const packagePath = toPackagePath(relative(root, absolutePath));

      if (stat.isSymbolicLink()) {
        return unsupportedEntry(activationName, packagePath, "symlink");
      }
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(packagePath)) {
          return unexpectedEntry(activationName, `${packagePath}/`);
        }
        directories.push(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        return unsupportedEntry(activationName, packagePath, "special");
      }
      files.push({
        path: packagePath,
        content: await readFile(absolutePath),
        executable: (stat.mode & 0o111) !== 0
      });
    }
  }

  files.sort((left, right) => compareUtf8(left.path, right.path));
  return { ok: true, value: files };
}

function expectedDirectoryPaths(tree: ManagedProjectionTree): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const entry of tree.entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

function unexpectedEntry(
  activationName: string,
  path: string
): Result<never, ManagedProjectionUnexpectedEntry> {
  return {
    ok: false,
    error: productError("ManagedProjectionUnexpectedEntry", {
      activationName,
      path
    })
  };
}

function materializationMismatch(
  activationName: string,
  expected: ManagedProjectionMaterialization,
  actual: ManagedProjectionMaterializationMismatch["facts"]["actual"]
): Result<never, ManagedProjectionMaterializationMismatch> {
  return {
    ok: false,
    error: productError("ManagedProjectionMaterializationMismatch", {
      activationName,
      expected,
      actual
    })
  };
}

function unsupportedEntry(
  activationName: string,
  path: string,
  entryType: ManagedProjectionUnsupportedEntry["facts"]["entryType"]
): Result<never, ManagedProjectionUnsupportedEntry> {
  return {
    ok: false,
    error: productError("ManagedProjectionUnsupportedEntry", {
      activationName,
      path,
      entryType
    })
  };
}

function invalidProjection(
  reason: InvalidManagedProjectionInput["facts"]["reason"],
  subject: string
): Result<never, InvalidManagedProjectionInput> {
  return {
    ok: false,
    error: productError("InvalidManagedProjectionInput", {
      reason,
      subject
    })
  };
}

function normalizeLinkTarget(linkPath: string, rawTarget: string): string {
  const stripped = stripWindowsExtendedPrefix(rawTarget);
  return normalizeExpectedTarget(
    isAbsolute(stripped)
      ? stripped
      : resolve(dirname(linkPath), stripped)
  );
}

function normalizeExpectedTarget(path: string): string {
  return resolve(stripWindowsExtendedPrefix(path));
}

function stripWindowsExtendedPrefix(path: string): string {
  if (process.platform !== "win32") {
    return path;
  }
  if (path.startsWith("\\\\?\\UNC\\")) {
    return "\\\\" + path.slice("\\\\?\\UNC\\".length);
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice("\\\\?\\".length);
  }
  return path;
}

function toPackagePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}
