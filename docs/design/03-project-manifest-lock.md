# Project Manifest 与 Lock v0

状态：Superseded

当前说明：Project Manifest / Project Lock / `activation.lock` 项目状态模型已经退役。当前状态模型见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md) 与 ADR 0018。

对应历史 Wayfinder：#6 `Define Project Manifest and Lock semantics`

## 1. Project state 布局

Skiloom 项目侧有四个职责分离的状态文件，其中 `skiloom.lock` 内部仍保持 `requirement -> repository -> package` 三层解析模型：

```text
.agents/.skiloom/skiloom.toml           # 用户声明：我想要什么
.agents/.skiloom/skiloom.lock           # 可提交：最终解析成什么
.agents/.skiloom/activation.lock    # 本机状态：当前扁平 Skill 激活 ownership
.agents/.skiloom/dependencies.lock  # 本机状态：当前环境是否满足依赖
```

固定边界：

- `.agents/.skiloom/skiloom.toml` 声明顶层 Skill/Repository requirement，并保存用户明确批准的 `[renames]` activation rename；
- `.agents/.skiloom/skiloom.lock` 保存 requirement 的规范化语义、exact repository source、Package Snapshot 身份和 resolved dependency edges；
- `.agents/.skiloom/activation.lock` 保存当前机器上 Skiloom-managed `.agents/skills/` entry 的 ownership/materialization state；
- `.agents/.skiloom/dependencies.lock` 保存当前机器上的软件/特殊依赖观察结果；
- Package 自身的 `skiloom-package.toml` / `DEPENDENCIES.md` 属于 immutable Package Snapshot，不复制到 Project Lock。

## 2. `.agents/.skiloom/skiloom.toml`

最小格式：

```toml
schema = 1

[skills]
"akira-tl/matt-skills/ask-matt" = "^1.4"
"akira-tl/skills/browser-access" = "^2.0"
"example/special-skills/special-skill" = { git = "main" }
```

字符串值表示 GitHub Release version requirement。coordinate 可以是 `owner/repo/package` 或 `owner/repo`；前者选择一个 Skill Package，后者表示 repository-wide top-level requirement。输入允许 GitHub display casing，但解析后的语义 coordinate 必须按 [`source-trust-conformance.md`](source-trust-conformance.md) 把 owner/repo ASCII lowercase；Requirement Set comparison、repository grouping 与 canonical Lock 都使用该 canonical coordinate。

Git source 使用 inline table，必须显式：

```toml
[skills]
"example/special-skills/special-skill" = { git = "main" }
"example/another-skills" = { git = "0123456789abcdef" }
```

不再使用 Git source 的 `"*"` version placeholder 和独立 `[sources]` table。

扁平激活发生同名冲突且用户选择 rename 时，Skiloom 还会保存 portable rename intent：

```toml
[renames]
"someone/other-repo/ask-matt" = "ask-matt-other"
```

`[renames]` 不改变 Package coordinate/source/content identity，只决定该 Package 在 `.agents/skills/` 中的项目本地 activation name。

## 3. Repository-scoped source binding

Project Requirement 可以精确到一个 Package，但 source binding 始终作用于 `owner/repo`。

例如：

```toml
[skills]
"owner/repo/foo" = { git = "main" }
```

解析到：

```text
owner/repo -> exact commit abc123...
```

同 repository 的 `bar`、`baz` dependency 都复用同一个 exact commit。

同一项目若要求同 repository 的不同 Git ref，或 Release/Git 混装，返回：

```text
RepositorySourceConflict
```

v0 中一个 project resolution 的每个 repository 只允许一个 exact source snapshot。

## 4. `skiloom.lock` 三类 Record

Canonical Lock 只使用：

```text
requirement
repository
package
```

关系：

```text
requirement
    ↓ 用户顶层意图
repository
    ↓ exact source provenance
package
    ↓ exact Package Snapshot + resolved edges
```

### 4.1 Requirement Record

Release：

```toml
[[requirement]]
coordinate = "akira-tl/matt-skills/ask-matt"
source-kind = "github-release"
version = "^1.4"
```

Git：

```toml
[[requirement]]
coordinate = "example/special-skills/special-skill"
source-kind = "git"
ref = "main"
```

Requirement Record 保存 `skiloom.toml` 解析后的语义，不保存原始 TOML bytes。Release `version` 使用 [`resolver-conformance.md`](resolver-conformance.md) 定义的 canonical Release Version Requirement；因此只改注释、空白、table ordering、comparator ordering 或 Cargo-default/caret 等 canonical-equivalent 写法不会让 Lock 失效。v1 不要求证明任意两个不同 range 表达式的集合代数等价。

### 4.2 Repository Record

Release：

```toml
[[repository]]
coordinate = "akira-tl/matt-skills"
source-kind = "github-release"
version = "1.4.3"
tag = "v1.4.3"
commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
immutable = true
```

Git：

```toml
[[repository]]
coordinate = "example/special-skills"
source-kind = "git"
commit = "0123456789abcdef0123456789abcdef01234567"
```

Repository Record 是 source provenance 的唯一位置。Package Record 不重复 `source-kind`、version/tag/commit/requested-ref；Git `ref` 属于 top-level Requirement 语义，Repository Record 只保存最终 exact commit。

### 4.3 Package Record

```toml
[[package]]
coordinate = "akira-tl/matt-skills/ask-matt"
package-root = "skills/engineering/ask-matt"
content-digest = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
dependencies = [
  "akira-tl/matt-skills/implement",
  "akira-tl/matt-skills/wayfinder",
]
```

Package Record 只保存完整 Package coordinate、实际 repository-relative `package-root`、`SKILOOM-PACKAGE-V1` `content-digest` 和已解析的 exact Skill dependency edges。

不再保存 `name`：它已经是 coordinate 最后一段，并且 discovery 已验证它来自 `SKILL.md.name`。

dependency edge 不带 `@version` / commit；目标 Package 所属 `[[repository]]` 已唯一决定 exact source snapshot。

## 5. Project Lock 不复制 Package 内部状态

`skiloom.lock` 不保存：

```text
manifest-digest
dependencies-doc-digest
[[software]]
```

`skiloom-package.toml` / `DEPENDENCIES.md` 已包含在 Package Snapshot 中，任意 byte 变化都会改变 Package `content-digest`。common software requirement 可从 immutable Package Snapshot 读取；当前机器 observation 属于 `.agents/.skiloom/dependencies.lock`。

因此 `content-digest` 是 Package payload 的唯一项目级完整性身份。

## 6. Canonical serialization

Skiloom 自己生成 `skiloom.lock`；v0 Project Lock format 固定 `lock-version = 1`。Canonical writer 固定：

1. UTF-8；
2. LF line endings；
3. 不生成注释；
4. `lock-version = 1` 位于最前；
5. `[[requirement]]` 按 `coordinate` 的 UTF-8 bytes 升序；
6. `[[repository]]` 按 `coordinate` 的 UTF-8 bytes 升序；
7. `[[package]]` 按 `coordinate` 的 UTF-8 bytes 升序；
8. `dependencies` 按 coordinate 的 UTF-8 bytes 升序；
9. 同一种 Record 的字段使用固定顺序。

字段顺序：

```text
requirement:
  coordinate
  source-kind
  version | ref

repository / github-release:
  coordinate
  source-kind
  version
  tag
  commit
  immutable

repository / git:
  coordinate
  source-kind
  commit

package:
  coordinate
  package-root
  content-digest
  dependencies
```

Canonical ordering 用于稳定 Git diff 和 deterministic generation；所有 coordinate 在排序与输出前都已经完成 owner/repo lowercase canonicalization。Lock 语义仍由解析后的 TOML 数据决定。

## 7. Project Intent 与 Confirmed Resolution

Project Manifest 与 Lock 不再只是“输入文件 / resolver cache”的关系，而是两个不同状态：

```text
.agents/.skiloom/skiloom.toml [skills]
= Project Intent
= 项目允许什么

.agents/.skiloom/skiloom.lock
= Confirmed Resolution
= 项目已经明确接受什么 exact result
```

完整决定见 [ADR 0011](../adr/0011-intent-confirmed-resolution.md)。

## 8. `sync` / `update` / `frozen`

### `sync`

Lock 已存在时，普通 `sync` 只恢复/校验 Confirmed Resolution：

```text
parse Project Intent
  -> compare Lock Requirement Set
  -> mismatch: ProjectIntentLockMismatch
  -> match: use exact locked repositories/packages/edges
  -> materialize/verify Store entries
  -> preflight flat activation names + apply explicit [renames]
  -> reconcile .agents/skills and .agents/.skiloom/activation.lock
  -> run dependency observations
```

`sync` 不枚举更新的 compatible Release、不让 Git ref 前进、不重新求解 dependency graph，也不因为 ordinary sync 改写成另一份 Lock。

如果没有 Lock，可以进入 initial resolution，但 exact candidate 必须在被显式接受后才成为正式 Lock；非交互实现不得把普通同步本身视为隐式接受。

### `update`

显式 `update` 才允许重新求解当前 Project Intent。它必须先形成 candidate resolution，并展示相对当前 Confirmed Resolution 的 source/version/commit/graph/content 变化；只有在用户或显式自动化策略接受后，才原子写入新 Lock 并按它 reconciliation。

### `frozen`

Frozen mode 要求已有且完全匹配的 Confirmed Resolution：Lock 缺失、Requirement Set 不一致或 locked graph 无法恢复都直接失败；它永不创建或更新 Lock。`[renames]` 仍属于 activation intent，由 activation reconciliation 单独处理。

`skiloom.toml` 注释、空白或等价 TOML 排版不会造成 Requirement Set 差异。

## 9. Project Skill Activation

Resolved Package 直接扁平激活到 executor-visible：

```text
<project>/.agents/skills/<activation-name>
```

默认：

```text
activation-name = SKILL.md.name
```

如果目标 name 已被另一个 Package 或未知既有 Skill 占用，Skiloom 在写入前返回 `ActivationNameConflict`，提示用户选择为**新安装项** rename 或放弃本次操作；不得自动覆盖。用户批准的 rename 写入 `.agents/.skiloom/skiloom.toml [renames]`。

未 rename Package 可以直接链接 immutable Package Store entry；rename Package 必须生成合法的项目本地 activation view，使目录 basename 与其中 `SKILL.md.name` 同时等于新的 activation name。原始 Store entry/content-digest 不改变。

当前 Skiloom-managed activation ownership/materialization state 单独写入 `.agents/.skiloom/activation.lock`。完整语义见 [`project-activation.md`](project-activation.md)。

## 10. 不属于 `skiloom.lock` 的内容

以下内容明确不属于 Project Lock：

- Git Source Cache 机器绝对路径；
- Release source archive bytes/digest；
- Package 内文件逐项 digest；
- `skiloom-package.toml` 单独 digest；
- `DEPENDENCIES.md` 单独 digest；
- 当前宿主软件版本/路径/状态；
- Agent 对特殊依赖的检查 note；
- 当前 `.agents/skills/` materialization/ownership state。

这些分别属于 source cache、Package Snapshot、`.agents/.skiloom/dependencies.lock` 或 `.agents/.skiloom/activation.lock`。
