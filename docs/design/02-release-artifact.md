# GitHub Release Source 与完整性 v0

状态：Partially Superseded

当前说明：GitHub Release -> actual tag -> exact commit、SemVer 与完整性边界继续有效；Class R / Lock / conformance 相关引用已退役。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

## 1. 目标

Skiloom v0 使用 GitHub Release 作为稳定版本选择入口，但 **不定义、也不要求任何 Skiloom 专用 per-Skill Release Asset**。

Release 只做两件事：

1. 给 repository snapshot 一个可参与依赖求解的稳定语义版本；
2. 把这个版本绑定到一个 exact Git commit。

后续 Package discovery、Package Root snapshot、content digest、Store 与 activation 都与 Git source 共用同一套协议。

因此：

```text
Release source
  SemVer Release -> tag -> exact commit -> repository snapshot -> SKILL.md discovery

Git source
  ref -> exact commit -> repository snapshot -> SKILL.md discovery
```

## 2. Release version 只接受 SemVer

Skiloom Release resolver v0 只从 published (`draft=false`) GitHub Release records 中，把下列 actual tag 识别为 Release version：

```text
1.4.0
v1.4.0
```

两者都规范化为：

```text
1.4.0
```

规则：

- 必须是合法 Semantic Versioning（SemVer）版本；
- 允许且只允许一个前导 `v`；
- `v` 不进入规范化版本值；
- prerelease/build metadata 按 SemVer 语义解析；GitHub `prerelease` / latest / timestamp / API ordering 不参与 Class R eligibility/order；
- 非 SemVer Git tag 不进入 Release version resolver；如需使用，应显式走 Git source；
- 如果同一 repository 同时存在 `1.4.0` 与 `v1.4.0` 两个 Release，它们规范化后冲突，返回 `AmbiguousReleaseVersion`，不得自动任选一个。

因此依赖范围：

```text
^1.4
>=1.4, <2
~1.4
```

始终作用于规范化 repository Release version。

## 3. Release source 只使用 repository source snapshot

选中 Release 后：

```text
owner/repo/package@1.4.0
  -> select normalized Release 1.4.0
  -> record actual GitHub tag, e.g. v1.4.0
  -> peel actual tag to exact commit
  -> obtain repository source snapshot for that commit
  -> apply skiloom-repo.toml discovery policy if present
  -> discover SKILL.md roots
  -> select requested package(s)
```

`target_commitish` 不作为 exact source identity；existing tag 的 authority 是 actual tag 最终解析出的 exact commit。

Skiloom v0 不查找、下载或定义：

```text
foo.skiloom.tar.gz
bar.skiloom.tar.gz
package-specific release asset
```

GitHub Release 中存在其他附件时，Skiloom Core 忽略它们。

这避免同一个 Release 同时出现“repository 中的 Skill Root”和“额外打包 Skill Asset”两套内容来源。

## 4. GitHub 自动源码归档只是传输载体

Skiloom 可以使用 GitHub 为 tag/commit 提供的源码 tarball/zip 获取 repository snapshot，也可以使用等价 Git transport/materialization。

但 **自动生成源码归档的压缩 bytes 不是长期 Package identity**。

因此：

- 下载时必须做安全解包和必要的传输完整性检查；
- 可以在运行日志/cache metadata 中记录本次下载 bytes 的 SHA-256；
- `skiloom.lock` 不依赖 source archive byte digest 作为长期可重建 identity；
- 长期 identity 使用 exact commit + Package Root + Package content digest。

## 5. Release Lock identity

Release repository 记录至少包含：

```toml
[[repository]]
coordinate = "owner/repo"
source-kind = "github-release"
version = "1.4.0"
tag = "v1.4.0"
commit = "0123456789abcdef..."
immutable = true
```

其中：

- `version`：Skiloom 规范化 SemVer；
- `tag`：GitHub 上实际选中的 tag；
- `commit`：该 Release/tag 首次解析并锁定的 exact commit；
- `immutable`：获取时 GitHub Release 是否处于 immutable 状态；它是 provenance/trust signal，不是安装准入条件。

Package 记录：

```toml
[[package]]
coordinate = "owner/repo/foo"
package-root = "skills/foo"
content-digest = "sha256:..."
dependencies = []
```

Package content digest 才是 Store snapshot 的内容完整性标识。

## 6. Immutable Release 是增强信号，不是准入条件

GitHub Immutable Releases 可以降低 tag/asset 被后续修改的风险，但 Skiloom v0 不要求 repository 开启该功能。

规则：

- immutable Release：记录 `immutable = true`；
- 普通 Release：记录 `immutable = false`；
- 两者都可以安装；
- exact commit 和 Package content digest 仍然必须锁定；
- 未来可在 trust policy 中对 immutable Release 提供更高信任等级，但不改变 Package discovery 语义。

## 7. Release retargeting

假设 Lock 已记录：

```text
v1.4.0 -> commit AAA
```

之后 GitHub 上同名 Release/tag 解析为：

```text
v1.4.0 -> commit BBB
```

Skiloom 不得在普通 `sync` 中静默漂移到 `BBB`。

应报告：

```text
ReleaseRetargeted
locked commit:  AAA
current commit: BBB
```

行为：

- Store 中已有 `AAA` 对应 Package 时，现有 Lock 仍可继续使用；
- `frozen` 模式只接受 Lock 中的 `AAA`；
- 普通 `sync` 报告 retarget，不自动重写 Lock；
- 只有显式 update/重新解析操作才可以接受新 snapshot，并产生新的 Lock 状态。

## 8. Source 获取与安全

从 GitHub source archive materialize repository snapshot 时至少防止：

- absolute path；
- `..` path traversal；
- 规范化后路径逃出临时 source root；
- 规范化后重复/冲突路径；
- device node / FIFO 等非普通内容。

Repository source snapshot 只是 discovery/source materialization；最终只把选中的 Skill Root 作为独立 immutable Package snapshot 写入 Package Store。

## 9. Release 安装流程

```text
parse owner/repo[/package]@version-range
  -> enumerate SemVer GitHub Releases
  -> normalize optional v prefix
  -> choose exact compatible Release
  -> reject normalized-version ambiguity
  -> record actual tag + immutable signal
  -> resolve tag -> exact commit
  -> compare with previous Lock if present
  -> reject silent Release retargeting
  -> obtain exact repository snapshot
  -> apply repository discovery control
  -> discover SKILL.md Package Roots
  -> select requested package(s)
  -> read optional skiloom-package.toml / DEPENDENCIES.md
  -> compute Package content digest
  -> put immutable Package snapshot into Store
  -> preflight flat activation names
  -> activate into .agents/skills/<activation-name>
```

Repository-wide target省略 package selector 时，安装该 exact repository snapshot 经唯一 discovery policy 选出的全部 Package。

## 10. Release 与 Git source 的统一边界

两种 source 在 exact commit 以后共享完全相同的行为：

```text
exact commit
  -> repository tree
  -> skiloom-repo.toml
  -> SKILL.md discovery
  -> optional package metadata
  -> dependency resolution
  -> Package content digest
  -> Store
```

因此 v0 的 source adapter 只负责回答：

```text
这个 repository 应使用哪个 exact commit？
```

Release source 用 SemVer Release 选择它；Git source 用显式 ref 选择它。

## 11. 明确不进入 v0

- Skiloom 专用 per-Skill Release Asset；
- Release Asset package index；
- 用 source archive byte digest 作为长期 Package identity；
- 非 SemVer Release version；
- 自动接受被 retarget 的同名 Release；
- 强制要求 GitHub Immutable Release。
