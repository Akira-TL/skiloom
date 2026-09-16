# Project Skill Activation v0

状态：Superseded

当前说明：固定项目 `.agents/skills`、项目私有状态目录和 `activation.lock` 模型已退役。当前权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md) 与 ADR 0018。

对应历史 ADR：[`0008-flat-agent-skill-activation.md`](../adr/0008-flat-agent-skill-activation.md)

## 1. 项目目录

```text
<project>/.agents/
├── skills/
│   ├── ask-matt/
│   ├── browser-access/
│   └── ask-matt-other/
└── .skiloom/
    ├── skiloom.toml
    ├── skiloom.lock
    ├── activation.lock
    └── dependencies.lock
```

`.agents/skills/` 是 executor-visible 的扁平 Skill 安装面；`.agents/.skiloom/` 是 Skiloom 私有项目状态目录。

## 2. 默认激活名

每个 resolved Package 的默认 activation name：

```text
activation-name = SKILL.md.name
```

因此未发生冲突时：

```text
owner-a/repo-a/foo -> .agents/skills/foo
```

source coordinate 不进入 executor-visible 目录层级。

## 3. Preflight 冲突检查

Skiloom 在任何项目写入前先构造完整 activation plan，并检查：

1. planned Package 之间是否产生相同 activation name；
2. `.agents/skills/<name>` 是否已存在；
3. 已存在项是否由当前 `.agents/.skiloom/activation.lock` 声明为同一个 Skiloom-managed activation；
4. rename 后的新名字是否仍然冲突。

如果目标名字被其他 Package 或未知既有内容占用，返回：

```text
ActivationNameConflict
```

交互模式提示用户：

```text
冲突：.agents/skills/ask-matt 已被占用

新 Package: someone/other-repo/ask-matt

选择：
1. 重命名新 Skill
2. 放弃本次操作
```

Skiloom 不提供“自动覆盖”作为冲突选项。

非交互模式没有预先保存的 rename 时直接失败。

## 4. Rename 配置

用户确认 rename 后写入 portable 项目配置：

```toml
# .agents/.skiloom/skiloom.toml

[renames]
"someone/other-repo/ask-matt" = "ask-matt-other"
```

`[renames]` 的 key 必须是 resolved Package coordinate；value 是项目内 activation name。

规则：

- activation name 必须符合标准 Skill name grammar；
- activation name 在 `.agents/skills/` 中必须唯一；
- rename 可以针对顶层 Package，也可以针对 transitive Package；
- rename 不改变 Package coordinate、source resolution、dependency graph 或 Store `content-digest`。

## 5. Rename materialization

标准 Agent Skill 要求目录 basename 与 `SKILL.md.name` 一致。因此：

```text
.agents/skills/foo-other/
└── SKILL.md  name: foo
```

是不合法的。

rename 后 Skiloom 创建项目本地 managed activation view：

```text
.agents/skills/foo-other/
└── SKILL.md  name: foo-other
```

该 view 从原始 immutable Package Store entry 派生；至少只改写顶层 `SKILL.md` frontmatter 的 `name`。原始 Package Snapshot 与 `content-digest` 不变化。

Skiloom 不自动重写 Skill 正文、scripts、references 中对旧名字的自然语言/业务引用。用户选择 rename 时必须看到这一风险提示。

## 6. Materialization mode

v0 的物理激活方式固定为：

```text
symlink
junction
copy
```

规则：

- POSIX 未 rename：优先 directory symlink 到 immutable Store entry，失败时 fallback `copy`；
- Windows 未 rename：优先 directory junction 到 immutable Store entry，失败时 fallback `copy`；
- 任意 rename：一律 `copy`，因为必须项目本地改写顶层 `SKILL.md.name`；
- v0 不引入 hardlink、reflink、bind mount、overlay filesystem 等平台优化。

Materialization strategy 只改变项目激活的物理表现，不改变 Package Store `content-digest`。

## 7. `activation.lock`

`.agents/.skiloom/activation.lock` 是本机可重建的 Skiloom activation ownership/state 文件，默认不提交。

Canonical schema：

```toml
lock-version = 1

[[skill]]
activation-name = "ask-matt"
coordinate = "akira-tl/matt-skills/ask-matt"
content-digest = "sha256:3333..."
mode = "symlink"

[[skill]]
activation-name = "ask-matt-other"
coordinate = "someone/other-repo/ask-matt"
content-digest = "sha256:aaaa..."
mode = "copy"
```

每条记录固定只有 `activation-name`、`coordinate`、`content-digest`、`mode`。不保存 `source-name`、第二套 activation digest、绝对路径、platform 或 timestamp。Rename 可由 `activation-name != package-name` 推导。

它用于：

- 区分 Skiloom-managed Skill 与用户/其他工具已有 Skill；
- update/remove 时只修改 Skiloom 自己管理的 entry；
- doctor 检查 activation 是否缺失、指向错误 Store entry 或被意外修改；
- 记录平台相关 activation materialization mode。

portable rename intent 不依赖 `activation.lock`，而在 `.agents/.skiloom/skiloom.toml [renames]` 中保存。

## 8. Drift、删除与更新

`activation.lock` 声明的 path 若缺失，状态为：

```text
MissingManagedActivation
```

因为目标路径不存在未知用户内容，普通 `sync` 可以自动重建。

如果 symlink/junction target 被修改、link 被普通目录替换，或 copy 的文件集合/bytes 被改动，状态为：

```text
ModifiedManagedActivation
```

此时 `sync` / `update` / `remove` fail closed。用户显式选择：

```text
restore  -> 丢弃本地偏移，重建 expected activation
detach   -> 保留现有内容，移除 Skiloom ownership
abort    -> 不修改
```

Skiloom 删除 Package 时，只删除经过验证且由 `activation.lock` 明确归属于该 Package 的 `.agents/skills/<activation-name>`。v0 不自动 adopt 修改后的 activation 为新 Package。

## 9. 与 Package Store 的边界

```text
Package Store
= 原始 immutable Package Snapshot
= source-independent content identity

.agents/skills
= 当前项目 executor-visible activation
= 可能使用原名，也可能使用用户批准的 rename

.agents/.skiloom
= Project requirements / locks / activation state / dependency observations
```

因此同名冲突是 activation 层问题，不回流到 Package Resolver，也不改变 Package Content Digest。

Package Store v0 不执行 destructive automatic GC：单个 project 无法证明机器上没有其他项目通过 symlink/junction 引用某个 digest。Git Source Cache 可以独立采用 LRU、size cap 或 age based pruning；真正的 Store GC 留待未来引入 machine-wide project/reference registry 后再定义。
