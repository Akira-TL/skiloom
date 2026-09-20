---
name: skiloom
description: Route Skiloom discovery, management, diagnosis, and Skill authoring requests to the appropriate first-party specialist while keeping all product actions on the public Skiloom CLI.
---

# Skiloom Router

Use this Skill as the Agent-facing router for Skiloom tasks. Do not implement resolver, source, Registry, Store, Target, ownership, or acceptance rules here.

## Route by intent

- Finding, comparing, or interpreting Skill candidates: use `skiloom-discover`.
- Installing, updating, removing, renaming, synchronizing, repairing, recovering, forking, detaching, rebinding, forgetting, exporting, or importing: use `skiloom-manage`.
- Inspecting Registry, Store, Target, marker, ownership drift, or dependency observations: use `skiloom-doctor`.
- Creating or validating Agent Skill package files: use `skiloom-author`.

## Execution boundary

For reliable Agent execution, prefer the machine interface:

```text
skiloom <command> ... --json
```

Treat `SKILOOM-CLI-V1` as the structured response envelope. Inspect `ok`, `result` or `error`, and `warnings`; do not parse human terminal formatting when JSON is available.

`--json` disables prompts but does not grant approval. State-changing candidate operations still require the explicit approval flags defined by the public CLI.

Never write `registry.sqlite3`, the Package Store, `.skiloom-state`, or Target contents directly. Never bypass source authorization, the operation lock, resolver, Store verification, ownership checks, or Target reconciliation.

First-party Skills have no privileged installation path. If a requested task can be completed directly with the public CLI, use the specialist guidance and the same CLI/runtime path available to every ordinary Package.
