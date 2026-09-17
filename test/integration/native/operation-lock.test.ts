import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  acquireOperationLock,
  type OperationLockSession
} from "../../../src/native/skiloom-lock.js";

const helperExecutable = requiredHelperExecutable();

test("real bridge acquires, contends, releases, and ignores residual lock-file bytes", async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = join(directory, "operation.lock");
    const residual = "pid=999999\nstarted-at=not-authority\n";
    await writeFile(lockPath, residual, "utf8");

    const first = await acquireOperationLock({ helperExecutable, lockPath });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.equal(first.value.held, true);

    const second = await acquireOperationLock({ helperExecutable, lockPath });
    assert.deepEqual(second, {
      ok: false,
      error: {
        code: "OperationLocked",
        facts: { lockPath }
      }
    });

    const released = await first.value.release();
    assert.deepEqual(released, { ok: true, value: undefined });
    assert.equal(first.value.held, false);

    const third = await acquireOperationLock({ helperExecutable, lockPath });
    assert.equal(third.ok, true);
    if (!third.ok) {
      return;
    }
    assert.deepEqual(await third.value.release(), { ok: true, value: undefined });
    assert.equal(await readFile(lockPath, "utf8"), residual);
  });
});

test("missing helper is unsupported capability and never falls back to a user-space lock", async () => {
  await withTempDirectory(async (directory) => {
    const lockPath = join(directory, "operation.lock");
    const missingHelper = join(directory, "missing-skiloom-lock");

    const result = await acquireOperationLock({
      helperExecutable: missingHelper,
      lockPath
    });
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "UnsupportedPlatformCapability",
        facts: {
          capability: "operation-lock",
          reason: "helper-missing"
        }
      }
    });

    await assert.rejects(access(lockPath));
  });
});

test("helper death after acquisition produces OperationLockLost and the session never reacquires", async () => {
  if (process.platform === "win32") {
    throw new Error("lock-loss integration currently requires POSIX SIGKILL");
  }

  await withTempDirectory(async (directory) => {
    const lockPath = join(directory, "operation.lock");
    const acquired = await acquireOperationLock({ helperExecutable, lockPath });
    assert.equal(acquired.ok, true);
    if (!acquired.ok) {
      return;
    }

    const session = acquired.value;
    const pid = requireHelperPid(session);
    process.kill(pid, "SIGKILL");

    const lost = await withTimeout(session.waitForLoss(), 5_000, "operation lock loss");
    assert.equal(lost.code, "OperationLockLost");
    assert.equal(lost.facts.lockPath, lockPath);
    assert.equal(session.held, false);

    const releaseAfterLoss = await session.release();
    assert.equal(releaseAfterLoss.ok, false);
    if (!releaseAfterLoss.ok) {
      assert.deepEqual(releaseAfterLoss.error, lost);
    }

    const replacement = await acquireOperationLock({ helperExecutable, lockPath });
    assert.equal(replacement.ok, true);
    if (replacement.ok) {
      assert.deepEqual(await replacement.value.release(), { ok: true, value: undefined });
    }
  });
});

function requiredHelperExecutable(): string {
  const configured = process.env.SKILOOM_LOCK_TEST_BINARY;
  if (configured === undefined || configured.length === 0) {
    throw new Error("SKILOOM_LOCK_TEST_BINARY must point to a real skiloom-lock executable");
  }
  return resolve(configured);
}

function requireHelperPid(session: OperationLockSession): number {
  const pid = session.helperPid;
  if (pid === undefined) {
    throw new Error("operation-lock helper has no pid after acquisition");
  }
  return pid;
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "skiloom-lock-bridge-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
