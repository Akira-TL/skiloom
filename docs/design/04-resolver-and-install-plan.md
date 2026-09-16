# Dependency Resolver 与 Install Plan v0 工作草案

状态：Superseded Working Draft

当前说明：本文记录旧 Project/Lock/Core 编排草案，已被 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md) 取代。仍有效的 resolver/source 具体规则已经吸收到当前官方产品规范。

## 1. Resolver 的对象

Skiloom v0 直接解析 GitHub source：

```text
owner/repo[/package]@version-or-ref
```

它不要求 Skill 作者先注册到独立 Registry，也不要求存在 `skiloom-package.toml`。

每个被选择的 Skill Package 至少由以下信息确定：

```text
owner/repo
source kind: release | git
exact source snapshot: release+commit | exact commit
repository-relative package-root
SKILL.md.name
content digest
```

如果可选 `skiloom-package.toml` 存在，Resolver 再展开其结构化 Skill dependencies。

## 2. Release source

默认 source 是 GitHub Release。

Release version 属于 repository。例如：

```text
owner/repo/foo@1.4.0
owner/repo/bar@^1.4
```

如果 `foo` 与 `bar` 来自同一个 repository，则约束共同作用于 repository Release version。

Release resolver v0 只接受 published (`draft=false`) GitHub Release；actual tag 必须可按 SemVer 规范化，允许可选前导 `v`。例如 `1.4.0` 与 `v1.4.0` 都规范化为版本 `1.4.0`；如果两者同时存在则构成 `AmbiguousReleaseVersion`。GitHub `prerelease` / latest / timestamp / API 返回顺序不参与 Class R candidate eligibility 或 ordering。

选定 Release 后，Skiloom 记录 actual tag，并把 tag 最终 peel 到 exact commit；`target_commitish` 不作为 exact source identity。随后只从该 repository source snapshot 按 `SKILL.md` discovery 找到 Package Root。v0 不使用 package-specific Skiloom Release Asset。

Package 没有 Manifest 时仍是合法 leaf Package，只是没有 Skiloom 可见的结构化 transitive dependency。

## 3. Git source

没有 Release 或明确需要源码版本时，用户显式选择 Git source：

```text
owner/repo/foo@main --git
```

Skiloom：

1. 从机器级 Git Source Cache 取得/fetch repository；
2. 把 requested ref 解析为 exact commit；
3. 基于 exact commit 的 tracked tree 做 Skill discovery；
4. snapshot 选中的 Skill Root 到 immutable Package Store；
5. Lock exact commit、package-root 与 content digest。

Git source 不直接把 mutable checkout 暴露给项目。

## 4. Git Source Cache

逻辑布局：

```text
~/.cache/skiloom/git/github.com/<owner>/<repo>.git/
```

它适合实现为 bare/mirror-style repository cache：

- 同一 repository 只缓存一份 Git objects；
- 不同项目、不同 branch/tag/commit 可以复用；
- ref 更新只 fetch 增量 objects；
- discovery 可以直接读 Git tree，真正需要 snapshot 时再临时 materialize；
- cache 可以删除并重新获取，不是项目状态真相。

Source Cache 不进入 `.agents/.skiloom/skiloom.lock` 的本机绝对路径。Lock 只保存可重建 provenance：repository、requested ref、exact commit、package-root、content digest。

## 5. Package discovery

Git checkout/package path **不能由安装坐标提前推出**。

统一 discovery anchor 是 `SKILL.md`。

推荐算法：

1. 取得 exact repository snapshot；
2. 枚举版本化 tree 中所有 `SKILL.md`；
3. 每个文件父目录成为 Package Root candidate；
4. 解析 `SKILL.md` frontmatter `name`；
5. 校验：

```text
basename(package-root) == SKILL.md.name
```

6. 如果 repository root 存在可选 `skiloom-repo.toml`，对 candidate 的 repository-relative Package Root path 应用 `include` / `exclude`；没有配置时等价于全量候选；
7. 过滤后如果同一个 `SKILL.md.name` 出现多个 candidate，报告 `AmbiguousPackageDiscovery`；
8. 过滤后的 Package Root 允许互相嵌套；嵌套本身不构成 discovery error；
9. 如果 `skiloom-package.toml` 存在，解析依赖增强信息；
10. 如果 `DEPENDENCIES.md` 存在，记录其 digest；
11. selector 存在时按 `SKILL.md.name` 匹配；
12. selector 省略时选择全部最终合法 Package Roots；
13. 只有最终 `SKILL.md.name` 重复时才报告 `AmbiguousPackageDiscovery`；
14. Lock 保存实际 repository-relative path。

Repository-level discovery control 的完整候选语义见 [`repository-discovery.md`](repository-discovery.md)。

例如：

```text
repo/
├── agent-tools/routers/ask-matt/SKILL.md
└── engineering/tdd/SKILL.md
```

安装：

```text
owner/repo/ask-matt@main --git
```

不需要用户知道 `agent-tools/routers/ask-matt`。

## 6. 同 repository source 一致性

一个 project resolution 中，同一个 `owner/repo` 只绑定一个 source snapshot：

```text
Release X (+ exact commit)
或
Git exact commit Y
```

不允许：

```text
foo <- Release 1.4.0
bar <- Git main
```

来自同一个 repository 的 Package 必须来自同一 snapshot。

Git source 下，如果一个有 Manifest 的 Skill 声明同 repository sibling dependency：

```toml
[dependencies]
"owner/repo/helper" = "^1.4"
```

当前 explicit Git binding 优先：`helper` 从同一个 exact commit discovery/snapshot，不再切回 Release。该 dependency 的 Release range 在 Git override 下不作为版本选择条件；Lock 明确记录 source-kind=git，使这种开发态 override 可审计。

跨 repository dependency 没有显式 Git override 时仍按 Release source 解析。

## 7. Version resolution

Version resolver 只在 initial resolution 或显式 resolution-changing operation（例如 `update`）中运行；**已有匹配 Lock 的普通 `sync` 不运行版本求解器**。

Release resolution 的 normative 语义见 [`resolver-conformance.md`](resolver-conformance.md)：

1. Release requirement 使用 Cargo-style default/caret/tilde/wildcard/comparison/comma-intersection profile；
2. `vX.Y.Z` 与 `X.Y.Z` 规范化为同一版本；同 normalized version 重复报告 `AmbiguousReleaseVersion`；
3. 同 repository 的全部 Release requirements 共同约束 repository candidate；
4. candidate 按 SemVer precedence 从高到低，并按 canonical repository/package ordering 做 deterministic backtracking；
5. prerelease 使用 explicit opt-in semantics；
6. build metadata 不参与 precedence；search 到达多个 equal-precedence Release 时报告 `AmbiguousReleasePrecedence`；
7. candidate Release tag 必须解析到 exact commit，并且该 snapshot 必须能 discovery 到所需 `SKILL.md.name`；
8. previous Lock 不作为 hidden candidate preference，只用于 candidate diff / acceptance；
9. 若当前已有 Confirmed Resolution，resolver 输出 candidate 与旧 Lock 的差异，但在显式接受前不修改 Lock 或 activation；
10. source retarget / integrity 的 fatal trust 处理由 #9 负责，不能作为普通 solver fallback 隐藏。

Git ref 同理：Manifest/Project Intent 可以保存 `main` 等 requested ref，但已有 Lock 固定的是 exact commit；只有 initial resolution 或显式 update 才重新解析 ref。

如果 Package 没有 Manifest，不产生新的 transitive version constraints。

## 8. Dependency graph

Skill dependency 只来自可选 Manifest：

```toml
[dependencies]
"owner/repo/helper" = "^1.0"
```

没有 Manifest：

```text
Skiloom graph node has no declared outgoing Skill edges
```

Skiloom 不从 `SKILL.md` 自然语言、目录名称或引用文件中猜测结构化 dependency。

Dependency graph v0 允许 cycle：

```text
A -> B -> C -> A
```

cycle 本身不是 resolution error。Resolver 保存全部 exact edges，并通过 visited/expanded Package state 避免无限展开；只有 cycle 中形成的 repository source/version constraints 无法满足时才报告真正的 resolution conflict。

## 9. 同名 Skill 与扁平 activation

Package Resolver 仍允许不同 source 存在同名 Package：

```text
A/repo/foo
B/repo/foo
```

它们的 Package coordinate、source provenance 与 Store content identity 都可以独立共存。

但项目 executor-visible 安装面固定为扁平：

```text
.agents/skills/<activation-name>
```

因此两个 Package 若默认都要激活为 `foo`，会在 activation plan 阶段产生 `ActivationNameConflict`。这不是 Package resolution 冲突，而是项目本地 runtime name 冲突；必须由用户为新安装项明确 rename，或放弃本次操作。

## 10. Repository-wide install

用户安装：

```text
owner/repo@1.4.0
```

Release 模式：

1. 取得 Release source snapshot；
2. discover 全部合法 `SKILL.md` Package Roots；
3. 全部作为顶层选择；
4. 对存在 Manifest 的 Package 展开 dependency closure。

Git 模式：

```text
owner/repo@main --git
```

同理，只是 source 来自 cached Git exact commit。

Repository-wide target 只作为用户顶层意图；Manifest dependency 必须精确到 `owner/repo/package`。

## 11. Resolution / Plan 输出边界

Class R candidate resolution 至少包含 exact repository bindings、Package identities/content digests 与 manifest-declared edges。Reference manager 随后可以在同一个 Install Plan 中附加 activation 与 Host Observation 计划；后两者不属于 Class R selection semantics。

组合后的 reference plan 至少包含：

```text
repositories:
  exact release/tag/commit or exact git commit

packages:
  owner/repo/package
  package-root
  content digest

activation:
  default name = SKILL.md.name
  explicit project rename from .agents/.skiloom/skiloom.toml [renames] when present

edges:
  manifest-declared exact dependency edges（只保存 owner/repo/package）

common software requirements:
  optional manifest [software]（用于 dependency checking，不复制进 skiloom.lock）

warnings:
  optional dependency checks still requiring Agent inspection
```

## 12. Install Plan

### Source fetch

- 哪些 Release repository source snapshot 需要取得；
- 哪些 Git cache 需要 clone/fetch；
- 哪些 Store snapshot 已存在可复用。

### Discovery

- 每个 repository snapshot 发现哪些 `SKILL.md` roots；
- root `skiloom-repo.toml`（若存在）的 include/exclude 过滤结果；
- selector 最终匹配哪个 relative path；
- 是否有重名或非法 frontmatter；nested Package Root 本身允许存在。

### Verify

- Release/Git source provenance 与 exact commit；
- source materialization safety；
- `SKILL.md`；
- optional `skiloom-package.toml`；
- optional `DEPENDENCIES.md`；
- Package Snapshot path/file-type portability；
- independently discovered nested Skill Roots 已从祖先 snapshot 裁掉；
- executable bool 来自 source snapshot Git mode；
- `SKILOOM-PACKAGE-V1` canonical `content-digest`。

### Activate

先对完整 resolved graph 做扁平 activation preflight：

```text
.agents/skills/<activation-name>
```

默认 activation name 等于 `SKILL.md.name`。如果计划内两个 Package 或已有未知 Skill 占用同名路径，返回 `ActivationNameConflict`，交互模式让用户为新安装项 rename 或放弃；非交互模式没有预配置 rename 时直接失败。

用户批准的 rename 写入 `.agents/.skiloom/skiloom.toml [renames]`。未 rename Package 可直接链接 Store；rename Package materialize 项目本地合法 Skill view，并保持原始 Store `content-digest` 不变。当前 managed activation state 写入 `.agents/.skiloom/activation.lock`。

### Dependency check

只有存在 `[software]` 才运行对应 common probes；只有存在 `DEPENDENCIES.md` 才提示 Agent 存在特殊依赖说明。检查结果写 `.agents/.skiloom/dependencies.lock`。

## 13. 执行顺序

### 已有匹配 Lock 的 `sync`

```text
parse Project Intent
  -> verify Requirement Set matches Confirmed Resolution
  -> read exact repositories/packages/edges from Lock
  -> obtain only the exact locked source/content needed for restore
  -> verify/materialize immutable Store entries
  -> preflight flat .agents/skills activation names
  -> reconcile .agents/skills + .agents/.skiloom/activation.lock
  -> run common probes
  -> update .agents/.skiloom/dependencies.lock
```

不调用版本选择器，也不产生新的 Lock。

### Initial resolution / explicit `update`

```text
parse Project Intent
  -> resolve release / explicit git sources
  -> obtain candidate exact repository snapshots
  -> discover SKILL.md roots
  -> read optional Package metadata
  -> expand dependency closure
  -> build candidate resolution + activation plan
  -> compute/verify canonical Package Snapshots
  -> show candidate or diff against current Confirmed Resolution
  -> explicit accept
  -> atomically materialize/reconcile Store + activation
  -> atomically write new .agents/.skiloom/skiloom.lock
  -> run/update dependency observations
```

若 candidate 未被接受，不修改原 Lock 或现有 activation。

## 14. Frozen / offline

`frozen`：要求 Lock 已存在，并比较当前 Project Intent 的 canonical Requirement Set 与 Lock 中 `[[requirement]]`。Lock 缺失或语义不一致时直接失败；一致时只接受 Lock 的 exact source snapshot、package-root、content digest 和 graph，永不创建/更新 Lock。`[renames]` 由 activation reconciliation 单独应用。

普通 `sync` 在“已有且匹配 Lock”时同样 lock-preserving；Frozen mode 的额外约束是禁止 initial resolution 和任何新 Confirmed Resolution 的接受路径。

`offline`：不访问 GitHub、不 fetch Git；只能使用本地 cache/Store 与 Lock。

当 Store 已有需要的 Package snapshot 时，即使 Git source cache 被 GC，也能离线激活；如果 Store 缺失而只剩 Lock，没有对应 source cache/archive，则 offline 失败。

## 15. remove / orphan / why

删除顶层 target 后重新计算 manifest-declared dependency closure。不可达 Package 对应的 Skiloom-managed `.agents/skills/<activation-name>` 按 `.agents/.skiloom/activation.lock` 安全移除；Store 进入独立 GC 候选。

`why owner/repo/package` 从 Lock graph 反向构造路径。

## 16. 结构化错误

至少区分：

- `InvalidReleaseRequirement`；
- `UnavailableRelease`；
- `UnsatisfiableReleaseRequirements`；
- `UnresolvableDependencyGraph`；
- `AmbiguousReleaseVersion`；
- `AmbiguousReleasePrecedence`；
- `ReleaseRetargeted`；
- `UnavailableGitRef`；
- `PackageNotFound`；
- `AmbiguousPackageDiscovery`；
- `InvalidSkillMetadata`；
- `InvalidOptionalManifest`；
- `InvalidGitHubCoordinate`；
- `RepositoryCoordinateChanged`；
- `SourceAccessUnavailable`；
- `ReleaseTagNotCommit`；
- `RepositorySourceConflict`；
- `ProjectIntentLockMismatch`；
- `FrozenRequirementMismatch`；
- `UnsupportedPackageFileType`；
- `InvalidPackagePath`；
- `PackagePathCollision`；
- `PackageContentDigestMismatch`；
- `CorruptStoreEntry`；
- `ActivationNameConflict`；
- `InvalidActivationName`；
- `ModifiedManagedActivation`；
- `UnsafeSourceSnapshot`；
- `OfflineSourceUnavailable`。