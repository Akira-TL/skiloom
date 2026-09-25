import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const CLI_ENTRY = resolve(".test-dist/src/cli/main.js");

test("validate --json reports admitted local package facts through the executable boundary", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skiloom-cli-validate-"));
  const packageRoot = join(temp, "demo");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "SKILL.md"),
    "---\nname: demo\ndescription: Demo skill.\n---\n",
    "utf8"
  );
  await writeFile(
    join(packageRoot, "skiloom-package.toml"),
    [
      "schema = 1",
      "",
      "[dependencies]",
      "\"acme/shared/shared\" = \"^1.0.0\"",
      "",
      "[software]",
      "node = \">=22\"",
      ""
    ].join("\n"),
    "utf8"
  );

  try {
    const result = await runCli(["validate", packageRoot, "--json"]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: "SKILOOM-CLI-V1",
      ok: true,
      command: "validate",
      result: {
        path: packageRoot,
        repository: {
          include: ["**"],
          exclude: []
        },
        packages: [
          {
            name: "demo",
            description: "Demo skill.",
            packageRoot: ".",
            dependencies: {
              "acme/shared/shared": "^1.0.0"
            },
            software: {
              node: ">=22"
            }
          }
        ]
      },
      warnings: []
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("validate accepts a directory symlink used as a managed Target projection", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skiloom-cli-validate-symlink-"));
  const payloadRoot = join(temp, "payload");
  const projectionRoot = join(temp, "managed-skill");
  await mkdir(payloadRoot);
  await writeFile(
    join(payloadRoot, "SKILL.md"),
    "---\nname: managed-skill\ndescription: Managed symlink projection.\n---\n",
    "utf8"
  );
  await symlink(
    payloadRoot,
    projectionRoot,
    process.platform === "win32" ? "junction" : "dir"
  );

  try {
    const result = await runCli([
      "validate",
      projectionRoot,
      "--json"
    ]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      result: {
        path: string;
        packages: Array<{
          name: string;
          packageRoot: string;
        }>;
      };
    };
    assert.equal(output.ok, true);
    assert.equal(output.result.path, projectionRoot);
    assert.deepEqual(
      output.result.packages.map((entry) => ({
        name: entry.name,
        packageRoot: entry.packageRoot
      })),
      [{ name: "managed-skill", packageRoot: "." }]
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("validate --json discovers repository packages and parses package metadata", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skiloom-cli-repository-"));
  const alphaRoot = join(temp, "skills", "alpha");
  const betaRoot = join(temp, "skills", "beta");
  await mkdir(alphaRoot, { recursive: true });
  await mkdir(betaRoot, { recursive: true });
  await writeFile(
    join(temp, "skiloom-repo.toml"),
    [
      "schema = 1",
      "",
      "[discovery]",
      "include = [\"skills/*\"]",
      "exclude = [\"skills/beta\"]",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(alphaRoot, "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha skill.\n---\n",
    "utf8"
  );
  await writeFile(
    join(alphaRoot, "skiloom-package.toml"),
    "schema = 1\n\n[software]\nnode = \">=22\"\n",
    "utf8"
  );
  await writeFile(
    join(betaRoot, "SKILL.md"),
    "---\nname: beta\ndescription: Excluded beta.\n---\n",
    "utf8"
  );

  try {
    const result = await runCli(["validate", temp, "--json"]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout) as {
      result: {
        repository: {
          include: string[];
          exclude: string[];
        };
        packages: Array<{
          name: string;
          packageRoot: string;
          software: Record<string, string>;
        }>;
      };
    };
    assert.deepEqual(output.result.repository, {
      include: ["skills/*"],
      exclude: ["skills/beta"]
    });
    assert.deepEqual(output.result.packages, [
      {
        name: "alpha",
        description: "Alpha skill.",
        packageRoot: "skills/alpha",
        dependencies: {},
        software: { node: ">=22" }
      }
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("validate reports domain product errors as a single JSON failure document", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skiloom-cli-invalid-"));
  const packageRoot = join(temp, "wrong-root");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "SKILL.md"),
    "---\nname: different-name\ndescription: Invalid root mismatch.\n---\n",
    "utf8"
  );

  try {
    const result = await runCli(["validate", packageRoot, "--json"]);

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: "SKILOOM-CLI-V1",
      ok: false,
      command: "validate",
      error: {
        code: "InvalidSkillPackage",
        facts: {
          rootBasename: "wrong-root",
          reason: "name-root-mismatch"
        }
      },
      warnings: []
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("invalid CLI argv returns usage exit 2 and never accepts force", async () => {
  const result = await runCli(["validate", "--force", "--json"]);

  assert.equal(result.code, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: "SKILOOM-CLI-V1",
    ok: false,
    command: "validate",
    error: {
      code: "InvalidArguments",
      facts: {
        reason: "unknown option: --force"
      }
    },
    warnings: []
  });
});

test("validate defaults to the current directory and human output stays non-JSON", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skiloom-cli-cwd-"));
  const packageRoot = join(temp, "demo");
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "SKILL.md"),
    "---\nname: demo\ndescription: Current directory skill.\n---\n",
    "utf8"
  );

  try {
    const result = await runCli(["validate"], packageRoot);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      "Valid Skiloom package: " + packageRoot + "\n"
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

function runCli(
  args: ReadonlyArray<string>,
  cwd: string = process.cwd()
): Promise<Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
}
