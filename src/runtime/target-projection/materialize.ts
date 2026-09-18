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

  const candidates = requestedCandidates(request, transformed);
  const activationPath = join(
    input.targetRoot,
    input.projection.activationName
  );
  const existsInitially = await pathExists(activationPath);

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
    if (!currentVerified.ok) {
      return currentVerified;
    }
  } else if (input.current !== undefined) {
    const currentVerified = await verifyManagedProjection({
      home: input.home,
      targetRoot: input.targetRoot,
      expected: input.current
    });
    if (!currentVerified.ok && currentVerified.error.code !== "ManagedProjectionMissing") {
      return currentVerified;
    }
  }

  let staged:
    | Readonly<{
        containerPath: string;
        path: string;
        materialization: ManagedProjectionMaterialization;
      }>
    | undefined;

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

      staged = {
        containerPath: stagingContainer,
        path: stagingPath,
        materialization: candidate
      };
      break;
    } catch (error) {
      await removeOwnedContainer(stagingContainer);
      throw error;
    }
  }

  if (staged === undefined) {
    return materializationUnsupported(
      candidates[0] ?? "copy",
      process.platform
    );
  }

  try {
    if (existsInitially) {
      if (input.current === undefined) {
        return targetOccupied(
          input.projection.activationName,
          activationPath
        );
      }

      const stillCurrent = await verifyManagedProjection({
        home: input.home,
        targetRoot: input.targetRoot,
        expected: input.current
      });
      if (!stillCurrent.ok) {
        return stillCurrent;
      }

      const retiredContainer = await mkdtemp(
        join(
          input.targetRoot,
          ".skiloom-retired-" + input.projection.activationName + "-"
        )
      );
      const retiredPath = join(retiredContainer, "projection");
      try {
        await rename(activationPath, retiredPath);
      } catch (error) {
        await removeOwnedContainer(retiredContainer);
        throw error;
      }

      try {
        await rename(staged.path, activationPath);
      } catch (error) {
        let restored = false;
        try {
          if (!(await pathExists(activationPath))) {
            await rename(retiredPath, activationPath);
            restored = true;
          }
        } finally {
          if (restored) {
            await removeOwnedContainer(retiredContainer);
          }
        }
        // If rollback itself fails, leave the owned retired container for #55 recovery.
        throw error;
      }
      await removeOwnedContainer(retiredContainer);

      return {
        ok: true,
        value: {
          status: "replaced",
          activationPath,
          materialization: staged.materialization,
          storePayloadPath: store.value.payloadPath,
          packageCoordinate: input.projection.packageCoordinate,
          contentDigest: input.projection.contentDigest
        }
      };
    }

    if (await pathExists(activationPath)) {
      return targetOccupied(
        input.projection.activationName,
        activationPath
      );
    }

    await rename(staged.path, activationPath);
    return {
      ok: true,
      value: {
        status: "created",
        activationPath,
        materialization: staged.materialization,
        storePayloadPath: store.value.payloadPath,
        packageCoordinate: input.projection.packageCoordinate,
        contentDigest: input.projection.contentDigest
      }
    };
  } finally {
    await removeOwnedContainer(staged.containerPath);
  }
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
