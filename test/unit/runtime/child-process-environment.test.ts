import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  restrictedChildProcessEnvironment
} from "../../../src/runtime/child-process/environment.js";

test("restricted child environment preserves only process-startup lookup temp and locale variables", () => {
  const restricted = restrictedChildProcessEnvironment({
    PATH: "/bin:/usr/bin",
    PaTh: "host-casing-path",
    PATHEXT: ".EXE;.CMD",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    TEMP: "/tmp/temp",
    TMP: "/tmp/tmp",
    TMPDIR: "/tmp/tmpdir",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    LC_CTYPE: "C.UTF-8",
    HOME: "/secret-home",
    GH_TOKEN: "github-primary-secret",
    GITHUB_TOKEN: "github-fallback-secret",
    SKILLSMP_API_KEY: "catalog-secret",
    NPM_TOKEN: "npm-secret",
    ARBITRARY_SENTINEL_SECRET: "arbitrary-secret"
  });

  assert.deepEqual(restricted, {
    PATH: "/bin:/usr/bin",
    PATHEXT: ".EXE;.CMD",
    WINDIR: "C:\\Windows",
    TEMP: "/tmp/temp",
    TMP: "/tmp/tmp",
    TMPDIR: "/tmp/tmpdir",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    LC_CTYPE: "C.UTF-8"
  });
});

test("a real child process cannot observe credentials or arbitrary inherited secrets", () => {
  const environment = restrictedChildProcessEnvironment({
    ...process.env,
    GH_TOKEN: "github-primary-secret",
    GITHUB_TOKEN: "github-fallback-secret",
    SKILLSMP_API_KEY: "catalog-secret",
    ARBITRARY_SENTINEL_SECRET: "arbitrary-secret"
  });

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      [
        "process.stdout.write(JSON.stringify({",
        "gh: process.env.GH_TOKEN ?? null,",
        "github: process.env.GITHUB_TOKEN ?? null,",
        "skillsmp: process.env.SKILLSMP_API_KEY ?? null,",
        "arbitrary: process.env.ARBITRARY_SENTINEL_SECRET ?? null,",
        "path: process.env.PATH ?? process.env.Path ?? null",
        "}))"
      ].join("")
    ],
    {
      env: environment,
      encoding: "utf8"
    }
  );

  assert.equal(child.status, 0);
  assert.equal(child.stderr, "");
  const observed = JSON.parse(child.stdout) as {
    gh: string | null;
    github: string | null;
    skillsmp: string | null;
    arbitrary: string | null;
    path: string | null;
  };
  assert.deepEqual(
    {
      gh: observed.gh,
      github: observed.github,
      skillsmp: observed.skillsmp,
      arbitrary: observed.arbitrary
    },
    {
      gh: null,
      github: null,
      skillsmp: null,
      arbitrary: null
    }
  );
  assert.notEqual(observed.path, null);
});

test("Windows restricted child environment collapses case-insensitive duplicate keys", () => {
  const restricted = restrictedChildProcessEnvironment(
    {
      Path: "C:\\preferred",
      PATH: "C:\\discarded",
      pathext: ".EXE;.CMD",
      PATHEXT: ".EXE",
      SystemRoot: "C:\\Windows",
      SYSTEMROOT: "C:\\discarded-root",
      GH_TOKEN: "secret"
    },
    "win32"
  );

  assert.deepEqual(restricted, {
    Path: "C:\\preferred",
    pathext: ".EXE;.CMD",
    SystemRoot: "C:\\Windows"
  });
});
