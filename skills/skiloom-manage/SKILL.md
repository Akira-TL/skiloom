---
name: skiloom-manage
description: Map Skiloom management intent to the public CLI while preserving candidate approval, source authorization, locking, ownership, and exact-state maintenance boundaries.
---

# Skiloom Manage

Use only the public Skiloom CLI/runtime for state-changing or maintenance operations. Prefer `--json` so Agent workflows consume the `SKILOOM-CLI-V1` envelope.

## Candidate operations

Use these public commands for complete candidate operations:

```text
skiloom install <coordinate> --plan --json
skiloom update --plan --json
skiloom remove <coordinate> --plan --json
skiloom recover --plan --json
skiloom fork --plan --json
skiloom import <file> --plan --json
```

For non-interactive commit, add the explicit approval required by the CLI, normally `--yes`. `--json` never implies `--yes`.

Release-tag retarget authorization is independent from ordinary approval. Do not imply that `--yes` authorizes a retarget. Import merge is also a separate explicit boundary and must use the public `--merge` behavior.

## Exact-state maintenance

Use:

```text
skiloom sync --json
skiloom repair --json
```

These replay or repair the currently accepted exact state and do not create a new resolution candidate.

## Explicit local operations

Use:

```text
skiloom rename <package> <activation-name> --json
skiloom detach <package> --json
skiloom rebind <package> <activation-name> --json
skiloom forget <package> --json
```

These commands are the user's explicit local authorization and must not gain an extra hidden write path.

## Transfer

Use:

```text
skiloom export <file> --json
skiloom export <file> --full --json
skiloom import <file> --plan --json
```

Never overwrite conflicts, invent auto-renames, or introduce a `--force` bypass.

## Safety boundary

Never write `registry.sqlite3`, Package Store entries, `.skiloom-state`, or Target files directly. Never bypass `operation.lock`, resolver/source authorization, digest verification, ownership preflight, DB-first state mutation, or recovery semantics. Surface structured CLI errors to the user instead of repairing around them.
