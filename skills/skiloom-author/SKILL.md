---
name: skiloom-author
description: Help create and validate standard Agent Skill package files for Skiloom without introducing special publishing, installation, Registry, or lifecycle privileges.
---

# Skiloom Author

Use this Skill for standard Skill authoring and static validation.

## Standard files

Help create or review:

- `SKILL.md` for the Agent Skill name, description, and instructions.
- `skiloom-package.toml` for optional Package dependencies and software metadata.
- `skiloom-repo.toml` for repository discovery control.
- `DEPENDENCIES.md` for human-readable dependency guidance where useful.

Validate local package/repository content through the public CLI:

```text
skiloom validate <path> --json
```

Use the `SKILOOM-CLI-V1` envelope rather than parsing human output.

## Authoring boundaries

A Skill Package has no first-party privilege. Do not create private Registry records, Store entries, hidden source metadata, install hooks, postinstall Target mutation, or special publishing protocols.

Do not write `registry.sqlite3`, Package Store data, `.skiloom-state`, or a user's Target as part of authoring. Installation and lifecycle actions belong to `skiloom-manage` and must go through normal source resolution, approval, locking, Store, ownership, and Target rules.

`--json` only selects structured output; it does not approve any later state-changing command.
