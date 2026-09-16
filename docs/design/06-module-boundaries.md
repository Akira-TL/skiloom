# v0 Module 边界工作草案

状态：Superseded Working Draft

当前说明：本文基于旧 Project/Lock/Core 模型，已不再作为官方实现结构依据。现行实现边界见 [`official-implementation-architecture.md`](official-implementation-architecture.md) 和 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

## 总体数据流

```text
Project requirements
    ↓
source resolution
    ↓
Release repository snapshot / Git source cache
    ↓
SKILL.md discovery
    ↓
optional metadata parsing
    ↓
dependency resolution
    ↓
Package Store
    ↓
flat Project Skill Activation -> .agents/skills
    ↓
activation state -> .agents/.skiloom/activation.lock
    ↓
optional dependency probes -> .agents/.skiloom/dependencies.lock
```

## `metadata`

职责：

- 解析 `SKILL.md` frontmatter；
- 解析可选 `skiloom-package.toml`；
- 解析 `.agents/.skiloom/skiloom.toml`；
- 读写 `.agents/.skiloom/skiloom.lock`；
- 解析 GitHub install coordinate；
- 解析 Release version requirement。

核心 domain values：

```text
GitHubRepository
SkillName
GitHubPackageCoordinate
ReleaseVersion
VersionRequirement
OptionalPackageManifest
ProjectRequirement
LockRecord
```

Package 名称来自 `SKILL.md.name`，不依赖 Manifest。

## `sources`

### GitHub Release source

```text
available_releases(owner, repo)
resolve_release(owner, repo, version) -> exact tag/commit
resolve_release(owner, repo, normalized_semver) -> actual tag + exact commit + immutable signal
fetch_repository_snapshot(owner, repo, exact_commit)
```

### Git source cache

```text
ensure_cached(owner, repo)
fetch_refs(cache_entry)
resolve_ref(cache_entry, ref) -> exact commit
read_tree(cache_entry, commit)
materialize_tree(cache_entry, commit, temp_path)
```

Git source cache 是 disposable acceleration layer，不是 Store。

## `discovery`

独立负责从一个 exact repository snapshot 发现 Skill Package：

```text
discover_skills(tree) -> SkillPackageCandidates
```

规则以 `SKILL.md` 为唯一 anchor：

- 父目录 = Package Root；
- basename == `SKILL.md.name`；
- repository 内 Skill name 唯一；
- nested Skill Roots 允许，只要最终 `SKILL.md.name` 不重复；
- optional Manifest / `DEPENDENCIES.md` 只作为附加 metadata。

把 discovery 从 source adapter 和 resolver 中独立出来，可以让 Release archive、Git cache、未来 Registry payload 共用同一套规则。

## `resolution`

职责：

- 选择 exact repository Release / Git commit；
- 选择用户指定或 repository-wide 的 discovered Skills；
- 读取可选 Manifest 的 `[dependencies]`；
- 合并同 repository Release constraints；
- 保证同 repository source snapshot 一致；
- cycle detection；
- previous Lock preference / frozen validation。

没有 Manifest 的 Skill 是合法 leaf node。

## `planning`

返回纯数据计划：

```text
release repository snapshots to obtain
git cache entries to create/fetch
package roots to snapshot
store entries to reuse
flat .agents/skills activation entries to add/remove/rename
common software probes to run
special dependency docs requiring Agent inspection
```

不包含宿主软件安装动作。

## `snapshots`

职责：把 selected Package Root 变成 verified immutable Package snapshot。

```text
snapshot_and_verify(source_root, discovered_nested_roots) -> VerifiedPackageSnapshot
```

至少负责：

- 从祖先 Package snapshot 中裁掉已经独立 discovery 的 nested Skill Roots；
- 拒绝 symlink、hardlink 与其他特殊文件；
- 校验 portable relative UTF-8 path 与 Unicode case-fold collision；
- 保留 executable bool 与 exact file bytes，不保留无关宿主 metadata；
- `SKILL.md` 校验；
- optional Manifest 校验；
- optional `DEPENDENCIES.md` digest；
- 按 `SKILOOM-PACKAGE-V1` 计算 canonical `content-digest`。

完整算法见 [`package-snapshot-digest.md`](package-snapshot-digest.md)。

## `store`

只保存 content-addressed immutable Skill Package snapshot：

```text
contains(content_digest)
put_verified(snapshot, content_digest)
get(content_digest)
verify(content_digest)
```

逻辑 key：

```text
sha256/<64-hex-digest>
```

Store key 不含 GitHub owner/repo、Release、commit 或 package-root；这些 provenance 由 Lock 持有。不同来源的相同 Package snapshot 因此可以复用同一 Store entry。Source Cache 被删不会影响已经进入 Store 的 Package。

## `activation`

根据 resolved Packages 与 `.agents/.skiloom/skiloom.toml [renames]` 构建扁平 executor-visible Skill 目录：

```text
.agents/skills/<activation-name>
```

职责：

- 默认 `activation-name = SKILL.md.name`；
- 在任何写入前做完整 activation-name collision preflight；
- POSIX 未 rename 优先 `symlink`、Windows 未 rename 优先 `junction`，失败时 fallback `copy`；
- rename Package 一律 `copy`，并同步修改顶层 `SKILL.md.name`；
- `.agents/.skiloom/activation.lock` 每项只保存 activation name、coordinate、content digest 与 `symlink|junction|copy` mode；
- missing managed activation 可自动重建；modified/replaced managed activation fail closed，并只允许显式 `restore` / `detach` / `abort`；
- 未经用户明确 rename 时，冲突返回 `ActivationNameConflict`；
- 不覆盖/删除未由 Skiloom activation state 管理的既有 Skill。

v0 的 executor discovery 面直接就是 `.agents/skills/`，不再建立 Skiloom 私有分层 Skill Library 或额外 executor adapter view。

## `dependency_checks`

只处理可选依赖增强：

- Manifest `[software]` 的 common probes；
- 每次 `sync` / `doctor` 对当前 resolved graph 重新执行便宜的只读 software probe；
- Package `content-digest` 作为 dependency state 唯一 freshness anchor；
- `.agents/.skiloom/dependencies.lock` 中 software observations 的读写、orphan/stale 清理；
- 与 Agent 管理的 `[[package.special]]` observations 做保留式原子合并。

不解析 `DEPENDENCIES.md` 为结构化 requirement，不提供 install/upgrade/remove/configure。

## `application`

上层用例：

```text
install_target()
sync_project()
update_project()
remove_target()
doctor_project()
cache_gc()
```

`cache_gc()` 只处理 disposable Git Source Cache。v0 不提供 destructive automatic Package Store GC；Store entry 在项目 remove 后仍保留，直到未来有 machine-wide reference registry 能证明无活跃引用。

## 明确避免

v0 不建立：

- 必填 `skiloom-package.toml`；
- 抽象 Registry Package Identity 作为 GitHub 前置层；
- Multi-Skill Package；
- 全局 Skill name registry；
- Software Provider 自动安装体系；
- Package 自定义系统安装脚本；
- repository runtime shared directory；
- 项目直接链接 mutable Git checkout。