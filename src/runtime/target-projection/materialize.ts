import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join
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
import {
  validateTargetRoot,
  verifyManagedProjection,
  verifyProjectionAtPath
} from "./verify.js";
import type {
  InvalidManagedProjectionInput,
  ManagedProjectionMaterialization,
  ManagedProjectionMaterializationRequest,
  ManagedProjectionMaterializationUnsupported,
  ManagedProjectionRuntimeError,
  ManagedProjectionTree,
  MaterializedManagedProjection,
  MaterializeManagedProjectionInput,
  PreparedManagedProjection,
  TargetPathOccupied
} from "./types.js";

export function managedProjectionMaterializationCandidates(
  platform: NodeJS.Platform,
  transformed: boolean
): ReadonlyArray<ManagedProjectionMaterialization> {
  if (transformed) {
    return ["copy"];
  }
  return platform === "win32"
    ? ["junction", "copy"]
    : ["symlink", "copy"];
}

export async function materializeManagedProjection(
  input: MaterializeManagedProjectionInput
): Promise<Result<MaterializedManagedProjection, ManagedProjectionRuntimeError>> {
  const prepared = await prepareManagedProjection(input);
  if (!prepared.ok) {
    return prepared;
  }

  try {
    return await prepared.value.activate();
  } finally {
    await prepared.value.discard();
  }
}

export async function prepareManagedProjection(
  input: MaterializeManagedProjectionInput
): Promise<Result<PreparedManagedProjection, ManagedProjectionRuntimeError>> {
  if (!isAbsolute(input.targetRoot)) {
    return invalidProjection("target-root-not-absolute", input.targetRoot);
  }
  if (!isValidSkillName(input.projection.activationName)) {
    return invalidProjection(
      "invalid-activation-name",
      input.projection.activationName
    );
  }

  const existingRoot = await validateTargetRoot(input.targetRoot);
  if (!existingRoot.ok) {
    return existingRoot;
  }
  await mkdir(input.targetRoot, { recursive: true });
  const rootValidation = await validateTargetRoot(input.targetRoot);
  if (!rootValidation.ok) {
    return rootValidation;
  }

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

  const request = input.materialization ?? "auto";
  const transformed = input.projection.projectionKind === "transformed-copy";
  if (
    transformed &&
    request !== "auto" &&
    request !== "copy"
  ) {
    return invalidProjection(
      "transformed-copy-requires-copy",
      request
    );
  }

  const activationPath = join(
    input.targetRoot,
    input.projection.activationName
  );
  const existsInitially = await pathExists(activationPath);
  const currentCheck = await verifyCurrentBeforeStaging(
    input,
    activationPath,
    existsInitially
  );
  if (!currentCheck.ok) {
    return currentCheck;
  }

  const candidates = requestedCandidates(request, transformed);
  for (const candidate of candidates) {
    const stagingContainer = await mkdtemp(
      join(
        input.targetRoot,
        ".skiloom-stage-" + input.projection.activationName + "-"
      )
    );
    const stagingPath = join(stagingContainer, "projection");

    try {
      const built = await buildStagingProjection({
        stagingPath,
        materialization: candidate,
        storePayloadPath: store.value.payloadPath,
        tree: tree.value
      });
      if (!built.ok) {
        await removeOwnedContainer(stagingContainer);
        if (
          request === "auto" &&
          candidate !== "copy" &&
          built.error.code === "ManagedProjectionMaterializationUnsupported"
        ) {
          continue;
        }
        return built;
      }

      const verified = await verifyProjectionAtPath({
        activationPath: stagingPath,
        activationName: input.projection.activationName,
        expectedMaterialization: candidate,
        expectedLinkTarget: store.value.payloadPath,
        tree: tree.value
      });
      if (!verified.ok) {
        await removeOwnedContainer(stagingContainer);
        return verified;
      }

      return {
        ok: true,
        value: preparedProjectionHandle({
          input,
          activationPath,
          existsInitially,
          cleanupPath: stagingContainer,
          stagingPath,
          materialization: candidate,
          storePayloadPath: store.value.payloadPath
        })
      };
    } catch (error) {
      await removeOwnedContainer(stagingContainer);
      throw error;
    }
  }

  return materializationUnsupported(
    candidates[0] ?? "copy",
    process.platform
  );
}

function preparedProjectionHandle(input: Readonly<{
  input: MaterializeManagedProjectionInput;
  activationPath: string;
  existsInitially: boolean;
  cleanupPath: string;
  stagingPath: string;
  materialization: ManagedProjectionMaterialization;
  storePayloadPath: string;
}>): PreparedManagedProjection {
  let lifecycle: "prepared" | "activated" | "discarded" = "prepared";
  let cleanupSafe = true;

  return {
    activationName: input.input.projection.activationName,
    activationPath: input.activationPath,
    stagingPath: input.stagingPath,
    cleanupPath: input.cleanupPath,
    materialization: input.materialization,
    storePayloadPath: input.storePayloadPath,
    packageCoordinate: input.input.projection.packageCoordinate,
    contentDigest: input.input.projection.contentDigest,
    async activate() {
      if (lifecycle !== "prepared") {
        throw new Error(`prepared projection is already ${lifecycle}`);
      }

      if (input.existsInitially) {
        if (input.input.current === undefined) {
          return targetOccupied(
            input.input.projection.activationName,
            input.activationPath
          );
        }

        const stillCurrent = await verifyManagedProjection({
          home: input.input.home,
          targetRoot: input.input.targetRoot,
          expected: input.input.current
        });
        if (!stillCurrent.ok) {
          return stillCurrent;
        }

        const retiredPath = join(input.cleanupPath, "retired");
        await rename(input.activationPath, retiredPath);
        try {
          await rename(input.stagingPath, input.activationPath);
        } catch (error) {
          try {
            if (!(await pathExists(input.activationPath))) {
              await rename(retiredPath, input.activationPath);
            } else {
              cleanupSafe = false;
            }
          } catch {
            cleanupSafe = false;
          }
          throw error;
        }

        lifecycle = "activated";
        return materializedProjectionResult(
          "replaced",
          input.activationPath,
          input.materialization,
          input.storePayloadPath,
          input.input
        );
      }

      if (await pathExists(input.activationPath)) {
        return targetOccupied(
          input.input.projection.activationName,
          input.activationPath
        );
      }

      await rename(input.stagingPath, input.activationPath);
      lifecycle = "activated";
      return materializedProjectionResult(
        "created",
        input.activationPath,
        input.materialization,
        input.storePayloadPath,
        input.input
      );
    },
    async discard() {
      if (lifecycle === "discarded" || !cleanupSafe) {
        return;
      }
      await removeOwnedContainer(input.cleanupPath);
      lifecycle = "discarded";
    }
  };
}

async function verifyCurrentBeforeStaging(
  input: MaterializeManagedProjectionInput,
  activationPath: string,
  existsInitially: boolean
): Promise<Result<true, ManagedProjectionRuntimeError>> {
  if (existsInitially) {
    if (input.current === undefined) {
      return targetOccupied(input.projection.activationName, activationPath);
    }
    if (
      input.current.projection.activationName !==
      input.projection.activationName
    ) {
      return invalidProjection(
        "current-activation-mismatch",
        input.current.projection.activationName
      );
    }
    const currentVerified = await verifyManagedProjection({
      home: input.home,
      targetRoot: input.targetRoot,
      expected: input.current
    });
    return currentVerified.ok
      ? { ok: true, value: true }
      : currentVerified;
  }

  if (input.current !== undefined) {
    const currentVerified = await verifyManagedProjection({
      home: input.home,
      targetRoot: input.targetRoot,
      expected: input.current
    });
    if (!currentVerified.ok && currentVerified.error.code !== "ManagedProjectionMissing") {
      return currentVerified;
    }
  }
  return { ok: true, value: true };
}

function materializedProjectionResult(
  status: MaterializedManagedProjection["status"],
  activationPath: string,
  materialization: ManagedProjectionMaterialization,
  storePayloadPath: string,
  input: MaterializeManagedProjectionInput
): Result<MaterializedManagedProjection, never> {
  return {
    ok: true,
    value: {
      status,
      activationPath,
      materialization,
      storePayloadPath,
      packageCoordinate: input.projection.packageCoordinate,
      contentDigest: input.projection.contentDigest
    }
  };
}

function requestedCandidates(
  request: ManagedProjectionMaterializationRequest,
  transformed: boolean
): ReadonlyArray<ManagedProjectionMaterialization> {
  if (transformed) {
    return ["copy"];
  }
  if (request === "auto") {
    return managedProjectionMaterializationCandidates(
      process.platform,
      false
    );
  }
  return [request];
}

async function buildStagingProjection(input: Readonly<{
  stagingPath: string;
  materialization: ManagedProjectionMaterialization;
  storePayloadPath: string;
  tree: ManagedProjectionTree;
}>): Promise<
  Result<true, ManagedProjectionMaterializationUnsupported>
> {
  if (
    (input.materialization === "junction" && process.platform !== "win32") ||
    (input.materialization === "symlink" && process.platform === "win32")
  ) {
    return materializationUnsupported(
      input.materialization,
      process.platform
    );
  }

  if (input.materialization === "copy") {
    await writeCopyTree(input.stagingPath, input.tree);
    return { ok: true, value: true };
  }

  try {
    await symlink(
      input.storePayloadPath,
      input.stagingPath,
      input.materialization === "junction" ? "junction" : "dir"
    );
    return { ok: true, value: true };
  } catch (error) {
    if (isUnsupportedLinkError(error)) {
      return materializationUnsupported(
        input.materialization,
        process.platform
      );
    }
    throw error;
  }
}

async function writeCopyTree(
  root: string,
  tree: ManagedProjectionTree
): Promise<void> {
  await mkdir(root, { recursive: false });

  for (const entry of tree.entries) {
    const targetPath = join(root, ...entry.path.split("/"));
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, entry.content, { flag: "wx" });
    if (process.platform !== "win32") {
      await chmod(targetPath, entry.executable ? 0o755 : 0o644);
    }
  }
}

async function removeOwnedContainer(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
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

function materializationUnsupported(
  requested: ManagedProjectionMaterialization,
  platform: NodeJS.Platform
): Result<never, ManagedProjectionMaterializationUnsupported> {
  return {
    ok: false,
    error: productError("ManagedProjectionMaterializationUnsupported", {
      requested,
      platform
    })
  };
}

function targetOccupied(
  activationName: string,
  activationPath: string
): Result<never, TargetPathOccupied> {
  return {
    ok: false,
    error: productError("TargetPathOccupied", {
      activationName,
      activationPath
    })
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isUnsupportedLinkError(error: unknown): boolean {
  if (!isNodeError(error)) {
    return false;
  }
  return new Set([
    "EACCES",
    "EINVAL",
    "ENOSYS",
    "ENOTSUP",
    "EOPNOTSUPP",
    "EPERM"
  ]).has(error.code ?? "");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}
