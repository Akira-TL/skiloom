# ADR 0008：项目 Skill 直接扁平激活到 `.agents/skills`

- 状态：Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：固定项目 `.agents/skills`、项目私有状态目录和 `activation.lock` 模型已退役；平铺 Target、冲突保护与 rename 的现行规则见 `docs/design/skiloom-v0-product-contract.md`。

## 背景

早期设计让 Skiloom 在项目内维护 `.akm/skills/<owner>/<repo>/<package>` 分层库，再交给 executor adapter 做最终 Skill discovery。该模型增加了一层 Skiloom 私有安装视图，而且与项目中 Agent 实际发现 Skill 的标准位置脱节。

项目真正需要的是：Agent 直接从 `.agents/skills/` 发现已安装 Skill；Skiloom 自己的解析、Lock、依赖检查与激活状态应隐藏在 `.agents/.skiloom/`，两者职责分离。

扁平目录同时意味着不同 source 的同名 Skill 会发生真实 activation name 冲突。

## 决定

项目目录固定为：

```text
<project>/.agents/
├── skills/                 # executor-visible，扁平 Skill 激活目录
└── .skiloom/               # Skiloom 私有项目状态
    ├── skiloom.toml
    ├── skiloom.lock
    ├── activation.lock
    └── dependencies.lock
```

规则：

- Skiloom-managed Skill 直接激活到 `.agents/skills/<activation-name>`；
- 默认 `activation-name = SKILL.md.name`；
- `.agents/.skiloom/` 只保存 Skiloom 项目配置、解析状态、激活记录与宿主依赖观察，不作为 executor Skill discovery 目录；
- 不再建立 `.akm/skills/<owner>/<repo>/<package>` 分层 Project Skill Library；
- Package Store 继续保持机器级、content-addressed、immutable；source coordinate 与 Store identity 不因扁平激活改变。

## 同名冲突

在任何写入前，Skiloom 对完整 Install Plan 做 activation-name preflight。

如果 `.agents/skills/<name>` 已被另一个 resolved Package 或用户/其他工具已有内容占用，Skiloom 不自动覆盖、不自动改名，返回 `ActivationNameConflict` 并要求用户选择：

1. 为新安装项指定新的 activation name；或
2. 放弃本次安装/同步操作。

非交互模式直接失败，除非用户已经在项目配置中明确保存 rename。

用户选择 rename 后，Skiloom 把该选择写入 `.agents/.skiloom/skiloom.toml` 的 `[renames]`，使项目在其他机器上使用同一 activation name。

例如：

```toml
[renames]
"someone/other-repo/ask-matt" = "ask-matt-other"
```

activation name 必须满足 Agent Skill `name` 的合法命名规则，并且在 `.agents/skills/` 中唯一。

## Rename 的语义

Rename 是项目本地 Skill identity 改名，不能只改目录名。

对于未 rename 的 Package，Skiloom 可以让 `.agents/skills/<name>` 直接链接 immutable Package Store entry。

对于 rename 的 Package，Skiloom 从 immutable Store materialize 一个项目激活视图到 `.agents/skills/<new-name>`，至少把顶层 `SKILL.md` frontmatter `name` 同步改为 `<new-name>`，从而保持：

```text
basename(Skill Root) == SKILL.md.name
```

原始 Package Store entry 与 `content-digest` 永不修改；rename 只影响当前项目的 activation view。

由于 Skill 正文可能自然语言引用原 Skill name，Skiloom 在用户选择 rename 时必须提示：rename 会改变 runtime Skill identity，手写路由/引用可能需要作者或用户确认。Skiloom 不自动重写任意自然语言引用。

## Activation state

`.agents/.skiloom/activation.lock` 保存 Skiloom 当前管理的扁平激活项，用于安全 update/remove/doctor；它不是 Package resolution Lock，也不改变 Package provenance。字段、平台 materialization、drift recovery 与 Store GC 边界由 ADR 0009 进一步固定。

Skiloom 不接管 `.agents/skills/` 中未在 activation state 中声明的既有目录/链接。遇到这些路径一律按冲突处理，禁止静默覆盖或删除。

## 结果

- Agent 直接发现 `.agents/skills/`，不需要 Skiloom 私有分层库或 executor adapter 才能看到 Skill；
- Skiloom 状态集中于 `.agents/.skiloom/`，与 executor-visible Skill 内容分开；
- 扁平同名冲突成为显式用户决策；
- Package Store 仍按原始 immutable Package Snapshot 去重；
- rename 不污染 source Package，只创建项目本地 activation identity。
