import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  OperationLockLost,
  OperationLockSession
} from "../../../native/skiloom-lock.js";
import type {
  RegistryPendingProjectionAction
} from "../../registry/index.js";
import {
  materializeVerifiedUserPayloadTree,
  scanUserPayloadTree,
  type MaterializeUserPayloadError,
  type ScanUserPayloadError
} from "../../user-payload.js";
import type {
  PreparedImportUserPayload
} from "../prepare.js";

const FORMAT = "SKILOOM-IMPORT-USER-RECOVERY-V1";
const MANIFEST_FILE = "import-user.json";
const PAYLOAD_DIRECTORY = "payload";

export type ImportUserStagingFailed = ProductError<
  "ImportUserStagingFailed",
  Readonly<{
    activationName: string;
    reason: "io" | "invalid-manifest" | "fact-mismatch";
  }>
>;

export type ImportUserPayloadConflict = ProductError<
  "ImportUserPayloadConflict",
  Readonly<{
    activationName: string;
    reason:
      | "target-content-mismatch"
      | "staged-payload-missing"
      | "staged-payload-mismatch"
      | "activation-failed";
  }>
>;

export type PlannedImportUserStaging = Readonly<{
  payload: PreparedImportUserPayload;
  stagingPath: string;
}>;

export type ImportUserRecoveryManifest = Readonly<{
  format: typeof FORMAT;
  operationId: string;
  targetId: string;
  activationName: string;
  kind: "detached" | "user-skill";
  packageCoordinate: string | null;
  contentDigest: string;
}>;

export type StagedImportUserPayload = Readonly<{
  stagingPath: string;
  manifest: ImportUserRecoveryManifest;
}>;

export type ImportUserStagingError =
  | OperationLockLost
  | MaterializeUserPayloadError
  | ImportUserStagingFailed;

export type ImportUserActivationError =
  | OperationLockLost
  | ScanUserPayloadError
  | ImportUserPayloadConflict;

export function planImportUserStaging(
  targetRoot: string,
  payloads: ReadonlyArray<PreparedImportUserPayload>
): ReadonlyArray<PlannedImportUserStaging> {
  const root = resolve(targetRoot);
  return [...payloads]
    .sort((left, right) =>
      compareUtf8(left.activationName, right.activationName)
    )
    .map((payload) => ({
      payload,
      stagingPath: join(
        root,
        `.skiloom-stage-${payload.activationName}-${randomUUID()}`
      )
    }));
}

export function importUserPendingActions(
  planned: ReadonlyArray<PlannedImportUserStaging>
): ReadonlyArray<RegistryPendingProjectionAction> {
  return planned.map((entry) => ({
    stagingPath: entry.stagingPath,
    activationName: entry.payload.activationName
  }));
}

export async function stageImportUserPayloads(
  input: Readonly<{
    operationId: string;
    targetId: string;
    lock: OperationLockSession;
    planned: ReadonlyArray<PlannedImportUserStaging>;
  }>
): Promise<
  Result<
    ReadonlyArray<StagedImportUserPayload>,
    ImportUserStagingError
  >
> {
  const staged: StagedImportUserPayload[] = [];
  for (const entry of input.planned) {
    const held = input.lock.checkHeld();
    if (!held.ok) {
      return held;
    }

    try {
      await mkdir(entry.stagingPath, {
        recursive: false,
        mode: 0o700
      });
      const manifest = manifestFor(
        input.operationId,
        input.targetId,
        entry.payload
      );
      await writeManifest(
        entry.stagingPath,
        manifest
      );
      staged.push({
        stagingPath: entry.stagingPath,
        manifest
      });
    } catch {
      return stagingFailed(
        entry.payload.activationName,
        "io"
      );
    }

    const materialized =
      await materializeVerifiedUserPayloadTree({
        destinationRoot: join(
          entry.stagingPath,
          PAYLOAD_DIRECTORY
        ),
        expectedDigest: entry.payload.contentDigest,
        entries: entry.payload.entries,
        checkMutationCapability: () =>
          input.lock.checkHeld()
      });
    if (!materialized.ok) {
      return materialized;
    }
  }
  return { ok: true, value: staged };
}

export async function readImportUserRecoveryManifest(
  stagingPath: string,
  expected: Readonly<{
    operationId: string;
    targetId: string;
    activationName: string;
  }>
): Promise<
  Result<ImportUserRecoveryManifest | null, ImportUserStagingFailed>
> {
  const manifestPath = join(stagingPath, MANIFEST_FILE);
  let handle;
  try {
    const stagingStat = await lstat(stagingPath);
    if (
      !stagingStat.isDirectory() ||
      stagingStat.isSymbolicLink()
    ) {
      return stagingFailed(
        expected.activationName,
        "invalid-manifest"
      );
    }
    handle = await open(
      manifestPath,
      process.platform === "win32"
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    const raw = await handle.readFile("utf8");
    const value = JSON.parse(raw) as unknown;
    const parsed = parseManifest(value);
    if (parsed === undefined) {
      return stagingFailed(
        expected.activationName,
        "invalid-manifest"
      );
    }
    if (
      parsed.operationId !== expected.operationId ||
      parsed.targetId !== expected.targetId ||
      parsed.activationName !== expected.activationName
    ) {
      return stagingFailed(
        expected.activationName,
        "fact-mismatch"
      );
    }
    return { ok: true, value: parsed };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ok: true, value: null };
    }
    return stagingFailed(
      expected.activationName,
      "invalid-manifest"
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function activateStagedImportUserPayload(
  input: Readonly<{
    targetRoot: string;
    stagingPath: string;
    manifest: ImportUserRecoveryManifest;
    lock: OperationLockSession;
  }>
): Promise<Result<void, ImportUserActivationError>> {
  const targetPath = join(
    resolve(input.targetRoot),
    input.manifest.activationName
  );
  const targetExists = await pathExists(targetPath);
  if (targetExists) {
    const current = await scanUserPayloadTree(targetPath);
    if (!current.ok) {
      return current;
    }
    if (
      current.value.contentDigest !==
      input.manifest.contentDigest
    ) {
      return payloadConflict(
        input.manifest.activationName,
        "target-content-mismatch"
      );
    }
    return { ok: true, value: undefined };
  }

  const payloadPath = join(
    input.stagingPath,
    PAYLOAD_DIRECTORY
  );
  if (!(await pathExists(payloadPath))) {
    return payloadConflict(
      input.manifest.activationName,
      "staged-payload-missing"
    );
  }
  const staged = await scanUserPayloadTree(payloadPath);
  if (!staged.ok) {
    return staged;
  }
  if (
    staged.value.contentDigest !==
    input.manifest.contentDigest
  ) {
    return payloadConflict(
      input.manifest.activationName,
      "staged-payload-mismatch"
    );
  }

  const held = input.lock.checkHeld();
  if (!held.ok) {
    return held;
  }
  try {
    await rename(payloadPath, targetPath);
  } catch {
    return payloadConflict(
      input.manifest.activationName,
      "activation-failed"
    );
  }
  const after = input.lock.checkHeld();
  return after.ok
    ? { ok: true, value: undefined }
    : after;
}

function manifestFor(
  operationId: string,
  targetId: string,
  payload: PreparedImportUserPayload
): ImportUserRecoveryManifest {
  return {
    format: FORMAT,
    operationId,
    targetId,
    activationName: payload.activationName,
    kind: payload.kind,
    packageCoordinate: payload.packageCoordinate,
    contentDigest: payload.contentDigest
  };
}

async function writeManifest(
  stagingPath: string,
  manifest: ImportUserRecoveryManifest
): Promise<void> {
  const handle = await open(
    join(stagingPath, MANIFEST_FILE),
    "wx",
    0o600
  );
  try {
    await handle.writeFile(
      JSON.stringify(manifest) + "\n",
      "utf8"
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseManifest(
  value: unknown
): ImportUserRecoveryManifest | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "format",
      "operationId",
      "targetId",
      "activationName",
      "kind",
      "packageCoordinate",
      "contentDigest"
    ]) ||
    value.format !== FORMAT ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0 ||
    typeof value.targetId !== "string" ||
    value.targetId.length === 0 ||
    typeof value.activationName !== "string" ||
    value.activationName.length === 0 ||
    (value.kind !== "detached" &&
      value.kind !== "user-skill") ||
    !(
      value.packageCoordinate === null ||
      typeof value.packageCoordinate === "string"
    ) ||
    typeof value.contentDigest !== "string"
  ) {
    return undefined;
  }
  if (
    (value.kind === "detached" &&
      typeof value.packageCoordinate !== "string") ||
    (value.kind === "user-skill" &&
      value.packageCoordinate !== null)
  ) {
    return undefined;
  }
  return {
    format: FORMAT,
    operationId: value.operationId,
    targetId: value.targetId,
    activationName: value.activationName,
    kind: value.kind,
    packageCoordinate: value.packageCoordinate,
    contentDigest: value.contentDigest
  };
}

function stagingFailed(
  activationName: string,
  reason: ImportUserStagingFailed["facts"]["reason"]
): Result<never, ImportUserStagingFailed> {
  return {
    ok: false,
    error: productError("ImportUserStagingFailed", {
      activationName,
      reason
    })
  };
}

function payloadConflict(
  activationName: string,
  reason: ImportUserPayloadConflict["facts"]["reason"]
): Result<never, ImportUserPayloadConflict> {
  return {
    ok: false,
    error: productError("ImportUserPayloadConflict", {
      activationName,
      reason
    })
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(
  error: unknown
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlyArray<string>
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every(
      (key, index) => key === wanted[index]
    )
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
