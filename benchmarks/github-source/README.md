# GitHub Source Node Baseline Benchmark

This benchmark is the N03 admission gate for Skiloom's Git tree/object acquisition path.

It is intentionally **separate from correctness tests**. Product behavior remains defined by the existing behavior fixtures and GitHub source integration tests. This benchmark measures only the already-correct Node/TypeScript exact-snapshot acquisition path.

## Corpus

`corpus-v1.json` is the versioned deterministic corpus:

| Case | Shape | Payload | Synthetic exact-source requests | Stress target |
| --- | ---: | ---: | ---: | --- |
| `small-32x1k` | 32 files × 1 KiB | 32 KiB | 34 | ordinary small repository |
| `wide-4096x512` | 4096 files × 512 B | 2 MiB | 4098 | Git object/tree count |
| `payload-256x64k` | 256 files × 64 KiB | 16 MiB | 258 | base64 decode / payload memory |

The fixture generator derives exact commits, tree IDs, blob IDs, paths, executable modes, and file bytes deterministically from the case ID. The runner verifies a stable result digest across measured iterations.

## Method

Run:

```bash
npm run benchmark:github-source
```

To write a machine-readable result:

```bash
npm run benchmark:github-source -- --output benchmarks/github-source/my-baseline.json
```

The script builds the current TypeScript implementation, then runs with `--expose-gc`. Each case performs one warmup and five measured iterations by default.

The benchmark deliberately excludes real network timing. The synthetic transport supplies already-parsed GitHub JSON facts to the production `acquireExactGitHubRepositorySnapshot` implementation. This isolates the compute work a native Git tree/object helper could plausibly replace: tree validation, deterministic ordering, exact blob decoding, executable-mode preservation, snapshot assembly, and allocation.

Reported metrics include wall time, process CPU time, synthetic transport callback time, peak RSS/heap/ArrayBuffer deltas, request cardinality, and a deterministic output digest.

## 2026-09-18 baselines

Machine used for the checked-in baselines:

- Linux x64 under WSL2
- AMD Ryzen 9 9950X
- 32 logical CPUs
- Node 24.16.0 and Node 22.23.2

These numbers are **admission evidence, not universal performance promises**.

| Case | Node 24 median wall | Node 24 p95 | Node 22 median wall | Node 22 p95 |
| --- | ---: | ---: | ---: | ---: |
| `small-32x1k` | 0.713 ms | 0.962 ms | 0.602 ms | 0.810 ms |
| `wide-4096x512` | 36.499 ms | 41.740 ms | 35.483 ms | 36.815 ms |
| `payload-256x64k` | 53.955 ms | 55.829 ms | 49.609 ms | 53.704 ms |

Node 24 memory observations:

- `wide-4096x512`: peak RSS delta ~9.7 MiB, heap delta ~16.1 MiB, ArrayBuffer delta ~2.0 MiB.
- `payload-256x64k`: heap delta ~31.8 MiB and ArrayBuffer delta ~26.5 MiB for a 16 MiB payload. RSS sampling did not observe a new high-water mark above the already-resident process baseline in that case, so the ArrayBuffer/heap deltas are the more useful measurements.

Checked-in raw results:

- `baseline-node24-linux-x64.json`
- `baseline-node22-linux-x64.json`

## Admission decision

**Do not create a native Git tree/object helper for 0.5.x from this evidence.**

The Node compute path is not the material bottleneck in this corpus. Even the 4096-object case finishes the local exact-snapshot computation in roughly 35–42 ms p95, while its current source shape implies **4098 GitHub API requests** if exercised literally over the live transport. The 16 MiB payload case is about 50–56 ms. A standalone native process could only reduce part of those tens of milliseconds while adding IPC, binary distribution, cancellation, compatibility, and fallback complexity.

The actionable bottleneck is therefore transport/request cardinality for wide repositories, not tree/blob CPU. Under the project architecture, a compute helper is not allowed to own GitHub networking or credentials, so a native rewrite would not solve that dominant cost.

If future live profiling shows source acquisition is too slow, the next investigation should first reduce or batch Node-owned transport work while preserving the same exact-commit and content-validation semantics, then rerun this corpus. N03 should only be reconsidered if the post-transport Node compute path itself becomes materially expensive.

If later evidence does justify a native implementation, the required boundary remains:

1. Node retains GitHub/network/credentials, user cancellation, source authorization, and structured product policy.
2. Native code is a standalone process consuming only exact deterministic tree/object facts through a versioned IPC schema.
3. The current Node implementation remains the fallback.
4. Native and Node paths must produce identical repository snapshot facts/errors on the same versioned corpus and the existing behavior fixtures.
5. Cancellation/timeout must terminate the helper through the Node-owned process boundary without silently restarting work.

No Rust or other native Git implementation is introduced by this benchmark ticket.
