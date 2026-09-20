---
name: skiloom-manage
description: Map Skiloom management intent to the public CLI while preserving candidate approval, source authorization, locking, ownership, and exact-state maintenance boundaries.
---

# Skiloom Manage

Use only the public Skiloom CLI/runtime for state-changing or maintenance operations. Prefer `--json` so Agent workflows consume the `SKILOOM-CLI-V1` envelope. Do not parse human terminal output when structured JSON is available.

## Candidate operations

Use these public commands for complete candidate operations:

```text
skiloom install <coordinate> --plan --json
skiloom update --plan --json
skiloom remove <coordinate> --plan --json
skiloom recover --plan --json
skiloom fork --plan --json
skiloom import <file> --plan --json
skiloom bootstrap --plan --json
```

For non-interactive commit, use the matching public command with explicit approval:

```text
skiloom install <coordinate> --yes --json
skiloom update --yes --json
skiloom remove <coordinate> --yes --json
skiloom recover --yes --json
skiloom fork --yes --json
skiloom import <file> --yes --json
skiloom bootstrap --yes --json
```

`--json` never implies `--yes`.

Release-tag retarget authorization is independent from ordinary approval. `--yes` does not authorize Release retarget; when the user has explicitly authorized that risk, use:

```text
skiloom update --yes --allow-release-retarget --json
```

Import merge is also a separate explicit boundary. `--yes` does not authorize merge; when the user explicitly chose merge, use:

```text
skiloom import <file> --merge --yes --json
```

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
skiloom observe <package> <name> --status <status> --json
skiloom observe <package> <name> --clear --json
```

These commands are the user's explicit local authorization and must not gain an extra hidden write path. `observe` records only machine-local `special` dependency observations for an already accepted Package; it never writes Skiloom-owned `software` observations, does not modify Target bytes, and does not advance Target Generation. It is not a Candidate operation, so do not add `--plan` or `--yes`.

## Transfer

Use:

```text
skiloom export <file> --json
skiloom export <file> --full --json
skiloom import <file> --plan --json
```

Never overwrite conflicts, invent auto-renames, or introduce a `--force` bypass.

## Bootstrap

Bootstrap is a normal candidate operation for one Target per invocation. Use the same Target selector rules as every other management command.

```text
skiloom bootstrap --plan --json
skiloom bootstrap --yes --json
```

Installing the Skiloom npm program never modifies a Skill Target by itself. Bootstrap must be an explicit public CLI action and first-party Packages have no privileged Target or installation path.

## Safety boundary

Never write `registry.sqlite3`, Package Store entries, `.skiloom-state`, or Target files directly. Never bypass `operation.lock`, resolver/source authorization, digest verification, ownership preflight, DB-first state mutation, or recovery semantics. Surface structured CLI errors to the user instead of repairing around them.
