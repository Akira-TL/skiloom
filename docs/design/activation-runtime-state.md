# Activation Runtime State v0

状态：Superseded

当前说明：`activation.lock` 与固定项目 `.agents/skills` 激活模型已经退役。当前 Target ownership / detach / repair / Store GC 规则见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md) 与 ADR 0018。

对应历史 ADR：[`0009-activation-runtime-ownership.md`](../adr/0009-activation-runtime-ownership.md)

对应 Wayfinder：#10 `Define Package Store and project activation ownership`

本文件定义 ADR 0008 已确定的扁平 `.agents/skills/` 激活模型之下，本机 activation state、平台 materialization、drift handling 与 Store GC 边界。

## 1. `activation.lock` 只保存 ownership + materialization fact

候选 canonical schema：

```toml
lock-version = 1

[[skill]]
activation-name = "ask-matt"
coordinate = "akira-tl/matt-skills/ask-matt"
content-digest = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
mode = "symlink"

[[skill]]
activation-name = "special-skill-local"
coordinate = "example/special-skills/special-skill"
content-digest = "sha256:7777777777777777777777777777777777777777777777777777777777777777"
mode = "copy"
```

每条记录固定只有：

- `activation-name`：`.agents/skills/` 下 executor-visible 名称；
- `coordinate`：resolved Package coordinate；
- `content-digest`：原始 immutable Package Store identity；
- `mode`：本机当前物理 materialization 方式。

不保存：

```text
source-name
activation-digest
absolute activation path
absolute Store path
platform
created-at / updated-at
```

原因：

- source Package name 已经是 coordinate 最后一段；
- rename 可由 `activation-name != package-name` 推导；
- activation path 固定由 `<project>/.agents/skills/<activation-name>` 推导；
- Store path 固定由机器 Store root + `content-digest` 推导，不把绝对路径写入项目 state；
- platform 可从当前 host 获取；
- timestamp 不参与 ownership/正确性判断。

`[[skill]]` 按 `activation-name` 的 UTF-8 bytes 升序 canonical 输出。

## 2. `mode` v0 只允许三种

```text
symlink
junction
copy
```

不定义 `renamed-view` mode。Rename 是 activation identity mapping，不是独立的 filesystem primitive。

### POSIX

未 rename Package：

1. 优先创建 directory symlink 指向由 `content-digest` 定位的 immutable Store entry；
2. filesystem / policy 不允许 symlink 时退化为 `copy`。

### Windows

未 rename Package：

1. 优先创建 directory junction 指向 immutable Store entry；
2. junction 不可用时退化为 `copy`。

v0 不依赖 Windows Developer Mode 或 elevated symlink permission 才能完成普通安装。

### Rename

只要：

```text
activation-name != package-name
```

v0 一律使用 `copy`，从 Store entry materialize 项目本地 view，并把顶层 `SKILL.md.name` 精确改为 `activation-name`。

v0 不引入 hardlink、reflink、bind mount、overlay filesystem 或其他平台特有优化。

## 3. `activation.lock` 与 `skiloom.lock` 必须一致

每条 `[[skill]]` 必须满足：

1. `coordinate` 存在于 `.agents/.skiloom/skiloom.lock [[package]]`；
2. `content-digest` 等于该 Package Lock Record 的 digest；
3. `activation-name` 等于 `.agents/.skiloom/skiloom.toml [renames]` 中对应值；若无 rename，则等于 Package name；
4. `.agents/skills/<activation-name>` 的实际 materialization 与 `mode` 相符。

`activation.lock` 不是新的 resolution source of truth。解析事实仍由 `skiloom.lock` 决定，它只证明“当前机器把解析结果怎么放到了 `.agents/skills/`”。

## 4. Managed activation 验证

### `symlink`

要求：

- activation path 是 symlink；
- resolved target 等于当前机器上 `content-digest` 对应 Store entry；
- Store entry 自身通过 Package Store content verification。

### `junction`

要求：

- activation path 是 directory junction / 对应平台目录重解析点；
- resolved target 等于 `content-digest` 对应 Store entry；
- Store entry 自身通过 content verification。

### `copy`

Skiloom 从 Store entry + `activation-name` 确定 expected activation view：

- 未 rename：expected bytes/tree 等于原始 Package Snapshot；
- rename：expected view 只在顶层 `SKILL.md` frontmatter `name` 字段上应用确定性 rename，其余 payload bytes 不改写。

验证时比较完整 relative path set、regular-file bytes，并在 host 支持有意义 executable bit 时同时校验 executable state。

不要求在 `activation.lock` 再保存第二个 digest，因为 expected view 可以由 `content-digest + activation-name` 确定性重建。

## 5. Drift 分类

### Missing managed activation

`activation.lock` 声明 entry，但 `.agents/skills/<activation-name>` 不存在。

状态：

```text
MissingManagedActivation
```

这是安全可恢复状态，因为目标路径没有未知用户内容。普通 `sync` 可以自动从 Lock + Store 重建。

### Modified / replaced managed activation

例如：

- symlink/junction target 被改到其他位置；
- link 被替换成普通目录；
- copy 中文件被增加、删除或 byte 修改；
- renamed copy 的 `SKILL.md.name` 被改回其他名字。

状态：

```text
ModifiedManagedActivation
```

普通 `sync` / `update` / `remove` fail closed，不自动覆盖或删除。

可由后续交互操作显式选择：

1. restore：丢弃该 activation 的本地偏移，按 Skiloom expected view 重建；
2. detach：保留当前 `.agents/skills/<name>` 内容，但从 `activation.lock` 移除 Skiloom ownership；
3. abort：不修改任何内容。

v0 不自动“adopt”未知/修改后的内容为新 Package。

## 6. Remove / update 原子边界

在写入前，对所有将修改/删除的 managed activation 做完整验证。

- pristine managed activation：允许替换/删除；
- missing managed activation：更新时可重建，删除时只清理 state；
- modified/replaced managed activation：整次 destructive activation reconciliation 停止，等待显式用户决策；
- 未在 `activation.lock` 声明的 `.agents/skills/*`：始终视为 foreign content，不能由 Skiloom 删除或覆盖。

materialization 使用 sibling temporary path + rename/replace 的方式尽量缩短半写入状态；具体 OS 原子 rename 细节属于实现层，但不得先删除旧 activation 再尝试构建新 activation。

## 7. Store GC v0 边界

Git Source Cache 与 Package Store 的 GC 继续分开。

### Git Source Cache

它是 disposable acquisition cache，没有 project runtime 直接引用，可安全采用：

- LRU；
- size cap；
- age based pruning。

删除后需要时重新 fetch。

### Package Store

`.agents/skills/` 中的 `symlink` / `junction` 会直接引用 Store entry。单凭当前 project 或某个 `activation.lock`，Skiloom 无法知道同一机器上是否还有其他 project 引用一个 digest。

因此 v0 规则：

```text
不做 destructive automatic Package Store GC
```

即：

- Store entry 安装后保留；
- 不因为某个项目 remove 就立即删除 Store entry；
- 不做基于当前 project 的“看起来没人引用”判断；
- 不引入 machine-wide project registry / lease / refcount 作为 v0 前置复杂度。

未来若需要真正 Store GC，再单独设计机器级 project/reference registry；只有能证明没有任何活跃项目引用时才删除。

## 8. v0 结论

#10 的 activation/store ownership 边界收敛为：

```text
resolved Package
  -> immutable machine Store
  -> project-local flat activation
       symlink (POSIX preferred)
       junction (Windows preferred)
       copy (fallback / all renames)
  -> .agents/.skiloom/activation.lock ownership
```

并且：

- activation state 不复制 source/resolution metadata；
- rename 不制造新的 Store Package；
- drift 默认 fail closed；
- missing activation 可自动重建；
- Package Store v0 不进行破坏性自动 GC。
