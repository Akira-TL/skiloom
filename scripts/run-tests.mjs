import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const requested = process.argv[2] ?? "all";
const allowed = new Set(["all", "unit", "behavior"]);

if (!allowed.has(requested)) {
  console.error(`unknown test group: ${requested}`);
  process.exit(2);
}

const roots = requested === "all" ? ["unit", "behavior"] : [requested];
const files = [];

for (const root of roots) {
  await collect(resolve(".test-dist", "test", root), files);
}

files.sort();

if (files.length === 0) {
  console.error(`no compiled ${requested} tests found`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...files], {
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`test process terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

async function collect(directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(path, output);
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      output.push(path);
    }
  }
}
