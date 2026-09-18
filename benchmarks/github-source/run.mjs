import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseRepositoryCoordinate
} from "../../dist/domain/coordinate/index.js";
import {
  acquireExactGitHubRepositorySnapshot
} from "../../dist/runtime/source/github/index.js";

const BENCHMARK_FORMAT = "SKILOOM-GITHUB-SOURCE-BENCH-RESULT-V1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_PATH = resolve(SCRIPT_DIR, "corpus-v1.json");
const REPOSITORY = parseRepositoryCoordinate("benchmark/source");
if (!REPOSITORY.ok) {
  throw new Error("internal benchmark repository coordinate is invalid");
}

const options = parseArgs(process.argv.slice(2));
const corpusPath = resolve(options.corpusPath ?? DEFAULT_CORPUS_PATH);
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
validateCorpus(corpus);

const warmupIterations =
  options.warmupIterations ?? corpus.warmupIterations;
const measureIterations =
  options.measureIterations ?? corpus.measureIterations;

const results = [];
for (const benchmarkCase of corpus.cases) {
  results.push(
    await runCase(
      benchmarkCase,
      warmupIterations,
      measureIterations
    )
  );
}

const report = {
  format: BENCHMARK_FORMAT,
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
    freeMemoryBytesAtStart: freemem(),
    gcExposed: typeof globalThis.gc === "function"
  },
  settings: {
    warmupIterations,
    measureIterations,
    networkIncluded: false,
    transportModel: "prebuilt parsed GitHub JSON facts"
  },
  cases: results
};

const output = JSON.stringify(report, null, 2) + "\n";
if (options.outputPath === undefined) {
  process.stdout.write(output);
} else {
  await writeFile(resolve(options.outputPath), output, "utf8");
  process.stdout.write(
    JSON.stringify(
      {
        format: report.format,
        outputPath: resolve(options.outputPath),
        cases: report.cases.map((entry) => ({
          id: entry.id,
          medianWallMs: entry.wallMs.median,
          p95WallMs: entry.wallMs.p95,
          medianCpuMs: entry.cpuMs.median,
          peakRssDeltaBytes: entry.memory.peakRssDeltaBytes,
          peakArrayBuffersDeltaBytes:
            entry.memory.peakArrayBuffersDeltaBytes
        }))
      },
      null,
      2
    ) + "\n"
  );
}

async function runCase(
  benchmarkCase,
  warmupIterations,
  measureIterations
) {
  const fixture = buildFixture(benchmarkCase);

  for (let index = 0; index < warmupIterations; index += 1) {
    await runIteration(fixture, false);
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

    const result = await runIteration(fixture, true);
    if (expectedDigest === undefined) {
      expectedDigest = result.resultDigest;
    } else if (result.resultDigest !== expectedDigest) {
      throw new Error(
        `non-deterministic result digest for ${benchmarkCase.id}`
      );
    }

    iterations.push(result);
    peakRssDeltaBytes = Math.max(
      peakRssDeltaBytes,
      result.memory.peakRssDeltaBytes
    );
    peakHeapUsedDeltaBytes = Math.max(
      peakHeapUsedDeltaBytes,
      result.memory.peakHeapUsedDeltaBytes
    );
    peakArrayBuffersDeltaBytes = Math.max(
      peakArrayBuffersDeltaBytes,
      result.memory.peakArrayBuffersDeltaBytes
    );
  }

  return {
    id: benchmarkCase.id,
    corpus: {
      fileCount: benchmarkCase.fileCount,
      bytesPerFile: benchmarkCase.bytesPerFile,
      directoryCount: benchmarkCase.directoryCount,
      executableEvery: benchmarkCase.executableEvery,
      payloadBytes: benchmarkCase.fileCount * benchmarkCase.bytesPerFile,
      expectedRequests: 2 + benchmarkCase.fileCount
    },
    wallMs: summarize(iterations.map((entry) => entry.wallMs)),
    cpuMs: summarize(iterations.map((entry) => entry.cpuMs)),
    transportCallbackMs: summarize(
      iterations.map((entry) => entry.transportCallbackMs)
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
      transportCallbackMs: entry.transportCallbackMs,
      requestCount: entry.requestCount,
      peakRssDeltaBytes: entry.memory.peakRssDeltaBytes,
      peakHeapUsedDeltaBytes: entry.memory.peakHeapUsedDeltaBytes,
      peakArrayBuffersDeltaBytes:
        entry.memory.peakArrayBuffersDeltaBytes
    }))
  };
}

async function runIteration(fixture, measureMemory) {
  const baseline = process.memoryUsage();
  let peak = baseline;
  let requestCount = 0;
  let transportNs = 0n;

  const sampleMemory = () => {
    if (!measureMemory) {
      return;
    }
    const current = process.memoryUsage();
    peak = {
      rss: Math.max(peak.rss, current.rss),
      heapTotal: Math.max(peak.heapTotal, current.heapTotal),
      heapUsed: Math.max(peak.heapUsed, current.heapUsed),
      external: Math.max(peak.external, current.external),
      arrayBuffers: Math.max(
        peak.arrayBuffers,
        current.arrayBuffers
      )
    };
  };

  const transport = async (request) => {
    const started = process.hrtime.bigint();
    requestCount += 1;
    if (requestCount === 1 || requestCount % 64 === 0) {
      sampleMemory();
    }

    let response;
    if (
      request.path.endsWith(
        "/git/commits/" + fixture.exactCommit
      )
    ) {
      response = {
        status: 200,
        body: {
          sha: fixture.exactCommit,
          tree: { sha: fixture.treeSha }
        }
      };
    } else if (
      request.path.endsWith(
        "/git/trees/" + fixture.treeSha
      )
    ) {
      response = {
        status: 200,
        body: {
          sha: fixture.treeSha,
          truncated: false,
          tree: fixture.tree
        }
      };
    } else {
      const sha = request.path.slice(
        request.path.lastIndexOf("/") + 1
      );
      const content = fixture.blobs.get(sha);
      if (content === undefined) {
        throw new Error(
          "benchmark transport received unknown object " + sha
        );
      }
      response = {
        status: 200,
        body: {
          sha,
          encoding: "base64",
          content
        }
      };
    }

    transportNs += process.hrtime.bigint() - started;
    return response;
  };

  const cpuStart = process.cpuUsage();
  const started = process.hrtime.bigint();
  const acquired = await acquireExactGitHubRepositorySnapshot({
    repository: REPOSITORY.value,
    exactCommit: fixture.exactCommit,
    transport
  });
  const elapsedNs = process.hrtime.bigint() - started;
  const cpu = process.cpuUsage(cpuStart);
  sampleMemory();

  if (!acquired.ok) {
    throw new Error(
      `benchmark acquisition failed: ${JSON.stringify(acquired.error)}`
    );
  }
  if (acquired.value.entries.length !== fixture.fileCount) {
    throw new Error(
      `benchmark acquisition returned ${acquired.value.entries.length} entries; expected ${fixture.fileCount}`
    );
  }
  if (requestCount !== 2 + fixture.fileCount) {
    throw new Error(
      `benchmark transport saw ${requestCount} requests; expected ${2 + fixture.fileCount}`
    );
  }

  return {
    wallMs: nsToMs(elapsedNs),
    cpuMs: (cpu.user + cpu.system) / 1000,
    transportCallbackMs: nsToMs(transportNs),
    requestCount,
    resultDigest: snapshotDigest(acquired.value.entries),
    memory: {
      peakRssDeltaBytes: Math.max(0, peak.rss - baseline.rss),
      peakHeapUsedDeltaBytes: Math.max(
        0,
        peak.heapUsed - baseline.heapUsed
      ),
      peakArrayBuffersDeltaBytes: Math.max(
        0,
        peak.arrayBuffers - baseline.arrayBuffers
      )
    }
  };
}

function buildFixture(benchmarkCase) {
  const exactCommit = hex40(
    `commit\0${benchmarkCase.id}`
  );
  const treeSha = hex40(
    `tree\0${benchmarkCase.id}`
  );
  const blobs = new Map();
  const tree = [];
  const directoryNames = [];

  for (
    let directory = 0;
    directory < benchmarkCase.directoryCount;
    directory += 1
  ) {
    const path = `group-${pad(directory, 4)}`;
    directoryNames.push(path);
    tree.push({
      path,
      mode: "040000",
      type: "tree",
      sha: hex40(
        `directory\0${benchmarkCase.id}\0${directory}`
      )
    });
  }

  for (let index = 0; index < benchmarkCase.fileCount; index += 1) {
    const directory =
      directoryNames[index % directoryNames.length] ??
      "group-0000";
    const path =
      `${directory}/file-${pad(index, 6)}.bin`;
    const sha = hex40(
      `blob\0${benchmarkCase.id}\0${index}`
    );
    const bytes = deterministicBytes(
      benchmarkCase.id,
      index,
      benchmarkCase.bytesPerFile
    );
    blobs.set(sha, bytes.toString("base64"));
    tree.push({
      path,
      mode:
        benchmarkCase.executableEvery > 0 &&
        index % benchmarkCase.executableEvery === 0
          ? "100755"
          : "100644",
      type: "blob",
      sha
    });
  }

  tree.reverse();

  return {
    exactCommit,
    treeSha,
    tree,
    blobs,
    fileCount: benchmarkCase.fileCount
  };
}

function deterministicBytes(caseId, index, length) {
  const seed = createHash("sha256")
    .update(caseId)
    .update("\0")
    .update(String(index))
    .digest();
  const output = Buffer.allocUnsafe(length);
  for (let offset = 0; offset < length; offset += 1) {
    output[offset] = seed[offset % seed.length] ^ (offset & 0xff);
  }
  return output;
}

function snapshotDigest(entries) {
  const hash = createHash("sha256");
  hash.update("SKILOOM-GITHUB-SOURCE-BENCH-RESULT\0");
  for (const entry of entries) {
    hash.update(Buffer.from(entry.pathBytes));
    hash.update("\0");
    hash.update(entry.fileType);
    hash.update("\0");
    if (entry.fileType === "regular") {
      hash.update(entry.gitMode);
      hash.update("\0");
      hash.update(Buffer.from(entry.content));
    }
    hash.update("\0");
  }
  return "sha256:" + hash.digest("hex");
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

function hex40(value) {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 40);
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
      result.warmupIterations = parseNonNegativeInteger(
        requiredValue(args, ++index, argument),
        argument
      );
    } else if (argument === "--iterations") {
      result.measureIterations = parsePositiveInteger(
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

function parseNonNegativeInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(option + " must be a non-negative integer");
  }
  return parsed;
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(option + " must be a positive integer");
  }
  return parsed;
}

function validateCorpus(corpus) {
  if (
    corpus?.format !== "SKILOOM-GITHUB-SOURCE-BENCH-V1" ||
    corpus.fixtureVersion !== 1 ||
    !Number.isSafeInteger(corpus.warmupIterations) ||
    corpus.warmupIterations < 0 ||
    !Number.isSafeInteger(corpus.measureIterations) ||
    corpus.measureIterations < 1 ||
    !Array.isArray(corpus.cases) ||
    corpus.cases.length === 0
  ) {
    throw new Error("invalid GitHub source benchmark corpus");
  }

  const ids = new Set();
  for (const benchmarkCase of corpus.cases) {
    if (
      typeof benchmarkCase?.id !== "string" ||
      benchmarkCase.id.length === 0 ||
      ids.has(benchmarkCase.id) ||
      !positiveInteger(benchmarkCase.fileCount) ||
      !positiveInteger(benchmarkCase.bytesPerFile) ||
      !positiveInteger(benchmarkCase.directoryCount) ||
      !Number.isSafeInteger(benchmarkCase.executableEvery) ||
      benchmarkCase.executableEvery < 0
    ) {
      throw new Error("invalid GitHub source benchmark case");
    }
    ids.add(benchmarkCase.id);
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
