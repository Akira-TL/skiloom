import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseExactExportPackage,
  writeExactExportManifest,
  writeExactExportPackage
} from "../../dist/domain/export-package/index.js";
import {
  createPackageSnapshot
} from "../../dist/domain/snapshot/index.js";
import {
  createUserPayload
} from "../../dist/domain/user-payload/index.js";

const RESULT_FORMAT = "SKILOOM-EXACT-EXPORT-BENCH-RESULT-V1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = resolve(SCRIPT_DIR, "corpus-v1.json");

const options = parseArgs(process.argv.slice(2));
const corpusPath = resolve(options.corpusPath ?? DEFAULT_CORPUS);
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
validateCorpus(corpus);

const warmupIterations =
  options.warmupIterations ?? corpus.warmupIterations;
const measureIterations =
  options.measureIterations ?? corpus.measureIterations;

const cases = [];
for (const benchmarkCase of corpus.cases) {
  const fixture = buildFixture(benchmarkCase);
  cases.push(
    await benchmarkCaseOperations(
      benchmarkCase,
      fixture,
      warmupIterations,
      measureIterations
    )
  );
}

const report = {
  format: RESULT_FORMAT,
  corpusFormat: corpus.format,
  corpusVersion: corpus.fixtureVersion,
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: platform(),
    osRelease: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    gcExposed: typeof globalThis.gc === "function"
  },
  settings: {
    warmupIterations,
    measureIterations,
    diskIncluded: false,
    networkIncluded: false,
    registryIncluded: false,
    targetFilesystemIncluded: false,
    measuredOperations: ["write-verify", "parse-verify"]
  },
  cases
};

const output = JSON.stringify(report, null, 2) + "\n";
if (options.outputPath === undefined) {
  process.stdout.write(output);
} else {
  const outputPath = resolve(options.outputPath);
  await writeFile(outputPath, output, "utf8");
  process.stdout.write(
    JSON.stringify(
      {
        format: report.format,
        outputPath,
        cases: report.cases.map((entry) => ({
          id: entry.id,
          payloadBytes: entry.corpus.payloadBytes,
          frameCount: entry.corpus.frameCount,
          containerBytes: entry.containerBytes,
          operations: Object.fromEntries(
            Object.entries(entry.operations).map(
              ([name, operation]) => [
                name,
                {
                  medianWallMs: operation.wallMs.median,
                  p95WallMs: operation.wallMs.p95,
                  medianCpuMs: operation.cpuMs.median,
                  medianMiBPerSecond:
                    operation.mebibytesPerSecond.median,
                  peakRssDeltaBytes:
                    operation.memory.peakRssDeltaBytes,
                  peakArrayBuffersDeltaBytes:
                    operation.memory.peakArrayBuffersDeltaBytes
                }
              ]
            )
          )
        }))
      },
      null,
      2
    ) + "\n"
  );
}

async function benchmarkCaseOperations(
  benchmarkCase,
  fixture,
  warmupIterations,
  measureIterations
) {
  const operations = {};
  for (const operation of ["write-verify", "parse-verify"]) {
    for (let index = 0; index < warmupIterations; index += 1) {
      runOperation(operation, fixture, false);
    }

    const iterations = [];
    let expectedDigest;
    let peakRssDeltaBytes = 0;
    let peakHeapUsedDeltaBytes = 0;
    let peakArrayBuffersDeltaBytes = 0;

    for (let index = 0; index < measureIterations; index += 1) {
      if (typeof globalThis.gc === "function") {
        globalThis.gc();
      }
      const measured = runOperation(operation, fixture, true);
      if (expectedDigest === undefined) {
        expectedDigest = measured.resultDigest;
      } else if (expectedDigest !== measured.resultDigest) {
        throw new Error(
          `non-deterministic ${operation} result for ${benchmarkCase.id}`
        );
      }
      iterations.push(measured);
      peakRssDeltaBytes = Math.max(
        peakRssDeltaBytes,
        measured.memory.peakRssDeltaBytes
      );
      peakHeapUsedDeltaBytes = Math.max(
        peakHeapUsedDeltaBytes,
        measured.memory.peakHeapUsedDeltaBytes
      );
      peakArrayBuffersDeltaBytes = Math.max(
        peakArrayBuffersDeltaBytes,
        measured.memory.peakArrayBuffersDeltaBytes
      );
    }

    operations[operation] = {
      wallMs: summarize(iterations.map((entry) => entry.wallMs)),
      cpuMs: summarize(iterations.map((entry) => entry.cpuMs)),
      mebibytesPerSecond: summarize(
        iterations.map((entry) => entry.mebibytesPerSecond)
      ),
      memory: {
        peakRssDeltaBytes,
        peakHeapUsedDeltaBytes,
        peakArrayBuffersDeltaBytes
      },
      resultDigest: expectedDigest,
      iterations: iterations.map((entry) => ({
        wallMs: entry.wallMs,
        cpuMs: entry.cpuMs,
        mebibytesPerSecond: entry.mebibytesPerSecond,
        rssDeltaBytes: entry.memory.peakRssDeltaBytes,
        heapUsedDeltaBytes: entry.memory.peakHeapUsedDeltaBytes,
        arrayBuffersDeltaBytes:
          entry.memory.peakArrayBuffersDeltaBytes
      }))
    };
  }

  return {
    id: benchmarkCase.id,
    corpus: {
      managedFileCount: benchmarkCase.managedFileCount,
      managedBytesPerFile: benchmarkCase.managedBytesPerFile,
      userFileCount: benchmarkCase.userFileCount,
      userBytesPerFile: benchmarkCase.userBytesPerFile,
      executableEvery: benchmarkCase.executableEvery,
      payloadBytes: fixture.payloadBytes,
      frameCount: fixture.package.frames.length
    },
    containerBytes: fixture.container.length,
    containerDigest: fixture.containerDigest,
    operations
  };
}

function runOperation(operation, fixture, measureMemory) {
  const baseline = process.memoryUsage();
  const baselineMaxRss = process.resourceUsage().maxRSS * 1024;
  const cpuStart = process.cpuUsage();
  const started = process.hrtime.bigint();

  let resultDigest;
  if (operation === "write-verify") {
    const written = writeExactExportPackage(fixture.package);
    if (!written.ok) {
      throw new Error(
        `write benchmark failed: ${JSON.stringify(written.error)}`
      );
    }
    resultDigest = sha256(written.value);
    if (resultDigest !== fixture.containerDigest) {
      throw new Error("write benchmark changed canonical container bytes");
    }
  } else {
    const parsed = parseExactExportPackage(fixture.container);
    if (!parsed.ok) {
      throw new Error(
        `parse benchmark failed: ${JSON.stringify(parsed.error)}`
      );
    }
    resultDigest = parsedSemanticDigest(parsed.value);
    if (resultDigest !== fixture.semanticDigest) {
      throw new Error("parse benchmark changed canonical semantic facts");
    }
  }

  const elapsedNs = process.hrtime.bigint() - started;
  const cpu = process.cpuUsage(cpuStart);
  const after = process.memoryUsage();
  const maxRssAfter = process.resourceUsage().maxRSS * 1024;
  const wallMs = nsToMs(elapsedNs);
  const mebibytesPerSecond =
    wallMs === 0
      ? 0
      : fixture.payloadBytes / (1024 * 1024) / (wallMs / 1000);

  return {
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    mebibytesPerSecond,
    resultDigest,
    memory: measureMemory
      ? {
          peakRssDeltaBytes: Math.max(
            0,
            maxRssAfter - baselineMaxRss
          ),
          peakHeapUsedDeltaBytes: Math.max(
            0,
            after.heapUsed - baseline.heapUsed
          ),
          peakArrayBuffersDeltaBytes: Math.max(
            0,
            after.arrayBuffers - baseline.arrayBuffers
          )
        }
      : {
          peakRssDeltaBytes: 0,
          peakHeapUsedDeltaBytes: 0,
          peakArrayBuffersDeltaBytes: 0
        }
  };
}

function buildFixture(benchmarkCase) {
  const managedEntries = buildEntries(
    `${benchmarkCase.id}:managed`,
    benchmarkCase.managedFileCount,
    benchmarkCase.managedBytesPerFile,
    benchmarkCase.executableEvery,
    "managed"
  );
  const managed = createPackageSnapshot(managedEntries);
  if (!managed.ok) {
    throw new Error(
      `managed benchmark fixture invalid: ${JSON.stringify(managed.error)}`
    );
  }
  const managedPayloadId =
    `package:${managed.value.contentDigest}`;

  let user;
  if (benchmarkCase.userFileCount > 0) {
    user = createUserPayload(
      buildEntries(
        `${benchmarkCase.id}:user`,
        benchmarkCase.userFileCount,
        benchmarkCase.userBytesPerFile,
        benchmarkCase.executableEvery,
        "user"
      )
    );
    if (!user.ok) {
      throw new Error(
        `user benchmark fixture invalid: ${JSON.stringify(user.error)}`
      );
    }
  }

  const manifest = {
    format: "SKILOOM-EXPORT-V1",
    mode: user === undefined ? "dependencies" : "full",
    requirements: [
      {
        kind: "package",
        coordinate: "benchmark/repo/pkg",
        sourceKind: "github-release",
        versionRequirement: "^1.0.0"
      }
    ],
    sources: [
      {
        repositoryCoordinate: "benchmark/repo",
        sourceKind: "github-release",
        version: "1.0.0",
        actualTag: "v1.0.0",
        exactCommit: "1".repeat(40),
        immutable: true
      }
    ],
    packages: [
      {
        packageCoordinate: "benchmark/repo/pkg",
        packageRoot: ".",
        contentDigest: managed.value.contentDigest,
        payloadId: managedPayloadId
      }
    ],
    dependencies: [],
    projections: [
      {
        packageCoordinate: "benchmark/repo/pkg",
        activationName: "pkg"
      }
    ],
    detached: [],
    userSkills:
      user === undefined
        ? []
        : [
            {
              activationName: "manual",
              skillName: "manual",
              payloadId: user.value.payloadId,
              userContentDigest: user.value.contentDigest
            }
          ]
  };
  const frames = [
    ...managed.value.entries.map((entry) => ({
      payloadId: managedPayloadId,
      path: entry.path,
      executable: entry.executable,
      content: entry.content
    })),
    ...(user === undefined
      ? []
      : user.value.entries.map((entry) => ({
          payloadId: user.value.payloadId,
          path: entry.path,
          executable: entry.executable,
          content: entry.content
        })))
  ];
  const packageValue = { manifest, frames };
  const written = writeExactExportPackage(packageValue);
  if (!written.ok) {
    throw new Error(
      `benchmark container fixture invalid: ${JSON.stringify(written.error)}`
    );
  }
  const parsed = parseExactExportPackage(written.value);
  if (!parsed.ok) {
    throw new Error("benchmark container did not parse");
  }

  return {
    package: packageValue,
    container: written.value,
    containerDigest: sha256(written.value),
    semanticDigest: parsedSemanticDigest(parsed.value),
    payloadBytes:
      benchmarkCase.managedFileCount *
        benchmarkCase.managedBytesPerFile +
      benchmarkCase.userFileCount *
        benchmarkCase.userBytesPerFile
  };
}

function buildEntries(
  seedName,
  count,
  bytesPerFile,
  executableEvery,
  prefix
) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      path: `${prefix}/group-${pad(index % 64, 2)}/file-${pad(index, 6)}.bin`,
      executable:
        executableEvery > 0 &&
        index % executableEvery === 0,
      content: deterministicBytes(
        seedName,
        index,
        bytesPerFile
      )
    });
  }
  return entries;
}

function deterministicBytes(seedName, index, length) {
  const seed = createHash("sha256")
    .update(seedName)
    .update("\0")
    .update(String(index))
    .digest();
  const output = Buffer.allocUnsafe(length);
  for (let offset = 0; offset < length; offset += 1) {
    output[offset] = seed[offset % seed.length] ^ (offset & 0xff);
  }
  return Uint8Array.from(output);
}

function parsedSemanticDigest(value) {
  const hash = createHash("sha256");
  hash.update("SKILOOM-EXACT-EXPORT-BENCH-SEMANTICS-V1\0");
  hash.update(writeExactExportManifest(value.manifest), "utf8");
  for (const frame of value.frames) {
    hash.update(frame.payloadId, "utf8");
    hash.update("\0");
    hash.update(frame.path, "utf8");
    hash.update("\0");
    hash.update(Uint8Array.of(frame.executable ? 1 : 0));
    hash.update(frame.content);
  }
  return "sha256:" + hash.digest("hex");
}

function sha256(bytes) {
  return "sha256:" + createHash("sha256")
    .update(bytes)
    .digest("hex");
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: round(sorted[0] ?? 0),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1
  );
  return sorted[index] ?? 0;
}

function nsToMs(value) {
  return Number(value) / 1_000_000;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--corpus") {
      result.corpusPath = requiredValue(args, ++index, argument);
    } else if (argument === "--output") {
      result.outputPath = requiredValue(args, ++index, argument);
    } else if (argument === "--warmup") {
      result.warmupIterations = nonNegativeInteger(
        requiredValue(args, ++index, argument),
        argument
      );
    } else if (argument === "--iterations") {
      result.measureIterations = positiveIntegerValue(
        requiredValue(args, ++index, argument),
        argument
      );
    } else {
      throw new Error("unknown benchmark argument: " + argument);
    }
  }
  return result;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (value === undefined) {
    throw new Error(option + " requires a value");
  }
  return value;
}

function nonNegativeInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(option + " must be a non-negative integer");
  }
  return parsed;
}

function positiveIntegerValue(value, option) {
  const parsed = Number(value);
  if (!positiveInteger(parsed)) {
    throw new Error(option + " must be a positive integer");
  }
  return parsed;
}

function validateCorpus(corpus) {
  if (
    corpus?.format !== "SKILOOM-EXACT-EXPORT-BENCH-V1" ||
    corpus.fixtureVersion !== 1 ||
    !Number.isSafeInteger(corpus.warmupIterations) ||
    corpus.warmupIterations < 0 ||
    !positiveInteger(corpus.measureIterations) ||
    !Array.isArray(corpus.cases) ||
    corpus.cases.length === 0
  ) {
    throw new Error("invalid exact-export benchmark corpus");
  }
  const ids = new Set();
  for (const benchmarkCase of corpus.cases) {
    if (
      typeof benchmarkCase?.id !== "string" ||
      benchmarkCase.id.length === 0 ||
      ids.has(benchmarkCase.id) ||
      !positiveInteger(benchmarkCase.managedFileCount) ||
      !positiveInteger(benchmarkCase.managedBytesPerFile) ||
      !Number.isSafeInteger(benchmarkCase.userFileCount) ||
      benchmarkCase.userFileCount < 0 ||
      !Number.isSafeInteger(benchmarkCase.userBytesPerFile) ||
      benchmarkCase.userBytesPerFile < 0 ||
      (benchmarkCase.userFileCount === 0) !==
        (benchmarkCase.userBytesPerFile === 0) ||
      !Number.isSafeInteger(benchmarkCase.executableEvery) ||
      benchmarkCase.executableEvery < 0
    ) {
      throw new Error("invalid exact-export benchmark case");
    }
    ids.add(benchmarkCase.id);
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
