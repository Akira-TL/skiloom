# Exact Export Node Baseline Benchmark

This benchmark is the N05 admission gate for `SKILOOM-EXPORT-V1` framing, managed/user payload digest verification, and exact package parse/write compute.

It is intentionally separate from correctness fixtures. Public format bytes and behavior remain owned by the accepted export/user-payload specifications and their normal tests. The benchmark calls the production TypeScript codec/digest implementation but excludes disk, Registry, Target reconciliation, GitHub/network, source policy, credentials, and user interaction.

## Corpus

`corpus-v1.json` is a deterministic versioned corpus:

| Case | Managed payload | User payload | Frames | Stress target |
| --- | ---: | ---: | ---: | --- |
| `small-managed-64x1k` | 64 × 1 KiB | none | 64 | ordinary small export |
| `wide-managed-4096x512` | 4096 × 512 B | none | 4096 | framing / high file count |
| `large-managed-128x256k` | 128 × 256 KiB | none | 128 | 32 MiB whole-buffer pressure |
| `mixed-256x32k-plus-256x32k` | 256 × 32 KiB | 256 × 32 KiB | 512 | 16 MiB mixed managed/user payload |

Fixture bytes are derived deterministically from case ID + file index. Managed payload identity is produced by the production `SKILOOM-PACKAGE-V1` implementation; user payload identity is produced by `SKILOOM-USER-PAYLOAD-V1`. The benchmark then constructs one valid `SKILOOM-EXPORT-V1` logical package and verifies that every measured iteration returns the same canonical result digest.

## Method

Run:

```bash
npm run benchmark:exact-export
```

Write a machine-readable baseline:

```bash
npm run benchmark:exact-export -- --output benchmarks/exact-export/my-baseline.json
```

The default corpus runs one warmup and three measured iterations for each operation:

- `write-verify`: production canonical manifest/framing writer plus the writer's built-in full parse/digest verification before returning bytes.
- `parse-verify`: production container parse, strict manifest validation, managed Package digest verification, and user payload digest verification.

The runner reports wall time, process CPU time, payload MiB/s, container bytes, frame count, process max-RSS high-water change, heap-used change, ArrayBuffer change observed while the returned result remains live, and deterministic result digests.

Memory figures are **admission evidence, not exact allocator accounting**. Operations are synchronous, so the runner cannot sample internal allocation on every frame without instrumenting product code. `maxRSS` captures process high-water growth; ArrayBuffer/heap deltas are measured immediately after the operation while returned bytes/frames are still reachable. Short-lived intermediate allocations may therefore be under- or over-represented between Node versions. Large-case trends are the relevant signal.

## 2026-09-19 baselines

Machine:

- Linux x64 under WSL2
- AMD Ryzen 9 9950X
- 32 logical CPUs
- Node 24.16.0 and Node 22.23.2

Checked-in raw results:

- `baseline-node24-linux-x64.json`
- `baseline-node22-linux-x64.json`

Node 22 and Node 24 produce identical container digests, write result digests, and parsed semantic digests for every corpus case.

### Median wall time

| Case | Node 24 write | Node 24 parse | Node 22 write | Node 22 parse |
| --- | ---: | ---: | ---: | ---: |
| small managed | 4.778 ms | 4.283 ms | 4.654 ms | 2.501 ms |
| wide managed | 163.975 ms | 130.286 ms | 149.388 ms | 129.919 ms |
| large managed, 32 MiB | 136.204 ms | 99.548 ms | 154.354 ms | 115.279 ms |
| mixed, 16 MiB | 83.610 ms | 62.977 ms | 79.826 ms | 58.299 ms |

Large-payload median throughput is roughly 207–245 MiB/s for write/verify and 278–321 MiB/s for parse/verify across supported Node lines. The 4096-frame case is slower per byte because validation/framing work is file-count dominated, but remains around 130–164 ms wall time.

### Allocation signal

The most important finding is whole-buffer allocation amplification rather than CPU throughput:

- Node 24, 32 MiB managed write: ~235 MiB observed ArrayBuffer increase, about **7.0× payload**; parse: ~79 MiB, about **2.35×**.
- Node 22, 32 MiB managed write: ~168 MiB observed ArrayBuffer increase, about **5.0× payload**; parse: ~68 MiB, about **2.0×**.
- Node 24, 16 MiB mixed managed/user write: ~118 MiB observed ArrayBuffer increase, about **7.0× payload**.

Smaller cases have noisier ratios because fixed parser/framing allocations dominate and allocator reuse differs between Node versions. The 32 MiB case consistently shows the large-payload behavior on both supported versions.

## Admission decision

**Do not create an N05 native export/archive helper from this evidence.**

The current TypeScript codec is not CPU-bound enough to justify a standalone native process. Large payloads are encoded/verified or parsed/verified in roughly 0.1–0.2 seconds on this baseline machine, at hundreds of MiB/s. A native helper would add IPC, binary distribution, cancellation, compatibility, exact-format parity, and fallback complexity while not addressing the dominant design issue identified here.

**Node streaming/API hardening is justified before claiming memory-efficient large-export support.** The current writer deliberately constructs complete frame parts and `Buffer.concat`s one whole container, while the parser materializes complete frame contents. The 32 MiB corpus shows approximately 5–7× observed ArrayBuffer amplification on write across Node 22/24. This can be addressed inside the Node-owned implementation without changing `SKILOOM-EXPORT-V1` bytes or delegating filesystem authorization/policy to native code.

Recommended future hardening order:

1. add an incremental Node writer that emits the already-fixed V1 magic/manifest/frame stream to a sink while computing/verifying digests without assembling a second whole-container buffer;
2. add bounded/incremental parse input so large frame bodies need not be duplicated solely for framing;
3. preserve the existing in-memory codec as the small-payload/reference path or test oracle;
4. rerun this exact corpus and correctness byte-parity suite;
5. reconsider N05 only if the post-streaming Node compute path itself remains a demonstrated bottleneck.

This memory-hardening recommendation does **not** change the public V1 format and is not required to create a native helper ticket. No Rust/native export helper is introduced by this benchmark ticket.

If a future benchmark does justify N05, the mandatory boundary remains: Node owns paths, operation lock/cancellation, source acceptance, credentials/policy and final filesystem authorization; the helper is a standalone process over a versioned IPC contract; TypeScript remains a fallback; and TS/native output must be byte-identical on this corpus plus normal correctness fixtures.
