import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import {
  parseRepositoryCoordinate
} from "../../../src/domain/coordinate/index.js";
import {
  discoverRepositorySkills
} from "../../../src/domain/discovery/index.js";
import {
  admitSkillPackage,
  parsePackageMetadata
} from "../../../src/domain/package/index.js";
import {
  buildPackageSnapshot,
  type RepositorySnapshotEntry
} from "../../../src/domain/snapshot/index.js";
import {
  buildGitHubResolverRepositorySnapshot
} from "../../../src/runtime/source/github/index.js";

const ROOTS = [
  "skiloom",
  "skiloom-author",
  "skiloom-discover",
  "skiloom-doctor",
  "skiloom-manage"
] as const;

const ROUTER_DEPENDENCIES = [
  "akira-tl/skiloom/skiloom-author",
  "akira-tl/skiloom/skiloom-discover",
  "akira-tl/skiloom/skiloom-doctor",
  "akira-tl/skiloom/skiloom-manage"
] as const;

test("first-party Skill roots are ordinary admitted Packages", async () => {
  for (const name of ROOTS) {
    const skillMarkdown = await readFile(
      join("skills", name, "SKILL.md"),
      "utf8"
    );
    const admitted = admitSkillPackage({
      rootBasename: basename(join("skills", name)),
      skillMarkdown
    });
    assert.equal(admitted.ok, true, name);
    if (!admitted.ok) {
      continue;
    }
    assert.equal(admitted.value.name, name);
    assert.match(skillMarkdown, /SKILOOM-CLI-V1/u);
    assert.match(skillMarkdown, /--json/u);
  }
});

test("repository discovery control exposes exactly the five product Skill roots", async () => {
  const repositoryMetadata = await readFile(
    "skiloom-repo.toml",
    "utf8"
  );
  const files = await Promise.all(
    ROOTS.map(async (name) => ({
      path: `skills/${name}/SKILL.md`,
      content: await readFile(
        join("skills", name, "SKILL.md"),
        "utf8"
      )
    }))
  );
  files.push({
    path: "test/fixtures/internal-helper/SKILL.md",
    content: [
      "---",
      "name: internal-helper",
      "description: Development-only fixture that must stay undiscovered.",
      "---",
      ""
    ].join("\n")
  });

  const discovered = discoverRepositorySkills({
    repositoryRootBasename: "skiloom",
    repositoryMetadata,
    files
  });

  assert.equal(discovered.ok, true);
  if (!discovered.ok) {
    return;
  }
  assert.deepEqual(
    discovered.value.map((entry) => [
      entry.name,
      entry.packageRoot
    ]),
    ROOTS.map((name) => [name, `skills/${name}`])
  );
});

test("the first-party repository snapshot feeds Router dependencies into the ordinary resolver source pipeline", async () => {
  const repository = parseRepositoryCoordinate(
    "akira-tl/skiloom"
  );
  assert.equal(repository.ok, true);
  if (!repository.ok) {
    return;
  }

  const entries: RepositorySnapshotEntry[] = [
    regularEntry(
      "skiloom-repo.toml",
      await readFile("skiloom-repo.toml")
    )
  ];
  for (const name of ROOTS) {
    entries.push(
      regularEntry(
        `skills/${name}/SKILL.md`,
        await readFile(
          join("skills", name, "SKILL.md")
        )
      )
    );
  }
  entries.push(
    regularEntry(
      "skills/skiloom/skiloom-package.toml",
      await readFile(
        "skills/skiloom/skiloom-package.toml"
      )
    )
  );

  const source =
    buildGitHubResolverRepositorySnapshot({
      repository: repository.value,
      exactCommit:
        "1111111111111111111111111111111111111111",
      entries
    });

  assert.equal(source.ok, true);
  if (!source.ok) {
    return;
  }
  assert.deepEqual(
    source.value.packages.map(
      (entry) => entry.coordinate.canonical
    ),
    ROOTS.map(
      (name) => `akira-tl/skiloom/${name}`
    ).sort()
  );
  const router = source.value.packages.find(
    (entry) =>
      entry.coordinate.canonical ===
      "akira-tl/skiloom/skiloom"
  );
  assert.notEqual(router, undefined);
  assert.deepEqual(
    router?.dependencies.map((entry) => [
      entry.target.canonical,
      entry.requirement
    ]),
    ROUTER_DEPENDENCIES.map(
      (coordinate) => [coordinate, "*"]
    )
  );
});

test("the Router declares exactly four ordinary specialist Package dependencies", async () => {
  const manifest = await readFile(
    "skills/skiloom/skiloom-package.toml",
    "utf8"
  );
  const parsed = parsePackageMetadata(manifest);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  assert.deepEqual(
    Object.keys(parsed.value.dependencies).sort(),
    [...ROUTER_DEPENDENCIES].sort()
  );
  assert.deepEqual(
    Object.values(parsed.value.dependencies),
    ["*", "*", "*", "*"]
  );
  assert.deepEqual(parsed.value.software, {});
});

test("each first-party root snapshots independently through the ordinary Package snapshot pipeline", async () => {
  const discoveredPackageRoots =
    ROOTS.map((name) => `skills/${name}`);

  for (const name of ROOTS) {
    const root = `skills/${name}`;
    const entries: RepositorySnapshotEntry[] = [
      regularEntry(
        `${root}/SKILL.md`,
        await readFile(join(root, "SKILL.md"))
      )
    ];
    if (name === "skiloom") {
      entries.push(
        regularEntry(
          `${root}/skiloom-package.toml`,
          await readFile(
            join(root, "skiloom-package.toml")
          )
        )
      );
    }

    const snapshot = buildPackageSnapshot({
      packageRoot: root,
      discoveredPackageRoots,
      entries
    });

    assert.equal(snapshot.ok, true, name);
    if (!snapshot.ok) {
      continue;
    }
    assert.equal(
      snapshot.value.entries.some(
        (entry) => entry.path === "SKILL.md"
      ),
      true,
      name
    );
    assert.match(
      snapshot.value.contentDigest,
      /^sha256:[0-9a-f]{64}$/u
    );
  }
});

test("first-party executable guidance uses only the public Skiloom CLI", async () => {
  for (const name of ROOTS) {
    const text = await skillText(name);
    const fenced = [
      ...text.matchAll(/```text\n([\s\S]*?)```/gu)
    ].flatMap((match) =>
      (match[1] ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    );

    for (const line of fenced) {
      assert.match(
        line,
        /^skiloom\s/u,
        `${name}: executable guidance must use the public CLI`
      );
    }
    assert.doesNotMatch(
      text,
      /\b(?:sqlite3|rm|cp|mv)\s+-?/u,
      name
    );
    assert.doesNotMatch(
      text,
      /(?:node|python|python3)\s+-e\b/u,
      name
    );
  }
});

test("Router examples map discovery management diagnosis and authoring to the intended specialists", async () => {
  const router = await skillText("skiloom");
  const examples = [
    ["find a Skill", "skiloom-discover"],
    ["install or update", "skiloom-manage"],
    ["record the result", "skiloom-manage"],
    ["diagnose a Target", "skiloom-doctor"],
    ["author a Skill", "skiloom-author"]
  ] as const;

  for (const [intent, specialist] of examples) {
    assert.match(
      router,
      new RegExp(
        escapeRegExp(intent) + "[^\n]*" +
        escapeRegExp(specialist),
        "iu"
      ),
      intent
    );
  }
  assert.match(
    router,
    /bootstrap[^\n]*skiloom-manage/iu
  );
});

test("management guidance separates plan commit retarget merge and bootstrap authorization", async () => {
  const manage = await skillText("skiloom-manage");

  for (const command of [
    "install <coordinate>",
    "update",
    "remove <coordinate>",
    "recover",
    "fork",
    "import <file>",
    "bootstrap"
  ]) {
    assert.match(
      manage,
      new RegExp(
        escapeRegExp(
          "skiloom " + command + " --plan --json"
        ),
        "u"
      ),
      command
    );
  }

  assert.match(
    manage,
    /skiloom update --yes --allow-release-retarget --json/u
  );
  assert.match(
    manage,
    /skiloom import <file> --merge --yes --json/u
  );
  assert.match(
    manage,
    /skiloom bootstrap --yes --json/u
  );
  assert.match(
    manage,
    /skiloom observe <package> <name> --status <status> --json/u
  );
  assert.match(
    manage,
    /skiloom observe <package> <name> --clear --json/u
  );
  assert.match(
    manage,
    /observe[^\n]*(?:do not|never)[^\n]*--plan/iu
  );
  assert.match(
    manage,
    /observe[^\n]*(?:do not|never)[^\n]*--yes/iu
  );
  assert.match(
    manage,
    /--json[^\n]*(?:does not|never)[^\n]*--yes/iu
  );
  assert.match(
    manage,
    /--yes[^\n]*(?:does not|never)[^\n]*(?:retarget|--allow-release-retarget)/iu
  );
  assert.match(
    manage,
    /--yes[^\n]*(?:does not|never)[^\n]*(?:merge|--merge)/iu
  );
  assert.match(
    manage,
    /one Target|single Target/iu
  );
  assert.doesNotMatch(
    manage,
    /postinstall|first[- ]run[^\n]*mutat/iu
  );
  assert.doesNotMatch(
    manage,
    /(?:all|every|multiple)\s+(?:Host|Target)[^\n]*(?:bootstrap|install)/iu
  );
});

test("first-party Agent guidance forbids private writes and human-output parsing", async () => {
  for (const name of ROOTS) {
    const text = await skillText(name);

    assert.match(
      text,
      /SKILOOM-CLI-V1/u,
      name
    );
    assert.match(
      text,
      /(?:do not|never)[^\n]*parse[^\n]*human/iu,
      name
    );
    assert.doesNotMatch(
      text,
      /\b(?:DatabaseSync|better-sqlite3|sqlite3\s|fs\.writeFile|writeFile\(|rename\(|unlink\(|rm\(|cp\(|mv\s)\b/u,
      name
    );
    for (const line of text.split("\n")) {
      if (
        /(?:open|edit|modify|write|delete|overwrite)[^\n]*(?:registry\.sqlite3|Package Store|\.skiloom-state|Target (?:contents?|files?|state))/iu.test(
          line
        )
      ) {
        assert.match(
          line,
          /(?:do not|never|must not)/iu,
          name + ": private write guidance must be prohibitive"
        );
      }
    }
  }
});

test("doctor stays recommendation-only and author stays package-format focused", async () => {
  const doctor = await skillText("skiloom-doctor");
  assert.match(doctor, /read-only/u);
  assert.match(
    doctor,
    /recommend[^\n]*(?:skiloom|command)/iu
  );
  assert.doesNotMatch(
    doctor,
    /(?:run|execute)[^\n]*(?:sync|repair|recover|rebind)[^\n]*automatically/iu
  );

  const author = await skillText("skiloom-author");
  for (const file of [
    "SKILL.md",
    "skiloom-package.toml",
    "skiloom-repo.toml",
    "DEPENDENCIES.md"
  ]) {
    assert.match(
      author,
      new RegExp(
        escapeRegExp(file),
        "u"
      )
    );
  }
  assert.match(author, /skiloom validate <path> --json/u);
  assert.doesNotMatch(
    author,
    /skiloom (?:install|update|remove|bootstrap)\b/u
  );
});

test("first-party instructions route responsibilities through public Skiloom commands", async () => {
  const router = await skillText("skiloom");
  assert.match(router, /skiloom-discover/u);
  assert.match(router, /skiloom-manage/u);
  assert.match(router, /skiloom-doctor/u);
  assert.match(router, /skiloom-author/u);

  const discover = await skillText("skiloom-discover");
  assert.match(discover, /skiloom search/u);
  assert.match(discover, /Catalog/u);
  assert.match(discover, /GitHub/u);

  const manage = await skillText("skiloom-manage");
  for (const command of [
    "install",
    "update",
    "remove",
    "sync",
    "repair",
    "observe",
    "recover",
    "fork",
    "export",
    "import"
  ]) {
    assert.match(manage, new RegExp(`skiloom ${command}`, "u"));
  }

  const doctor = await skillText("skiloom-doctor");
  assert.match(doctor, /skiloom doctor/u);
  assert.match(doctor, /skiloom observe/u);
  assert.match(doctor, /read-only/u);
  assert.doesNotMatch(doctor, /automatically repair/iu);

  const author = await skillText("skiloom-author");
  for (const file of [
    "SKILL.md",
    "skiloom-package.toml",
    "skiloom-repo.toml",
    "DEPENDENCIES.md"
  ]) {
    assert.match(author, new RegExp(file.replace(".", "\\."), "u"));
  }
  assert.match(author, /skiloom validate/u);
});

async function skillText(name: string): Promise<string> {
  return readFile(join("skills", name, "SKILL.md"), "utf8");
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^(){}$|[\]\\]/gu, "\\$&");
}

function regularEntry(
  path: string,
  content: Uint8Array
): RepositorySnapshotEntry {
  return {
    pathBytes: new TextEncoder().encode(path),
    fileType: "regular",
    gitMode: "100644",
    content
  };
}
