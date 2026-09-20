---
name: skiloom-discover
description: Discover and explain installable Skiloom Skill candidates using Catalog and GitHub information without treating Catalog metadata as source authority or modifying a Target.
---

# Skiloom Discover

Use this Skill for discovery and candidate explanation only.

## Discover candidates

Prefer the structured search surface:

```text
skiloom search "<query>" --json
```

The response uses the `SKILOOM-CLI-V1` envelope. Use structured provider provenance and candidate fields rather than parsing human output.

Catalog signals such as popularity, score, audit results, or provider metadata are discovery evidence only. They do not define the install version, commit, snapshot, digest, or accepted source.

When a user chooses a candidate, reduce it to an explicit GitHub repository or Package coordinate and hand installation intent to `skiloom-manage`. GitHub remains the v0 source authority used by the normal resolver/runtime path.

## Boundaries

- Do not install, update, remove, sync, repair, or modify a Target.
- Do not write Registry, Store, marker, cache authority, or Target files.
- Do not convert Catalog version/hash/download fields into accepted source facts.
- Do not silently choose between GitHub Release and explicit Git source.
- Do not hide provider failures; report structured errors or warnings and let explicit GitHub operations remain independent of Catalog availability.

Use `--json` for Agent execution, but remember that `--json` is not `--yes` and grants no state-change approval.
