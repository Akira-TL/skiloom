# ADR 0009：Activation Runtime Ownership 与 Store GC 边界

- 状态：Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：`activation.lock` 与项目激活状态模型已退役；现行 ownership、detach、修复与 Store GC 边界见 `docs/design/skiloom-v0-product-contract.md`。

## 背景

ADR 0008 已确定 Skiloom 把 resolved Skill 直接扁平激活到项目 `.agents/skills/<activation-name>`，并用 `.agents/.skiloom/activation.lock` 区分 Skiloom-managed Skill 与 foreign content。剩余问题是：`activation.lock` 应保存哪些字段、不同平台如何 materialize、managed activation 被外部修改后如何恢复，以及 Package Store 是否可以安全自动 GC。

## 决定

### 1. `activation.lock` 只保存 ownership 与 materialization fact

每条 `[[skill]]` 固定保存：

```text
activation-name
coordinate
content-digest
mode
```

其中 `mode` v0 只允许：

```text
symlink
junction
copy
```

不保存 `source-name`、activation digest、绝对 activation/store path、platform 或 timestamp。Rename 由 `activation-name != package-name` 直接推导，不是独立 mode。

### 2. 平台 materialization

- POSIX 未 rename：优先 directory symlink，失败时 fallback `copy`；
- Windows 未 rename：优先 directory junction，失败时 fallback `copy`；
- 任意 rename：一律 `copy`，并只对顶层 `SKILL.md` frontmatter `name` 应用确定性改写；
- v0 不引入 hardlink、reflink、bind mount、overlay filesystem 等优化。

### 3. Managed activation 验证与漂移

`symlink` / `junction` 必须仍指向当前 `content-digest` 对应 Store entry；`copy` 必须等于由 Store entry + activation name 确定性推导的 expected view。

- 声明存在但 activation path 缺失：`MissingManagedActivation`，普通 `sync` 可以自动重建；
- managed path 存在但被修改、替换或重定向：`ModifiedManagedActivation`，`sync` / `update` / `remove` fail closed。

对 modified activation，用户显式选择：

```text
restore  -> 丢弃本地偏移并按 Skiloom expected view 重建
detach   -> 保留当前内容并移除 Skiloom ownership
abort    -> 不修改
```

v0 不自动 adopt 外部修改内容为新 Package。

### 4. 原子写入边界

对所有将修改/删除的 managed activation 先完成验证。新的 activation 先在 sibling temporary path 完整 materialize，再使用平台可用的 rename/replace 切换；不得先删除旧 activation 再尝试构建新 activation。

### 5. Package Store GC

Git Source Cache 是可丢弃 acquisition cache，可以采用 LRU、size cap、age based pruning。

Package Store 不同：`.agents/skills/` 中的 symlink/junction 可能由机器上多个项目直接引用 Store entry。没有 machine-wide project registry / lease / refcount 时，Skiloom 无法证明一个 digest 已无任何活跃引用。

因此 v0：

```text
不执行 destructive automatic Package Store GC
```

项目 remove 只移除项目 activation/state，Store entry 保留。未来若引入机器级引用注册机制，再单独定义 destructive Store GC。

## 结果

Activation state 保持极小，只描述“这个 Package digest 当前以什么物理方式出现在这个 activation name 下”；resolution 仍由 `skiloom.lock` 决定。Rename 不制造新 Store Package，managed drift 默认 fail closed，且 v0 不因缺乏全局引用证明而冒险删除共享 Store 内容。
