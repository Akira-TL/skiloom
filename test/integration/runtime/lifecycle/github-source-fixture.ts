import {
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import type {
  DirectInstallRequirement
} from "../../../../src/domain/resolver/index.js";
import type {
  RegistryTargetState
} from "../../../../src/runtime/registry/index.js";
import type {
  GitHubJsonTransport,
  GitHubRepositoryTransport
} from "../../../../src/runtime/source/github/index.js";

export type SkillFixture = Readonly<{
  root: string;
  name: string;
  description: string;
  dependencies: Readonly<Record<string, string>>;
}>;

type SnapshotFixture = Readonly<{
  entries: ReadonlyArray<Readonly<{
    path: string;
    mode: "100644" | "100755";
    content: string;
  }>>;
}>;

type ReleaseFixture = Readonly<{
  tag: string;
  commit: string;
  immutable: boolean;
  snapshot: SnapshotFixture;
}>;

export type RepositoryFixture =
  | Readonly<{
      repository: string;
      sourceKind: "github-release";
      releases: ReadonlyArray<ReleaseFixture>;
    }>
  | Readonly<{
      repository: string;
      sourceKind: "git";
      requestedRef: string;
      exactCommit: string;
      snapshot: SnapshotFixture;
    }>;

export function skillPackage(
  root: string,
  name: string,
  description: string,
  dependencies: Readonly<Record<string, string>> = {}
): SkillFixture {
  return { root, name, description, dependencies };
}

export function release(
  tag: string,
  commitSeed: string,
  skills: ReadonlyArray<SkillFixture>,
  repositoryMetadata?: string
): ReleaseFixture {
  return {
    tag,
    commit: commit(commitSeed),
    immutable: true,
    snapshot: snapshot(skills, repositoryMetadata)
  };
}

export function releaseRepository(
  repository: string,
  releases: ReadonlyArray<ReleaseFixture>,
  _unused?: undefined,
  preserveOrder = false
): RepositoryFixture {
  return {
    repository,
    sourceKind: "github-release",
    releases: preserveOrder ? releases : [...releases]
  };
}

export function gitRepository(
  repository: string,
  requestedRef: string,
  commitSeed: string,
  skills: ReadonlyArray<SkillFixture>
): RepositoryFixture {
  return {
    repository,
    sourceKind: "git",
    requestedRef,
    exactCommit: commit(commitSeed),
    snapshot: snapshot(skills)
  };
}

function snapshot(
  skills: ReadonlyArray<SkillFixture>,
  repositoryMetadata?: string
): SnapshotFixture {
  const entries: Array<{
    path: string;
    mode: "100644";
    content: string;
  }> = [];
  if (repositoryMetadata !== undefined) {
    entries.push({
      path: "skiloom-repo.toml",
      mode: "100644",
      content: repositoryMetadata
    });
  }

  for (const skill of skills) {
    const prefix = skill.root === "." ? "" : skill.root + "/";
    entries.push({
      path: prefix + "SKILL.md",
      mode: "100644",
      content:
        `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n`
    });
    if (Object.keys(skill.dependencies).length > 0) {
      const lines = ["schema = 1", "", "[dependencies]"];
      for (const [coordinate, requirement] of Object.entries(
        skill.dependencies
      ).sort(([left], [right]) => left.localeCompare(right))) {
        lines.push(
          `${JSON.stringify(coordinate)} = ${JSON.stringify(requirement)}`
        );
      }
      entries.push({
        path: prefix + "skiloom-package.toml",
        mode: "100644",
        content: lines.join("\n") + "\n"
      });
    }
  }
  return { entries };
}

export function reverseRepositoryFixture(
  fixture: RepositoryFixture
): RepositoryFixture {
  if (fixture.sourceKind === "git") {
    return {
      ...fixture,
      snapshot: {
        entries: [...fixture.snapshot.entries].reverse()
      }
    };
  }
  return {
    ...fixture,
    releases: [...fixture.releases].reverse().map((entry) => ({
      ...entry,
      snapshot: {
        entries: [...entry.snapshot.entries].reverse()
      }
    }))
  };
}

export function sourceFixture(
  repositories: ReadonlyArray<RepositoryFixture>
): {
  repositoryTransport: GitHubRepositoryTransport;
  transport: GitHubJsonTransport;
  seenPaths: string[];
} {
  const byRepository = new Map(
    repositories.map((entry) => [entry.repository.toLowerCase(), entry])
  );
  const seenPaths: string[] = [];

  const repositoryTransport: GitHubRepositoryTransport = async (request) => {
    const fixture = byRepository.get(request.repository.canonical);
    if (fixture === undefined) {
      return { status: 404, body: { message: "missing fixture" } };
    }
    return {
      status: 200,
      body: { full_name: fixture.repository }
    };
  };

  const transport: GitHubJsonTransport = async (request) => {
    seenPaths.push(request.path);
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/u.exec(
      request.path
    );
    if (match === null) {
      throw new Error("invalid fixture path " + request.path);
    }
    const repository = decodeURIComponent(match[1]!) + "/" +
      decodeURIComponent(match[2]!);
    const fixture = byRepository.get(repository.toLowerCase());
    if (fixture === undefined) {
      return { status: 404, body: { message: "missing fixture" } };
    }
    const suffix = match[3]!;

    if (suffix === "/releases") {
      if (fixture.sourceKind !== "github-release") {
        throw new Error("Release fallback used for explicit Git fixture");
      }
      const page = Number(request.query?.page ?? "1");
      return {
        status: 200,
        body:
          page === 1
            ? fixture.releases.map((entry) => ({
                tag_name: entry.tag,
                draft: false,
                immutable: entry.immutable,
                target_commitish: "ignored"
              }))
            : []
      };
    }

    if (suffix.startsWith("/commits/")) {
      const requested = decodeURIComponent(
        suffix.slice("/commits/".length)
      );
      if (fixture.sourceKind === "git") {
        return requested === fixture.requestedRef
          ? { status: 200, body: { sha: fixture.exactCommit } }
          : { status: 422, body: { message: "missing ref" } };
      }
      const found = fixture.releases.find(
        (entry) => entry.tag === requested
      );
      return found === undefined
        ? { status: 422, body: { message: "missing tag" } }
        : { status: 200, body: { sha: found.commit } };
    }

    const snapshots =
      fixture.sourceKind === "git"
        ? [
            {
              exactCommit: fixture.exactCommit,
              snapshot: fixture.snapshot
            }
          ]
        : fixture.releases.map((entry) => ({
            exactCommit: entry.commit,
            snapshot: entry.snapshot
          }));

    for (const item of snapshots) {
      const treeSha = treeShaFor(item.exactCommit);
      if (suffix === "/git/commits/" + item.exactCommit) {
        return {
          status: 200,
          body: {
            sha: item.exactCommit,
            tree: { sha: treeSha }
          }
        };
      }
      if (suffix === "/git/trees/" + treeSha) {
        return {
          status: 200,
          body: {
            sha: treeSha,
            truncated: false,
            tree: item.snapshot.entries.map((entry, index) => ({
              path: entry.path,
              mode: entry.mode,
              type: "blob",
              sha: blobShaFor(item.exactCommit, index)
            }))
          }
        };
      }
      for (let index = 0; index < item.snapshot.entries.length; index += 1) {
        const entry = item.snapshot.entries[index]!;
        if (
          suffix ===
          "/git/blobs/" + blobShaFor(item.exactCommit, index)
        ) {
          return {
            status: 200,
            body: {
              sha: blobShaFor(item.exactCommit, index),
              encoding: "base64",
              content: Buffer.from(entry.content, "utf8").toString("base64")
            }
          };
        }
      }
    }

    throw new Error("unexpected fixture request " + request.path);
  };

  return { repositoryTransport, transport, seenPaths };
}

export function releasePackageRequirement(
  coordinate: string,
  versionRequirement?: string
): DirectInstallRequirement {
  return {
    kind: "package",
    coordinate: packageCoordinate(coordinate),
    sourceKind: "github-release",
    ...(versionRequirement === undefined ? {} : { versionRequirement })
  };
}

export function releaseRepositoryRequirement(
  coordinate: string,
  versionRequirement?: string
): DirectInstallRequirement {
  return {
    kind: "repository",
    coordinate: repositoryCoordinate(coordinate),
    sourceKind: "github-release",
    ...(versionRequirement === undefined ? {} : { versionRequirement })
  };
}

export function gitPackageRequirement(
  coordinate: string,
  requestedRef: string
): DirectInstallRequirement {
  return {
    kind: "package",
    coordinate: packageCoordinate(coordinate),
    sourceKind: "git",
    requestedRef
  };
}

export function waitForAbort(
  signal: AbortSignal | null | undefined
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true }
    );
  });
}

function repositoryCoordinate(input: string) {
  const parsed = parseRepositoryCoordinate(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}

function packageCoordinate(input: string) {
  const parsed = parsePackageCoordinate(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.code);
  }
  return parsed.value;
}

export function registryState(input: Readonly<{
  directRequirements: RegistryTargetState["directRequirements"];
  sources: RegistryTargetState["resolvedSources"];
  packages: RegistryTargetState["resolvedPackages"];
  edges?: RegistryTargetState["dependencyEdges"];
}>): RegistryTargetState {
  return {
    targetId: "11111111-1111-4111-8111-111111111111",
    generation: 1,
    locations: [],
    directRequirements: input.directRequirements,
    resolvedSources: input.sources,
    resolvedPackages: input.packages,
    dependencyEdges: input.edges ?? [],
    projections: [],
    detachedBaselines: [],
    dependencyObservations: []
  };
}

export function commit(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

function treeShaFor(exactCommit: string): string {
  return exactCommit.slice(1) + exactCommit.slice(0, 1);
}

function blobShaFor(exactCommit: string, index: number): string {
  const prefix = (index + 10).toString(16).padStart(2, "0");
  return (prefix + exactCommit).slice(0, 40).padEnd(40, "0");
}

export function digest(seed: string): string {
  return "sha256:" + Buffer.from(seed, "utf8")
    .toString("hex")
    .padEnd(64, "0")
    .slice(0, 64);
}
