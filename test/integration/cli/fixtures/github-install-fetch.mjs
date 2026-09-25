import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const originalFetch = globalThis.fetch;

installFailFastGitFixture();

const mode = process.env.SKILOOM_TEST_GITHUB_MODE ?? "base";
const expectedBearer =
  process.env.SKILOOM_TEST_EXPECT_GITHUB_BEARER;
const forbidAuthorization =
  process.env.SKILOOM_TEST_FORBID_GITHUB_AUTH === "1";

function installFailFastGitFixture() {
  if (process.env.SKILOOM_TEST_USE_REAL_SYSTEM_GIT === "1") {
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "skiloom-cli-fake-git-"));
  if (process.platform === "win32") {
    writeFileSync(join(root, "git.cmd"), "@exit /b 1\r\n", "utf8");
  } else {
    const executable = join(root, "git");
    writeFileSync(executable, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(executable, 0o755);
  }
  process.env.PATH = root + delimiter + (process.env.PATH ?? "");
  process.once("exit", () => {
    rmSync(root, { recursive: true, force: true });
  });
}

function commit(seed) {
  return seed.repeat(40).slice(0, 40);
}

function treeShaFor(exactCommit) {
  return exactCommit.slice(1) + exactCommit.slice(0, 1);
}

function blobShaFor(exactCommit, index) {
  const prefix = (index + 10).toString(16).padStart(2, "0");
  return (prefix + exactCommit).slice(0, 40).padEnd(40, "0");
}

function skill(root, name, description) {
  const prefix = root === "." ? "" : root + "/";
  return {
    path: prefix + "SKILL.md",
    mode: "100644",
    content:
      "---\n" +
      "name: " + name + "\n" +
      "description: " + description + "\n" +
      "---\n"
  };
}

function packageManifest(root, dependencies, software = {}) {
  const prefix = root === "." ? "" : root + "/";
  const lines = ["schema = 1"];
  const dependencyEntries = Object.entries(dependencies);
  if (dependencyEntries.length > 0) {
    lines.push("", "[dependencies]");
    for (const [coordinate, requirement] of dependencyEntries) {
      lines.push(
        JSON.stringify(coordinate) + " = " +
        JSON.stringify(requirement)
      );
    }
  }
  const softwareEntries = Object.entries(software);
  if (softwareEntries.length > 0) {
    lines.push("", "[software]");
    for (const [name, requirement] of softwareEntries) {
      lines.push(
        JSON.stringify(name) + " = " +
        JSON.stringify(requirement)
      );
    }
  }
  return {
    path: prefix + "skiloom-package.toml",
    mode: "100644",
    content: lines.join("\n") + "\n"
  };
}

function snapshot(entries) {
  return { entries };
}

function firstPartyRepository() {
  const specialists = [
    "skiloom-author",
    "skiloom-discover",
    "skiloom-doctor",
    "skiloom-manage"
  ];
  return {
    repository: "akira-tl/skiloom",
    sourceKind: "github-release",
    releases: [
      {
        tag: "v0.8.0",
        commit: commit("8"),
        immutable: true,
        snapshot: snapshot([
          {
            path: "skiloom-repo.toml",
            mode: "100644",
            content:
              'schema = 1\n\n[discovery]\ninclude = ["skills/*"]\n'
          },
          skill(
            "skills/skiloom",
            "skiloom",
            "Skiloom Router."
          ),
          packageManifest(
            "skills/skiloom",
            Object.fromEntries(
              specialists.map((name) => [
                "akira-tl/skiloom/" + name,
                "*"
              ])
            )
          ),
          ...specialists.map((name) =>
            skill(
              "skills/" + name,
              name,
              "Skiloom first-party specialist."
            )
          )
        ])
      }
    ]
  };
}

function appRepository() {
  const retarget = mode === "retarget";
  const releases = [
    {
      tag: "v1.0.0",
      commit: commit(retarget ? "4" : "1"),
      immutable: true,
      snapshot: snapshot([
        skill(
          ".",
          "app",
          retarget
            ? "Retargeted application."
            : "Baseline application."
        ),
        ...(mode === "shared-remove"
          ? [
              packageManifest(".", {
                "acme/shared/shared": "^1.0.0"
              })
            ]
          : mode === "host-observation"
            ? [
                packageManifest(
                  ".",
                  {},
                  { node: ">=22" }
                )
              ]
            : [])
      ])
    }
  ];
  if (mode === "versions") {
    releases.unshift({
      tag: "v2.0.0",
      commit: commit("5"),
      immutable: true,
      snapshot: snapshot([
        skill(".", "app", "Version two application.")
      ])
    });
  }
  return {
    repository: "acme/app",
    sourceKind: "github-release",
    releases
  };
}

const repositories = new Map(
  [
    appRepository(),
    firstPartyRepository(),
    {
      repository: "acme/suite",
      sourceKind: "github-release",
      releases: [
        {
          tag: "v1.0.0",
          commit: commit("2"),
          immutable: true,
          snapshot: snapshot([
            {
              path: "skiloom-repo.toml",
              mode: "100644",
              content:
                'schema = 1\n\n[discovery]\ninclude = ["skills/*"]\n'
            },
            skill("skills/alpha", "alpha", "Alpha package."),
            skill("skills/beta", "beta", "Beta package.")
          ])
        }
      ]
    },
    {
      repository: "acme/gitapp",
      sourceKind: "git",
      requestedRef: "main",
      exactCommit: commit("3"),
      snapshot: snapshot([
        skill(".", "gitapp", "Git application.")
      ])
    },
    {
      repository: "acme/tool",
      sourceKind: "github-release",
      releases: [
        {
          tag: "v1.0.0",
          commit: commit("6"),
          immutable: true,
          snapshot: snapshot([
            skill(".", "tool", "Tool package."),
            packageManifest(".", {
              "acme/shared/shared": "^1.0.0"
            })
          ])
        }
      ]
    },
    {
      repository: "acme/shared",
      sourceKind: "github-release",
      releases: [
        {
          tag: "v1.0.0",
          commit: commit("7"),
          immutable: true,
          snapshot: snapshot([
            skill(".", "shared", "Shared package.")
          ])
        }
      ]
    }
  ].map((entry) => [entry.repository.toLowerCase(), entry])
);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input)
  );
  if (url.origin !== "https://api.github.com") {
    return originalFetch(input, init);
  }

  const headers = new Headers(
    input instanceof Request
      ? input.headers
      : init?.headers
  );
  const authorization = headers.get("authorization");
  if (
    expectedBearer !== undefined &&
    authorization !== "Bearer " + expectedBearer
  ) {
    return json({ message: "fixture credential required" }, 401);
  }
  if (
    forbidAuthorization &&
    authorization !== null
  ) {
    throw new Error(
      "GitHub Authorization header forbidden by test fixture"
    );
  }

  if (mode === "forbid-network") {
    throw new Error("GitHub network access forbidden by test fixture");
  }

  const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/u.exec(
    url.pathname
  );
  if (match === null) {
    return json({ message: "invalid fixture path" }, 404);
  }
  const repository =
    decodeURIComponent(match[1]) + "/" +
    decodeURIComponent(match[2]);
  const fixture = repositories.get(repository.toLowerCase());
  if (fixture === undefined) {
    return json({ message: "missing fixture" }, 404);
  }
  const suffix = match[3] ?? "";
  if (
    mode === "release-metadata-only" &&
    suffix !== "" &&
    suffix !== "/releases"
  ) {
    throw new Error(
      "Release content/ref REST access forbidden by test fixture"
    );
  }
  if (
    mode === "exact-only" &&
    (
      suffix === "" ||
      suffix === "/releases" ||
      suffix.startsWith("/commits/")
    )
  ) {
    throw new Error(
      "version/ref resolution forbidden by exact-only fixture"
    );
  }

  if (suffix === "") {
    return json({ full_name: fixture.repository });
  }

  if (suffix === "/releases") {
    if (fixture.sourceKind !== "github-release") {
      return json({ message: "release fallback forbidden" }, 404);
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    return json(
      page === 1
        ? fixture.releases.map((release) => ({
            tag_name: release.tag,
            draft: false,
            immutable: release.immutable,
            target_commitish: "ignored"
          }))
        : []
    );
  }

  if (suffix.startsWith("/commits/")) {
    const requested = decodeURIComponent(
      suffix.slice("/commits/".length)
    );
    if (fixture.sourceKind === "git") {
      return requested === fixture.requestedRef
        ? json({ sha: fixture.exactCommit })
        : json({ message: "missing ref" }, 422);
    }
    const release = fixture.releases.find(
      (entry) => entry.tag === requested
    );
    return release === undefined
      ? json({ message: "missing tag" }, 422)
      : json({ sha: release.commit });
  }

  const snapshots =
    fixture.sourceKind === "git"
      ? [
          {
            exactCommit: fixture.exactCommit,
            snapshot: fixture.snapshot
          }
        ]
      : fixture.releases.map((release) => ({
          exactCommit: release.commit,
          snapshot: release.snapshot
        }));

  for (const entry of snapshots) {
    const treeSha = treeShaFor(entry.exactCommit);
    if (suffix === "/git/commits/" + entry.exactCommit) {
      return json({
        sha: entry.exactCommit,
        tree: { sha: treeSha }
      });
    }
    if (suffix === "/git/trees/" + treeSha) {
      return json({
        sha: treeSha,
        truncated: false,
        tree: entry.snapshot.entries.map((file, index) => ({
          path: file.path,
          mode: file.mode,
          type: "blob",
          sha: blobShaFor(entry.exactCommit, index)
        }))
      });
    }
    for (
      let index = 0;
      index < entry.snapshot.entries.length;
      index += 1
    ) {
      const file = entry.snapshot.entries[index];
      if (
        suffix ===
        "/git/blobs/" + blobShaFor(entry.exactCommit, index)
      ) {
        return json({
          sha: blobShaFor(entry.exactCommit, index),
          encoding: "base64",
          content: Buffer.from(file.content, "utf8").toString("base64")
        });
      }
    }
  }

  return json({ message: "unexpected fixture request" }, 404);
};
