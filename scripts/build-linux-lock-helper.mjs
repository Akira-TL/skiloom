import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { auditLinuxLockHelper } from "./audit-linux-lock-helper.mjs";

const MANYLINUX_IMAGE =
  "quay.io/pypa/manylinux2014_x86_64@sha256:2fa5f99f660f115f547d96b4edcadfc19f77a6de8807734bf0fc4924f81be01a";
const TARGET_DIRECTORY = "native/skiloom-lock/target/manylinux2014";
const BINARY_PATH = TARGET_DIRECTORY + "/release/skiloom-lock";

if (
  process.platform !== "linux" ||
  process.arch !== "x64" ||
  process.getuid === undefined ||
  process.getgid === undefined
) {
  throw new Error(
    "manylinux lock-helper build requires a Linux x64 Docker host"
  );
}

const rustc = (
  await runCapture("rustup", ["+1.89.0", "which", "rustc"])
).trim();
if (rustc.length === 0) {
  throw new Error("Rust 1.89 rustc path is unavailable");
}
const toolchainRoot = dirname(dirname(rustc));
const repositoryRoot = process.cwd();

await runInherit("docker", [
  "run",
  "--rm",
  "--user",
  String(process.getuid()) + ":" + String(process.getgid()),
  "-e",
  "HOME=/tmp",
  "-v",
  repositoryRoot + ":/work",
  "-v",
  toolchainRoot + ":/rust:ro",
  "-w",
  "/work",
  MANYLINUX_IMAGE,
  "/bin/bash",
  "-c",
  "export PATH=/rust/bin:$PATH; exec cargo build " +
    "--manifest-path native/skiloom-lock/Cargo.toml " +
    "--locked --release --target-dir " +
    TARGET_DIRECTORY
]);

const binary = resolve(BINARY_PATH);
await auditLinuxLockHelper(binary, "2.17");
process.stdout.write(binary + "\n");

function runCapture(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            command + " " + args.join(" ") +
              " failed with code " + String(code ?? "null") +
              (signal === null ? "" : " signal " + signal) +
              (stderr.length === 0 ? "" : ": " + stderr.trim())
          )
        );
        return;
      }
      resolveResult(stdout);
    });
  });
}

function runInherit(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            command + " failed with code " + String(code ?? "null") +
              (signal === null ? "" : " signal " + signal)
          )
        );
        return;
      }
      resolveResult();
    });
  });
}
