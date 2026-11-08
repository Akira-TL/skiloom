---
name: skiloom
description: 将 Skiloom 发现、管理、诊断与技能编写请求交给对应技能；修改已安装技能或按项目定制时，先交给 skiloom-manage 确定包、作用范围与内容所有权，再交给 skiloom-author 编辑。
---

# Skiloom Router

Use this Skill as the Agent-facing router for Skiloom tasks. Do not implement resolver, source, Registry, Store, Target, ownership, or acceptance rules here.

## Route by intent

- Finding, comparing, or interpreting Skill candidates: use `skiloom-discover`.
- Installing, updating, removing, renaming, synchronizing, repairing, recovering, forking, detaching, rebinding, forgetting, recording special dependency observations, exporting, importing, or bootstrapping a selected Target: use `skiloom-manage`.
- Inspecting Registry, Store, Target, marker, ownership drift, or dependency observations: use `skiloom-doctor`.
- Creating or validating Agent Skill package files: use `skiloom-author`.
- 修改已安装技能、调整技能内脚本或按项目规范定制：先使用 `skiloom-manage` 的“定制已安装技能”流程，取得可编辑的本地副本，再交给 `skiloom-author`。上游源码开发只有在用户要求修改上游时才进入。

## Routing examples

- "Find a Skill for this task" -> use `skiloom-discover`.
- "Install or update a Skill" -> use `skiloom-manage`.
- "Diagnose a Target problem" -> use `skiloom-doctor`.
- "Record the result of a DEPENDENCIES.md check" -> use `skiloom-manage`.
- "Author a Skill package" -> use `skiloom-author`.
- "Bootstrap Skiloom into this Target" -> use `skiloom-manage`.

These examples select a specialist only. The specialist must still use the public CLI and must not duplicate resolver, acceptance, ownership, or lifecycle decisions.

## Execution boundary

For reliable Agent execution, prefer the machine interface:

```text
skiloom <command> ... --json
```

Treat `SKILOOM-CLI-V1` as the structured response envelope. Inspect `ok`, `result` or `error`, and `warnings`; do not parse human terminal formatting when JSON is available.

`--json` disables prompts but does not grant approval. State-changing candidate operations still require the explicit approval flags defined by the public CLI.

不得直接写入 `registry.sqlite3`、包存储（Package Store）、`.skiloom-state` 或目标目录内仍受管理的内容。经公开 `detach` 成功转换为用户维护的本地副本后，可按用户要求直接编辑该副本。来源授权、操作锁、解析、摘要核验、所有权检查与目标目录同步仍由公开命令负责。

First-party Skills have no privileged installation path. If a requested task can be completed directly with the public CLI, use the specialist guidance and the same CLI/runtime path available to every ordinary Package.
