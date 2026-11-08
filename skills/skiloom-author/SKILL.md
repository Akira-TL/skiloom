---
name: skiloom-author
description: 创建、修改与按需校验标准 Agent Skill 文件；定制已安装技能时先由 skiloom-manage 准备正确作用范围内、已解除管理的副本，再编辑其内容。
---

# Skiloom Author

Use this Skill for standard Skill authoring and static validation.

## 修改现有技能

先区分用户要求修改的是上游源码、新建技能，还是已安装技能的本地副本。已安装技能的定制先交给 `skiloom-manage` 的“定制已安装技能”流程，取得包坐标、目标目录、可编辑路径与已解除管理的状态后，再直接修改副本内所需的 `SKILL.md`、引用文件或脚本。沿用该流程确定的作用范围，不自行扩大到用户级总入口或上游源码。

项目的提交格式、验证和交接等私有约定按项目规范及用户指定位置保存；用户要求修改技能行为时，也要完成相应副本中的修改。用户明确要求只修改、不运行技能校验或测试时，遵从该限制，不自行增加校验、测试或发布步骤。

## Standard files

Help create or review:

- `SKILL.md` for the Agent Skill name, description, and instructions.
- `skiloom-package.toml` for optional Package dependencies and software metadata.
- `skiloom-repo.toml` for repository discovery control.
- `DEPENDENCIES.md` for human-readable dependency guidance where useful.

需要静态校验且用户未排除该步骤时，通过公开命令校验本地包或仓库：

```text
skiloom validate <path> --json
```

Use the `SKILOOM-CLI-V1` envelope. Do not parse human terminal output when structured JSON is available.

## Authoring boundaries

A Skill Package has no first-party privilege. Do not create private Registry records, Store entries, hidden source metadata, install hooks, postinstall Target mutation, or special publishing protocols.

编写时不得写入 `registry.sqlite3`、包存储、`.skiloom-state` 或目标目录内仍受管理的内容。已通过公开 `detach` 解除管理的用户副本可按授权直接编辑。安装与所有权变更交给 `skiloom-manage`，通过正常的来源解析、授权、锁定、包存储核验、所有权检查与目标目录规则完成。

`--json` only selects structured output; it does not approve any later state-changing command.
