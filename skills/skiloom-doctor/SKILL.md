---
name: skiloom-doctor
description: Perform read-only Skiloom diagnostics for Registry, Store, Target, recovery marker, projection ownership, and dependency observations, then recommend public repair commands without executing hidden fixes.
---

# Skiloom Doctor

Use the public read-only diagnostic surface:

```text
skiloom doctor --json
```

Consume the `SKILOOM-CLI-V1` result and warnings as structured data. Do not parse human terminal formatting when JSON is available.

Inspect and explain findings involving:

- Machine Registry integrity and accepted Target state.
- Referenced immutable Package Store entries.
- Managed projection or ownership drift.
- Detached binding presence without adopting user-owned bytes.
- `.skiloom-state` recovery status.
- Accepted dependency observations.
- Foreign content that Skiloom must not adopt.

## Recommendations only

Doctor is read-only. When a finding needs state change, recommend the appropriate public management command, such as:

```text
skiloom sync --json
skiloom repair --json
skiloom recover --plan --json
skiloom rebind <package> <activation-name> --json
```

Never perform repairs, syncs, recovery, rebinding, deletion, or overwrite operations automatically.

Never write Registry, Store, marker, or Target state directly. Never reinterpret foreign or detached user-owned bytes as managed content. State-changing follow-up belongs to `skiloom-manage` and the normal lock/ownership/acceptance path.

`--json` is a machine-output mode, not state-change approval.
