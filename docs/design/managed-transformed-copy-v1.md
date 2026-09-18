# Managed Transformed Copy v1

状态：Accepted

对应 Issue：#58 `Spec: define v0 managed transformed-copy byte contract`

本文定义 Skiloom v0 在 Target 中生成 **managed transformed copy** 时的精确字节规则。它只服务于官方实现的 Target materialization / verification，不建立新的 Package identity、持久化状态格式或用户可编辑协议。

## 1. 输入与输出

变换是一个确定性函数：

```text
immutable Store Package Snapshot
+ TargetProjectionTransform
→ expected managed projection tree
```

输入中的 Package Snapshot 仍以 `SKILOOM-PACKAGE-V1` 与原始 Package Content Digest 为内容身份。Target transform 不改变：

- Package Coordinate；
- repository/source provenance；
- Package Root；
- Package Content Digest。

managed transformed copy 本身**没有第二个持久内容身份**。实现可以为一次 verification 在内存中计算临时 hash，但不得把它提升为新的 Package digest、Store key 或公开格式。

## 2. 输出树边界

v1 transformed copy 的输出 path set 必须与输入 Store Package Snapshot 的 path set **完全相同**。

- 不新增隐藏 routing 文件；
- 不新增 sidecar manifest；
- 不删除、重命名或移动 Package 内文件；
- 除顶层 `SKILL.md` 外，所有 regular-file bytes 必须逐字节保持不变；
- 所有文件的 executable bit 必须与 Store Snapshot 完全相同；
- 顶层 `SKILL.md` 的 executable bit 也保持不变。

因此 v1 的所有 Target-local transform 都只修改 `SKILL.md` bytes。

如果输入 Snapshot 不含已通过 Package admission 的顶层 `SKILL.md`，运行时返回 `UnsupportedManagedTransform` 并 fail closed；不得猜测其他文件。

## 3. Rename transform

当 projection rename 存在时：

```text
fromActivationName = Package 原始 SKILL.md.name
toActivationName   = Target activation name
```

官方实现必须只替换顶层 frontmatter 中 `name` value 对应的 YAML source range；不得重写整个 frontmatter、排序字段、格式化 YAML、修改注释或改写正文中的自然语言。

规则：

1. 先按 Package admission 同一 YAML profile 解析顶层 frontmatter；
2. 必须定位唯一顶层 `name` value node；
3. 该 value 必须与 `fromActivationName` 语义相等；
4. 用 `toActivationName` 的 plain scalar ASCII/UTF-8 bytes 替换该 value node 的**完整 source range**；
5. key、冒号、周围空白、其他 frontmatter bytes、frontmatter delimiter 与正文 bytes 全部保持原样。

activation name 已受 Skill name grammar 约束，因此不需要 YAML quoting。

若无法唯一定位 source range、原始 name 与预期不一致或解析结果不再满足 admission 所需基本结构，返回 `UnsupportedManagedTransform`；不得退化为正则猜测或整份 YAML canonical rewrite。

Rename 之后：

```text
basename(Target projection path) == transformed SKILL.md.name
```

但 Package Coordinate / Store digest 仍保持原值。

## 4. Dependency Routing Overlay

Dependency Routing Overlay 不是路径 shim，也不创建 dependency alias directory。Skill dependency 是能力依赖，不是跨 Package filesystem ABI。

当 Package P 的某个直接 dependency D 使用非默认 Target activation name 时，planner 只给**直接声明 D 的 P**产生 routing record。runtime 把 P materialize 为 transformed copy，并在 P 的顶层 `SKILL.md` 末尾追加一个确定性 Markdown block，让 Agent 在调用该依赖能力时使用当前 Target-local Skill name。

### 4.1 Reserved markers

内部生成 block 使用两个保留 marker：

```text
<!-- SKILOOM-DEPENDENCY-ROUTING-V1:BEGIN -->
<!-- SKILOOM-DEPENDENCY-ROUTING-V1:END -->
```

它们是官方实现的 generated-byte sentinel，**不是公开输入格式或状态权威**。Skiloom 从不通过解析 live block 来恢复 dependency graph 或 projection state；状态始终来自 Machine Registry / recovery resolution，再重新生成 expected bytes。

当 routing transform 非空，而原始 Store `SKILL.md` 已包含任一 marker 的 exact byte sequence 时，返回 `ManagedTransformMarkerConflict` 并 fail closed。不得删除、合并、采纳或覆盖 source 自带 marker。

### 4.2 Canonical block

routing records 先按 dependency Package Coordinate raw UTF-8 byte order 升序。每个 dependency 只能出现一次。

canonical block bytes 固定为：

```text
<!-- SKILOOM-DEPENDENCY-ROUTING-V1:BEGIN -->
## Skiloom dependency routing

The following Skill dependencies use Target-local activation names. Use the listed Skill name when invoking each dependency; do not infer a filesystem path.

- `<dependency-package-coordinate>`: use Skill `<activation-name>`
...
<!-- SKILOOM-DEPENDENCY-ROUTING-V1:END -->
```

block 内行尾固定使用 LF (`\n`)，最后一个 END marker 后也有一个 LF。

所有 coordinate 与 activation name 已经过现有 grammar 验证；runtime 不做 escaping 或自然语言重写。

### 4.3 与原 SKILL.md 的连接

令 `S` 为 rename（若有）之后的完整 `SKILL.md` bytes。

若 routing records 为空，结果就是 `S`。

若 routing records 非空：

- 如果 `S` 以 LF 结尾，则输出 `S + LF + block`；
- 否则输出 `S + LF + LF + block`。

这保证 generated block 前至少有一个空白 Markdown 行，同时不归一化原文件既有 LF/CRLF、尾随空白或其他 bytes。

## 5. Transform composition

v1 composition 顺序固定：

```text
Store Snapshot
→ optional rename source-range replacement
→ optional dependency-routing block append
→ expected managed projection tree
```

不得反序，不得把 routing block 内容再参与 rename 替换。

同一个 Package 同时存在 rename 与 routing 时，只生成一份 transformed copy；其 `SKILL.md` 同时包含 renamed frontmatter name 与 canonical routing block。

## 6. Materialization

- 没有任何 transform 的 managed projection 可以按平台能力选择 symlink / junction / copy；
- 存在 rename 或 routing transform 的 projection 必须 materialize 为 **managed copy**；
- runtime 不得修改 Store entry；
- copy 必须从已重新验证的 immutable Store entry 构造；
- transformed copy 先在 Target sibling staging path 完整生成和验证，再原子切换到最终 activation path；
- foreign/user-owned path 永远不能作为 staging/replace 的隐式目标。

## 7. Verification 与 drift

对 managed transformed copy 的 verification 必须重新执行同一个纯变换函数得到 expected tree，然后比较：

- path set 完全相等；
- 每个 regular file bytes 完全相等；
- executable bit 完全相等；
- 不允许 symlink、junction、device、FIFO 或其他额外特殊条目出现在 copy 内。

任何差异都属于 managed drift / modified managed content，普通 sync/update/remove 必须按 ownership preflight fail closed 或进入明确 repair 流程；不得把 live bytes 反向 adopt 成新的 Package identity。

Verification **不得**通过读取 routing marker 内容来推导 expected state。

## 8. Detach

`detach` 的 ownership transfer 发生在完整 managed transformed copy 已 materialize 之后。detach 后当前 projection bytes 原地成为 user-owned local copy，包括当时已生成的 renamed `SKILL.md` 与 routing block；Skiloom 不在 ownership transfer 时偷偷删除或重写这些 bytes。

之后该目录不再按 managed transformed-copy 规则自动覆盖。logical binding 与 baseline provenance 继续按 v0 Detached Override 规则处理。

## 9. 非公开格式边界

本规范固定的是 Skiloom 官方实现生成 Target bytes 的确定性算法，不新增以下任何公开格式：

- 不新增 routing sidecar；
- 不新增 Target 内私有 manifest；
- 不新增 transformed-copy digest domain；
- 不允许用户手写 routing block 作为配置或恢复输入。

公开持久化状态仍只有现行 product contract 列出的格式。`.skiloom-state` 与 exact export 继续只保存 projection/graph 所需逻辑事实，不保存 transformed bytes；恢复时按本规范重新生成。
