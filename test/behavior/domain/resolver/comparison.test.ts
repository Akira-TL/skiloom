import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../../../../src/domain/coordinate/index.js";
import {
  compareCandidateGraphs,
  type CandidateComparison,
  type DirectInstallRequirement,
  type ResolverCandidateGraph
} from "../../../../src/domain/resolver/index.js";

type DirectFixture = Readonly<{
  kind: "package" | "repository";
  coordinate: string;
  source: "github-release" | "git";
  version?: string;
  ref?: string;
}>;

type ComparisonFixture = Readonly<{
  id: string;
  directRequirements: ReadonlyArray<DirectFixture>;
  previous?: ResolverCandidateGraph;
  candidate: ResolverCandidateGraph;
  expected: CandidateComparison;
}>;

type Fixture = Readonly<{
  fixtureVersion: 1;
  cases: ReadonlyArray<ComparisonFixture>;
}>;

test("candidate comparison emits deterministic source/content/origin facts", async () => {
  const fixture = await readFixture();

  for (const example of fixture.cases) {
    const directRequirements = example.directRequirements.map(parseDirectRequirement);
    const result = compareCandidateGraphs({
      previous: example.previous,
      candidate: example.candidate,
      directRequirements
    });
    assert.deepEqual(result, example.expected, example.id);

    const reversed = compareCandidateGraphs({
      previous: example.previous === undefined ? undefined : reverseGraph(example.previous),
      candidate: reverseGraph(example.candidate),
      directRequirements: [...directRequirements].reverse()
    });
    assert.deepEqual(reversed, result, `${example.id}: reversed input order`);
  }
});

function parseDirectRequirement(fixture: DirectFixture): DirectInstallRequirement {
  if (fixture.kind === "package") {
    const coordinate = packageCoordinate(fixture.coordinate);
    if (fixture.source === "git") {
      assert.equal(typeof fixture.ref, "string", `${fixture.coordinate}: git ref`);
      return {
        kind: "package",
        coordinate,
        sourceKind: "git",
        requestedRef: fixture.ref ?? ""
      };
    }
    return {
      kind: "package",
      coordinate,
      sourceKind: "github-release",
      ...(fixture.version === undefined ? {} : { versionRequirement: fixture.version })
    };
  }

  const coordinate = repositoryCoordinate(fixture.coordinate);
  if (fixture.source === "git") {
    assert.equal(typeof fixture.ref, "string", `${fixture.coordinate}: git ref`);
    return {
      kind: "repository",
      coordinate,
      sourceKind: "git",
      requestedRef: fixture.ref ?? ""
    };
  }
  return {
    kind: "repository",
    coordinate,
    sourceKind: "github-release",
    ...(fixture.version === undefined ? {} : { versionRequirement: fixture.version })
  };
}

function repositoryCoordinate(input: string) {
  const parsed = parseRepositoryCoordinate(input);
  assert.equal(parsed.ok, true, input);
  if (!parsed.ok) {
    throw new Error(`invalid repository coordinate fixture: ${input}`);
  }
  return parsed.value;
}

function packageCoordinate(input: string) {
  const parsed = parsePackageCoordinate(input);
  assert.equal(parsed.ok, true, input);
  if (!parsed.ok) {
    throw new Error(`invalid package coordinate fixture: ${input}`);
  }
  return parsed.value;
}

function reverseGraph(graph: ResolverCandidateGraph): ResolverCandidateGraph {
  return {
    sourceBindings: [...graph.sourceBindings].reverse(),
    packages: [...graph.packages].reverse(),
    dependencyEdges: [...graph.dependencyEdges].reverse()
  };
}

async function readFixture(): Promise<Fixture> {
  const raw = await readFile(
    resolve("behavior-fixtures", "resolver", "comparison.json"),
    "utf8"
  );
  return JSON.parse(raw) as Fixture;
}
