import {
  lstat,
  readdir
} from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";
import {
  writeExactExportPackage,
  type ExactExportDetached,
  type ExactExportFileFrame,
  type ExactExportManifest,
  type ExactExportParseError,
  type ExactExportUserSkill
} from "../../domain/export-package/index.js";
import {
  admitSkillPackage
} from "../../domain/package/index.js";
import type {
  UserPayload
} from "../../domain/user-payload/index.js";
import type {
  OperationLockLost
} from "../../native/skiloom-lock.js";
import type {
  RegistryDetachedBaseline,
  RegistryProjection,
  RegistryTargetState
} from "../registry/index.js";
import {
  scanUserPayloadTree,
  type ScanUserPayloadError
} from "../user-payload.js";
import {
  writeExactExportFile,
  type ExactExportFileWriteError
} from "./file.js";
import {
  prepareManagedExactExport,
  type PrepareManagedExactExportError,
  type PrepareManagedExactExportInput
} from "./managed.js";

const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true
});

export type InvalidFullExportTargetState = ProductError<
  "InvalidFullExportTargetState",
  Readonly<{
    reason:
      | "detached-projection-missing"
      | "detached-projection-not-detached"
      | "detached-baseline-missing";
    packageCoordinate: string;
  }>
>;

export type FullExportTargetScanFailed = ProductError<
  "FullExportTargetScanFailed",
  Readonly<{ path: string }>
>;

export type ExportFullTargetError =
  | PrepareManagedExactExportError
  | OperationLockLost
  | InvalidFullExportTargetState
  | FullExportTargetScanFailed
  | ScanUserPayloadError
  | ExactExportParseError
  | ExactExportFileWriteError;

export type ExportFullTargetResult = Readonly<{
  destinationPath: string;
  manifest: ExactExportManifest;
  warnings: readonly [];
}>;

export async function exportFullTarget(
  input: PrepareManagedExactExportInput &
    Readonly<{ destinationPath: string }>
): Promise<
  Result<ExportFullTargetResult, ExportFullTargetError>
> {
  const prepared = await prepareManagedExactExport(input);
  if (!prepared.ok) {
    return prepared;
  }

  const user = await collectFullUserPayloads({
    targetRoot: prepared.value.targetRoot,
    state: prepared.value.state,
    lock: input.lock
  });
  if (!user.ok) {
    return user;
  }

  const manifest: ExactExportManifest = {
    ...prepared.value.manifest,
    mode: "full",
    detached: user.value.detached,
    userSkills: user.value.userSkills
  };
  const encoded = writeExactExportPackage({
    manifest,
    frames: [
      ...prepared.value.frames,
      ...user.value.frames
    ]
  });
  if (!encoded.ok) {
    return encoded;
  }

  const written = await writeExactExportFile({
    destinationPath: input.destinationPath,
    bytes: encoded.value,
    lock: input.lock
  });
  if (!written.ok) {
    return written;
  }

  return {
    ok: true,
    value: {
      destinationPath: written.value,
      manifest,
      warnings: []
    }
  };
}

type CollectedFullUserPayloads = Readonly<{
  detached: ReadonlyArray<ExactExportDetached>;
  userSkills: ReadonlyArray<ExactExportUserSkill>;
  frames: ReadonlyArray<ExactExportFileFrame>;
}>;

async function collectFullUserPayloads(
  input: Readonly<{
    targetRoot: string;
    state: RegistryTargetState;
    lock: PrepareManagedExactExportInput["lock"];
  }>
): Promise<
  Result<
    CollectedFullUserPayloads,
    | OperationLockLost
    | InvalidFullExportTargetState
    | FullExportTargetScanFailed
    | ScanUserPayloadError
  >
> {
  const frames: ExactExportFileFrame[] = [];
  const seenPayloads = new Set<string>();

  const detached = await collectDetachedPayloads(
    input,
    frames,
    seenPayloads
  );
  if (!detached.ok) {
    return detached;
  }

  const userSkills = await collectManualSkills(
    input,
    frames,
    seenPayloads
  );
  if (!userSkills.ok) {
    return userSkills;
  }

  return {
    ok: true,
    value: {
      detached: detached.value,
      userSkills: userSkills.value,
      frames
    }
  };
}

async function collectDetachedPayloads(
  input: Readonly<{
    targetRoot: string;
    state: RegistryTargetState;
    lock: PrepareManagedExactExportInput["lock"];
  }>,
  frames: ExactExportFileFrame[],
  seenPayloads: Set<string>
): Promise<
  Result<
    ReadonlyArray<ExactExportDetached>,
    | OperationLockLost
    | InvalidFullExportTargetState
    | ScanUserPayloadError
  >
> {
  const projectionByPackage = new Map(
    input.state.projections.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  const result: ExactExportDetached[] = [];
  const baselinePackages = new Set(
    input.state.detachedBaselines.map(
      (baseline) => baseline.packageCoordinate
    )
  );
  for (const projection of input.state.projections) {
    if (
      projection.ownership === "detached" &&
      !baselinePackages.has(projection.packageCoordinate)
    ) {
      return invalidDetached(
        "detached-baseline-missing",
        projection.packageCoordinate
      );
    }
  }

  for (const baseline of [...input.state.detachedBaselines].sort(
    (left, right) =>
      compareUtf8(
        left.packageCoordinate,
        right.packageCoordinate
      )
  )) {
    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }

    const projection = projectionByPackage.get(
      baseline.packageCoordinate
    );
    if (projection === undefined) {
      return invalidDetached(
        "detached-projection-missing",
        baseline.packageCoordinate
      );
    }
    if (projection.ownership !== "detached") {
      return invalidDetached(
        "detached-projection-not-detached",
        baseline.packageCoordinate
      );
    }

    const payload = await scanUserPayloadTree(
      join(input.targetRoot, projection.activationName)
    );
    if (!payload.ok) {
      return payload;
    }
    addUserFrames(payload.value, frames, seenPayloads);
    result.push(
      detachedRecord(
        baseline,
        projection,
        payload.value.payloadId,
        payload.value.contentDigest
      )
    );
  }

  return { ok: true, value: result };
}

async function collectManualSkills(
  input: Readonly<{
    targetRoot: string;
    state: RegistryTargetState;
    lock: PrepareManagedExactExportInput["lock"];
  }>,
  frames: ExactExportFileFrame[],
  seenPayloads: Set<string>
): Promise<
  Result<
    ReadonlyArray<ExactExportUserSkill>,
    | OperationLockLost
    | FullExportTargetScanFailed
    | ScanUserPayloadError
  >
> {
  let entries;
  try {
    entries = await readdir(input.targetRoot, {
      withFileTypes: true,
      encoding: "buffer"
    });
  } catch {
    return {
      ok: false,
      error: productError("FullExportTargetScanFailed", {
        path: input.targetRoot
      })
    };
  }
  entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.name),
      Buffer.from(right.name)
    )
  );

  const managedActivations = new Set(
    input.state.projections.map(
      (projection) => projection.activationName
    )
  );
  const result: ExactExportUserSkill[] = [];

  for (const entry of entries) {
    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }
    if (!entry.isDirectory()) {
      continue;
    }

    let activationName: string;
    try {
      activationName = UTF8_DECODER.decode(
        Buffer.from(entry.name)
      );
    } catch {
      continue;
    }
    if (managedActivations.has(activationName)) {
      continue;
    }

    const skillRoot = join(
      input.targetRoot,
      activationName
    );
    const skillPath = join(skillRoot, "SKILL.md");
    let skillStat;
    try {
      skillStat = await lstat(skillPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      return {
        ok: false,
        error: productError("FullExportTargetScanFailed", {
          path: skillPath
        })
      };
    }

    if (!skillStat.isFile()) {
      const payload = await scanUserPayloadTree(skillRoot);
      return payload.ok
        ? {
            ok: false,
            error: productError("FullExportTargetScanFailed", {
              path: skillPath
            })
          }
        : payload;
    }

    const payload = await scanUserPayloadTree(skillRoot);
    if (!payload.ok) {
      return payload;
    }
    const skillEntry = payload.value.entries.find(
      (candidate) => candidate.path === "SKILL.md"
    );
    if (skillEntry === undefined) {
      continue;
    }

    let skillMarkdown: string;
    try {
      skillMarkdown = UTF8_DECODER.decode(
        skillEntry.content
      );
    } catch {
      continue;
    }
    const admitted = admitSkillPackage({
      rootBasename: activationName,
      skillMarkdown
    });
    if (!admitted.ok) {
      continue;
    }

    addUserFrames(payload.value, frames, seenPayloads);
    result.push({
      activationName,
      skillName: admitted.value.name,
      payloadId: payload.value.payloadId,
      userContentDigest: payload.value.contentDigest
    });
  }

  return { ok: true, value: result };
}

function detachedRecord(
  baseline: RegistryDetachedBaseline,
  projection: RegistryProjection,
  payloadId: string,
  userContentDigest: string
): ExactExportDetached {
  return baseline.sourceKind === "github-release"
    ? {
        packageCoordinate: baseline.packageCoordinate,
        activationName: projection.activationName,
        payloadId,
        userContentDigest,
        sourceKind: "github-release",
        version: baseline.version,
        actualTag: baseline.actualTag,
        exactCommit: baseline.exactCommit,
        packageRoot: baseline.packageRoot,
        contentDigest: baseline.contentDigest
      }
    : {
        packageCoordinate: baseline.packageCoordinate,
        activationName: projection.activationName,
        payloadId,
        userContentDigest,
        sourceKind: "git",
        requestedRef: baseline.requestedRef,
        exactCommit: baseline.exactCommit,
        packageRoot: baseline.packageRoot,
        contentDigest: baseline.contentDigest
      };
}

function addUserFrames(
  payload: UserPayload,
  frames: ExactExportFileFrame[],
  seenPayloads: Set<string>
): void {
  if (seenPayloads.has(payload.payloadId)) {
    return;
  }
  seenPayloads.add(payload.payloadId);
  for (const entry of payload.entries) {
    frames.push({
      payloadId: payload.payloadId,
      path: entry.path,
      executable: entry.executable,
      content: Uint8Array.from(entry.content)
    });
  }
}

function invalidDetached(
  reason: InvalidFullExportTargetState["facts"]["reason"],
  packageCoordinate: string
): Result<never, InvalidFullExportTargetState> {
  return {
    ok: false,
    error: productError("InvalidFullExportTargetState", {
      reason,
      packageCoordinate
    })
  };
}

function compareUtf8(
  left: string,
  right: string
): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}

function isNodeError(
  error: unknown
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
