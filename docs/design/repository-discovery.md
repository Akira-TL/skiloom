# Repository Discovery Control

状态：Partially Superseded

当前说明：`skiloom-repo.toml` 的 discovery 过滤规则继续有效；文中 Project Lock / Confirmed Resolution 的保存与 replay 语义已退役。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

对应历史 Wayfinder：#12 `Define repository-level Skill discovery control`

## 1. 决定

Skiloom 以合法 `SKILL.md` 作为 Skill Package 的唯一最低准入条件。Repository 默认对 exact source snapshot 中全部版本化 `SKILL.md` 做自动发现；仓库作者可以在 repository root 提供可选 `skiloom-repo.toml`，只用于过滤 discovery 范围。

`skiloom-repo.toml` 不定义 Package name、version、dependencies，也不能把没有合法 `SKILL.md` 的目录变成 Package。

## 2. 文件名与位置

固定文件名：

```text
skiloom-repo.toml
```

只在 repository root 识别：

```text
repo/
├── skiloom-repo.toml       # optional
├── skills/
├── examples/
└── ...
```

不用 `skiloom.toml`，因为该名称用于 Project Manifest；不用 `skiloom-workspace.toml`，避免与运行时 workspace / project environment 概念混淆。

## 3. 最小格式

```toml
schema = 1

[discovery]
include = ["skills/**"]
exclude = [
  "skills/**/examples/**",
  "tests/**",
  "fixtures/**",
]
```

字段只描述 repository-relative Package Root 路径过滤。

## 4. 零配置主路径

没有 `skiloom-repo.toml` 时等价于：

```text
include = ["**"]
exclude = []
```

也就是对整个 exact source snapshot 中的版本化 `SKILL.md` 做 discovery。

普通第三方 Skill repository 完全不需要增加 Skiloom 文件。

## 5. Pattern 匹配对象

`include` / `exclude` 匹配 **repository-relative Package Root path**，不是 `SKILL.md` 文件路径。

例如：

```text
skills/engineering/ask-matt/SKILL.md
```

匹配对象是：

```text
skills/engineering/ask-matt
```

因此：

```toml
[discovery]
include = ["skills/**"]
```

可以选中该 Skill Root。

## 6. Include / Exclude 语义

v0 固定规则：

1. `include` 省略或为空时等价于 `["**"]`；
2. 非空 `include`：Package Root 至少匹配一条才进入候选集合；
3. `exclude` 省略或为空时表示不排除任何候选；
4. **`exclude` 优先于 `include`**；
5. pattern 始终相对 repository root；
6. path separator 始终使用 `/`，与宿主操作系统无关；
7. v0 glob grammar 只支持：字面路径、`*`、`**`、`?`；
8. v0 不支持字符类、brace expansion、extglob 或 pattern 内否定；
9. 不允许 absolute path；
10. 不允许 `..` 逃出 repository root。

复杂排除统一写进独立 `exclude`，不在 pattern grammar 中再造第二套否定语义。

## 7. Discovery 顺序

统一流程：

```text
exact repository snapshot
  -> read root skiloom-repo.toml if present
  -> enumerate versioned SKILL.md files
  -> derive Package Root paths
  -> apply include/exclude to Package Root paths
  -> parse/validate selected SKILL.md files
  -> detect duplicate Package Name
  -> select requested package(s)
```

过滤发生在完整 Skill validation 前是为了避免无关 example/fixture 阻塞正式 Package discovery；但过滤不能“修复”被选中的非法 Skill。任何进入最终集合的 root 都必须满足 Agent Skills/Skiloom 的 Skill Root 校验。

## 8. Package Name 与重名

Package Name 始终来自：

```text
SKILL.md.name
```

并要求：

```text
basename(Package Root) == SKILL.md.name
```

如果过滤后仍存在：

```text
a/foo/SKILL.md     name: foo
b/foo/SKILL.md     name: foo
```

则 `owner/repo/foo` 无法唯一解析，返回 `AmbiguousPackageDiscovery`。

作者可以使用 `exclude` 排除不希望参与发布/安装的那一个 root，但 Skiloom 不增加 `package-name -> path` 第二份映射。

## 9. Nested Skill Roots 允许

v0 **允许不同名称的 Package Root 互相嵌套**。

例如：

```text
skills/foo/SKILL.md                 name: foo
skills/foo/examples/bar/SKILL.md    name: bar
```

如果两者都通过 discovery filter 且各自合法，则同时得到：

```text
owner/repo/foo
owner/repo/bar
```

Skiloom 不因为目录嵌套自动选择浅层或深层，也不把嵌套本身当错误。

真正的歧义仍然只按最终 Package Name 判断：若两个 selected root 都声明 `name: foo`，才返回 `AmbiguousPackageDiscovery`。

如果 `bar` 只是 example/fixture，作者应通过：

```toml
[discovery]
exclude = ["skills/foo/examples/**"]
```

明确排除。

### Snapshot 边界

允许 nested Skill Root 不代表外层 Package 可以运行时依赖内层 Package。Skiloom 在 materialize 一个 Package Snapshot 时维护“一个 Package = 一个 Skill”的边界：

- 如果 nested Skill Root 已进入最终 discovery set，则从所有祖先 Package Snapshot 中裁掉并独立 snapshot；
- 如果 nested `SKILL.md` 被 `skiloom-repo.toml` 排除，则它不是独立 Package Root，仍作为祖先 Package 的普通内容保留。

因此独立 nested Skill 的内容变化不会改变祖先 Package Content Digest，也不会形成隐式跨 Package runtime dependency。完整规则见 [`package-snapshot-digest.md`](package-snapshot-digest.md)。

## 10. Release 与 Git 使用同一规则

`skiloom-repo.toml` 属于 repository source snapshot：

- GitHub Release source archive：读取该 Release snapshot 根目录中的 `skiloom-repo.toml`；
- Git source：读取 exact commit 根目录中的 `skiloom-repo.toml`；
- Git Source Cache 只负责取得 exact tree，不保存独立 discovery policy；
- 同一 exact repository snapshot 无论从 Release archive 还是 Git source 获取，discovery 结果应一致。

Lock 通过 full Package coordinate 保存 Package Name，并保存最终 `package-root` 与 exact repository source provenance；不复制完整 `skiloom-repo.toml`，也不保存独立 discovery-control digest。Matching Confirmed Resolution replay 直接使用 locked package roots/graph/content digests，不重新运行 discovery；resolution-changing operation 则从 exact candidate source snapshot重新读取 discovery control。

## 11. Release 与 Git 都只发现 Repository Snapshot

v0 不存在 package-specific Skiloom Release Asset，因此 repository discovery 永远面对一个 exact repository snapshot：

```text
Release -> exact commit -> repository snapshot
Git ref -> exact commit -> repository snapshot
```

两条 source path 从这里开始完全共享 discovery policy。

## 12. v0 只有一个 Discovery Set

v0 不增加：

```text
default-members
publish-members
default packages
publish packages
```

或其他第二套 Package 选集。

语义保持：

```text
owner/repo/package@...
→ 精确选择一个已发现 Package

owner/repo@...
→ 选择该 snapshot discovery 后的全部 Package
```

如果未来出现“默认安装子集”和“可发布全集”确实需要分离的实际案例，再另开协议扩展。

## 13. 不属于本文件的职责

`skiloom-repo.toml` v0 不承担：

- Package name/path 映射；
- Package dependency；
- software dependency；
- Release version；
- Project requirements；
- Git source override；
- executor discovery 配置；
- build/release script；
- registry publisher identity。

## 14. 最终 v0 契约

```text
文件：skiloom-repo.toml
位置：repository root
是否必需：否
无文件默认：全仓版本化 SKILL.md 自动发现
作用：只过滤 Package Root discovery
字段：schema + [discovery].include/exclude
匹配对象：repository-relative Package Root
优先级：exclude > include
glob：literal + * + ** + ?
Package name：SKILL.md.name
nested roots：允许，只要最终 Package Name 不冲突
第二套选集：无
Release/Git：共享相同 discovery 语义
```

这保持零配置第三方兼容，同时给大型 repository 一个明确、轻量且不会污染 Package identity 的 discovery 边界。
