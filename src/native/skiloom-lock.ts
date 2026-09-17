import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { isAbsolute } from "node:path";

import {
  productError,
  type ProductError,
  type Result
} from "../domain/errors/index.js";

const ACQUIRED_LINE = "SKILOOM-LOCK-V1 ACQUIRED\n";
const CONTENDED_LINE = "SKILOOM-LOCK-V1 CONTENDED\n";
const UNSUPPORTED_LINE = "SKILOOM-LOCK-V1 UNSUPPORTED\n";
const MAX_HANDSHAKE_BYTES = 64;

export type OperationLocked = ProductError<
  "OperationLocked",
  Readonly<{ lockPath: string }>
>;

export type UnsupportedPlatformCapability = ProductError<
  "UnsupportedPlatformCapability",
  Readonly<{
    capability: "operation-lock";
    reason: "helper-missing" | "helper-unsupported";
  }>
>;

export type OperationLockHelperFailureReason =
  | "invalid-helper-path"
  | "invalid-lock-path"
  | "spawn-failed"
  | "invalid-handshake"
  | "helper-exited-before-handshake"
  | "release-failed";

export type OperationLockHelperFailure = ProductError<
  "OperationLockHelperFailure",
  Readonly<{
    reason: OperationLockHelperFailureReason;
  }>
>;

export type OperationLockLost = ProductError<
  "OperationLockLost",
  Readonly<{
    lockPath: string;
    reason:
      | "helper-exited"
      | "helper-error"
      | "lifetime-channel-error"
      | "protocol-closed"
      | "protocol-output"
      | "session-not-held";
  }>
>;

export type OperationLockAcquireError =
  | OperationLocked
  | UnsupportedPlatformCapability
  | OperationLockHelperFailure;

export type OperationLockReleaseError = OperationLockLost | OperationLockHelperFailure;

export type OperationLockAcquireInput = Readonly<{
  helperExecutable: string;
  lockPath: string;
}>;

export type OperationLockHandshake = "acquired" | "contended" | "unsupported";

export interface OperationLockSession {
  readonly held: boolean;
  /** Diagnostic only. Never use the PID as lock authority. */
  readonly helperPid: number | undefined;
  checkHeld(): Result<void, OperationLockLost>;
  waitForLoss(): Promise<OperationLockLost>;
  release(): Promise<Result<void, OperationLockReleaseError>>;
}

class HeldOperationLockSession implements OperationLockSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lockPath: string;
  readonly #loss: Promise<OperationLockLost>;
  #resolveLoss!: (error: OperationLockLost) => void;
  #state: "held" | "releasing" | "released" | "lost" = "held";
  #lostError: OperationLockLost | undefined;
  #releasePromise: Promise<Result<void, OperationLockReleaseError>> | undefined;

  constructor(child: ChildProcessWithoutNullStreams, lockPath: string) {
    this.#child = child;
    this.#lockPath = lockPath;
    this.#loss = new Promise((resolve) => {
      this.#resolveLoss = resolve;
    });

    child.on("exit", () => {
      if (this.#state === "held") {
        this.#markLost("helper-exited");
      }
    });
    child.on("error", () => {
      if (this.#state === "held") {
        this.#markLost("helper-error");
      }
    });
    child.stdin.on("error", () => {
      if (this.#state === "held") {
        this.#markLost("lifetime-channel-error");
      }
    });
    child.stdout.on("data", () => {
      if (this.#state === "held") {
        this.#markLost("protocol-output");
        child.kill();
      }
    });
    child.stdout.on("error", () => {
      if (this.#state === "held") {
        this.#markLost("protocol-closed");
      }
    });
    child.stdout.on("close", () => {
      if (this.#state === "held") {
        this.#markLost("protocol-closed");
      }
    });
  }

  get held(): boolean {
    return this.#state === "held";
  }

  get helperPid(): number | undefined {
    return this.#child.pid;
  }

  checkHeld(): Result<void, OperationLockLost> {
    if (this.#state === "held") {
      return { ok: true, value: undefined };
    }
    if (this.#lostError !== undefined) {
      return { ok: false, error: this.#lostError };
    }
    return {
      ok: false,
      error: productError("OperationLockLost", {
        lockPath: this.#lockPath,
        reason: "session-not-held"
      })
    };
  }

  waitForLoss(): Promise<OperationLockLost> {
    return this.#loss;
  }

  release(): Promise<Result<void, OperationLockReleaseError>> {
    if (this.#lostError !== undefined) {
      return Promise.resolve({ ok: false, error: this.#lostError });
    }
    if (this.#state === "released") {
      return Promise.resolve({ ok: true, value: undefined });
    }
    if (this.#releasePromise !== undefined) {
      return this.#releasePromise;
    }

    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      this.#markLost("helper-exited");
      return Promise.resolve({ ok: false, error: this.#lostError! });
    }

    this.#state = "releasing";
    this.#releasePromise = this.#release();
    return this.#releasePromise;
  }

  async #release(): Promise<Result<void, OperationLockReleaseError>> {
    try {
      this.#child.stdin.end();
    } catch {
      this.#state = "released";
      return {
        ok: false,
        error: helperFailure("release-failed")
      };
    }

    const exit = await waitForExit(this.#child);
    this.#state = "released";
    if (exit.code === 0 && exit.signal === null) {
      return { ok: true, value: undefined };
    }
    return {
      ok: false,
      error: helperFailure("release-failed")
    };
  }

  #markLost(reason: OperationLockLost["facts"]["reason"]): void {
    if (this.#state !== "held") {
      return;
    }
    const error = productError("OperationLockLost", {
      lockPath: this.#lockPath,
      reason
    });
    this.#state = "lost";
    this.#lostError = error;
    this.#resolveLoss(error);
  }
}

export async function acquireOperationLock(
  input: OperationLockAcquireInput
): Promise<Result<OperationLockSession, OperationLockAcquireError>> {
  if (!isAbsolute(input.helperExecutable)) {
    return { ok: false, error: helperFailure("invalid-helper-path") };
  }
  if (!isAbsolute(input.lockPath)) {
    return { ok: false, error: helperFailure("invalid-lock-path") };
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      input.helperExecutable,
      ["--protocol", "1", "--path", input.lockPath],
      {
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
  } catch {
    return { ok: false, error: helperFailure("spawn-failed") };
  }
  child.stderr.resume();

  return new Promise((resolve) => {
    let settled = false;
    let exitObserved = false;
    let buffer = Buffer.alloc(0);

    const cleanup = (): void => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout.off("data", onData);
      child.stdout.off("end", onStdoutEnd);
    };
    const settle = (result: Result<OperationLockSession, OperationLockAcquireError>): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectHandshake = (): void => {
      child.stdin.end();
      child.kill();
      settle({ ok: false, error: helperFailure("invalid-handshake") });
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        settle({
          ok: false,
          error: productError("UnsupportedPlatformCapability", {
            capability: "operation-lock",
            reason: "helper-missing"
          })
        });
        return;
      }
      settle({ ok: false, error: helperFailure("spawn-failed") });
    };
    const onExit = (): void => {
      exitObserved = true;
    };
    const onStdoutEnd = (): void => {
      if (!settled) {
        rejectHandshake();
      }
    };
    const onData = (chunk: Buffer): void => {
      if (settled) {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HANDSHAKE_BYTES) {
        rejectHandshake();
        return;
      }
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex < 0) {
        return;
      }
      if (newlineIndex !== buffer.length - 1) {
        rejectHandshake();
        return;
      }

      const handshake = parseOperationLockHandshake(buffer.toString("utf8"));
      if (handshake === undefined) {
        rejectHandshake();
        return;
      }
      if (handshake === "contended") {
        child.stdin.end();
        settle({
          ok: false,
          error: productError("OperationLocked", { lockPath: input.lockPath })
        });
        return;
      }
      if (handshake === "unsupported") {
        child.stdin.end();
        settle({
          ok: false,
          error: productError("UnsupportedPlatformCapability", {
            capability: "operation-lock",
            reason: "helper-unsupported"
          })
        });
        return;
      }

      if (
        exitObserved ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        settle({
          ok: false,
          error: helperFailure("helper-exited-before-handshake")
        });
        return;
      }

      cleanup();
      settled = true;
      resolve({
        ok: true,
        value: new HeldOperationLockSession(child, input.lockPath)
      });
    };

    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", onData);
    child.stdout.once("end", onStdoutEnd);
  });
}

export function parseOperationLockHandshake(line: string): OperationLockHandshake | undefined {
  switch (line) {
    case ACQUIRED_LINE:
      return "acquired";
    case CONTENDED_LINE:
      return "contended";
    case UNSUPPORTED_LINE:
      return "unsupported";
    default:
      return undefined;
  }
}

function helperFailure(reason: OperationLockHelperFailureReason): OperationLockHelperFailure {
  return productError("OperationLockHelperFailure", { reason });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}
