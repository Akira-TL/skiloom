# Skiloom 领域词汇

## Skill Package

Skiloom 的最小安装、缓存与依赖解析单位。一个 Skill Package 恰好对应一个标准 Agent Skill；Package Root 与 Skill Root 重合，最低条件只有合法 `SKILL.md`。

## Package Name

GitHub repository 内的局部 Package 名称，例如 `ask-matt`。它以 `SKILL.md.name` 为唯一 source of truth，并应等于 Package Root basename；不承担全局唯一身份。

## GitHub Package Coordinate

Skiloom v0 的 GitHub Package Coordinate 是 `<owner>/<repo>/<package>`；用户顶层 target 可以省略 `package` 表示 repository-wide requirement，并另外附加 Release requirement 或 explicit Git ref。GitHub `owner/repo` 在 Core semantic comparison、resolver grouping、dependency edge 与 canonical Lock 中统一使用 ASCII lowercase；case-only 差异不产生新 source identity。

## GitHub Release Version

Release source 中的 repository 级版本作用域。v0 只接受 SemVer；GitHub tag 可以使用可选前导 `v`，例如 `v1.4.0` 规范化为 `1.4.0`。Release version 最终锁定实际 tag 与 exact commit，再在该 repository snapshot 中 discovery Skill Package。

## Release Version Requirement

Class R 对 GitHub Release repository version 的约束语言。v0 使用 Cargo-style default/caret/tilde/wildcard/comparison/comma-intersection semantics；不支持 npm `||` / hyphen range / whitespace-as-AND。多个同 repository requirement 共同约束同一个 exact Release snapshot；explicit Git binding 时同 repository Release range 不参与 commit selection。

## Git Source

没有合适 Release 或明确需要源码版本时显式使用的 source。用户 ref 最终解析为 exact commit；Package path 在该 commit 的 tracked tree 中通过 `SKILL.md` discovery 获得。

## Git Source Cache

机器级、可丢弃的 Git repository object cache，用于复用 clone/fetch 成本和读取 exact commit。项目不直接链接它；删除 cache 不破坏已经写入 Package Store 的 Package snapshot。

## Repository Discovery Control

Repository root 中可选的 `skiloom-repo.toml`。它只通过 repository-relative Package Root `include` / `exclude` 过滤 `SKILL.md` discovery 结果；没有该文件时默认全仓发现。`exclude` 优先于 `include`；v0 pattern 只支持 literal、`*`、`**`、`?`。它不定义 Package name、version 或 dependency，不能把没有合法 `SKILL.md` 的目录变成 Package。不同名称的 nested Skill Roots 可以同时被发现；只有最终 Package Name 重复才构成歧义。

## Router Skill

负责指导 Agent 在一组能力之间路由的普通 Skill Package。Skiloom 不为 Router 定义特殊 Package 类型；若存在可选 Manifest，其 Skill dependencies 可以形成 Router 的自动安装闭包。

## Release Source Snapshot

GitHub SemVer Release 解析得到的 actual tag + exact commit 对应 repository snapshot。Skiloom v0 不定义 per-Skill Release Asset；Release 只负责稳定选择 source snapshot，Package discovery 与 Git source 共用同一管线。

## Package Manifest

Package Root 中可选的 `skiloom-package.toml`。Schema 1 的 `[dependencies]` 进入 Skiloom 的 Skill dependency graph；`[software]` 是同一物理 Manifest 中已登记的宿主环境观察信息。Manifest 不复制 `SKILL.md.name` 或 GitHub Release version；不支持某项环境观察能力不会使 otherwise-valid Package 失去安装资格。

## Dependency Check File

Package Root 中可选、不可变的 `DEPENDENCIES.md`。它是 Package author 提供给 Agent 的特殊软件/环境依赖检查说明，只描述 requirement、检查方法与处理边界；不保存当前宿主状态。

## Dependency Observation State

Skiloom 保存的可删除重建的本机环境观察状态。它只记录当前机器的 dependency observations；Package `content-digest` 是唯一 freshness anchor，不复制 requirement、`DEPENDENCIES.md` digest、检查时间或授权信息。Skiloom 维护 common software observations，Agent 维护 special observations；其 SQLite/table/file 物理存储属于官方实现细节，不是公开产品格式。

## Skill Dependency

可选 Package Manifest 中显式声明的对另一个 Skill Package 的依赖。GitHub 模式使用 `<owner>/<repo>/<package>` 定位目标并附加 Release version range；运行时共享能力必须通过 Skill Dependency 表达，而不是跨 Package 文件共享。

## Direct Install Requirement

用户对某个 Target 主动提出的 top-level Skill 安装要求。Release 安装可以显式保存 Package coordinate + version requirement，也可以不指定版本；显式版本要求在后续更新中继续作为约束，不指定版本则表示更新时允许选择当前可解析到的最新合法版本。Git 安装保存 Package coordinate + requested ref。普通安装的 Machine Registry 保存完整当前状态，而 Target Recovery Marker 只保留这些 direct roots，不展开传递依赖。

## Resolved Graph

Skiloom 根据 Direct Install Requirement、exact repository source snapshots、`SKILL.md` discovery 与可选 Manifest 求出的完整已知 dependency graph。没有 Manifest 的 Skill 是合法 leaf node；Skill dependency cycle 本身合法，只要 repository source/version constraints 可以形成完整 deterministic resolution。

## Package Snapshot

从一个已选 Skill Root materialize 出来的不可变 Package 内容边界。若其中包含另一个已经进入最终 discovery set 的 nested Skill Root，则该 nested Root 从祖先 Package Snapshot 中裁掉并独立 snapshot；被 discovery filter 排除的 nested `SKILL.md` 仍作为普通内容保留。

## Package Content Digest

Package Snapshot 的 canonical 内容身份。v0 使用 `SKILOOM-PACKAGE-V1`：只允许 regular files，按 relative path 的原始 UTF-8 bytes 排序，只编码 path、executable bool、file size 与 exact bytes 的 SHA-256；时间戳、owner/group、普通权限和 archive metadata 不参与。最终表达为 `sha256:<64 lowercase hex>`。

## Exact Installation Resolution

某个 Target Identity 当前已经接受、并保存在 Machine Registry 中的完整精确解析结果，包括 canonical repository/source provenance、Release actual tag / exact commit 或 Git exact commit、实际 Package Root、Package Content Digest 与 exact dependency edges。它既是日常管理的精确状态，也是下一次安装或更新候选的比较基线；旧状态只参与差异与授权判断，不影响 resolver 的候选排序。

## Installation Candidate

安装、更新或数据库丢失后的恢复重新解析出的完整 Target 候选状态。已有 Target 以 Machine Registry 的 Exact Installation Resolution 为比较基线；第一次安装或数据库丢失恢复没有精确旧基线。操作请求只触发候选计算，不等于接受结果；只有完整候选经用户或策略接受后才能成为新的精确安装状态。

## Source Authorization

对一次完整 Installation Candidate 的来源集合与精确绑定作出的接受决定。界面可以突出新增、移除或变化的来源差异，但授权对象始终是完整候选；Skiloom 不维护脱离当前安装状态的永久来源白名单，已经消失的来源日后重新进入依赖图时必须重新进入候选授权。

## Package Store

机器级共享的不可变 Skill Package Snapshot 存储，直接以 Package Content Digest 作为 key。Skiloom 官方实现把 Store 放在用户自己的 `~/.skiloom/` 内部管理空间中，不把 Store 直接暴露为宿主 Skill 目录。不同 repository/source 只要 snapshot 内容完全相同就复用同一 Store entry；source provenance 保存在 Machine Registry 的 Exact Installation Resolution 中，需要传播时进入显式 Reproducible Export，不进入 Store key。宿主环境检查状态不写回 Store。

## Target

Skiloom 安装 Skill 时的宿主可见目标目录。官方默认工作区 Target 为 `<workspace>/.agents/skills`，默认用户级/全局 Target 为 `~/.agents/skills`；Host preset 或用户显式 `--target` 可以选择其他目录。`.agents/skills` 是默认安装面而不是 Package Store，Target 内按 `<target>/<activation-name>` 平铺 Skill。

## Target Installed Graph

一个 Target 的统一已接受依赖图，由该 Target 全部 Direct Install Requirements 的 resolved dependency closure 并集组成；同一 Package coordinate 在同一 Target 只能有一个 resolved identity 和一个 projection name。安装、移除、更新都以整个 Target graph 为一致性边界；更新不提供只刷新某个局部依赖闭包的模式，而是按照所有直接安装要求重新解析整个图，使系列 Skill、共享依赖和传递依赖保持同一批次的一致状态。

## Host Projection

把 immutable Package Store 中的 Package materialize 到用户选择的 Target，使目标软件能够发现和使用 Skill。普通无变换 projection 使用 link/junction 指向 Store；只有 rename、dependency routing 等 Skiloom 可确定性重建的变换才使用 managed transformed copy。用户自定义修改不属于 managed projection。

## Managed Transformed Projection

Skiloom 为 rename 或 dependency routing 等确定性变换生成并继续全权管理的 copy。它可以从当前 accepted Package Snapshot 与 Target projection metadata 重建并自动更新；底层虽是 copy，但不表示用户拥有本地编辑权。

## Detached Override

用户显式把一个 managed projection 原地转换成普通本地 copy 后形成的 user-owned dependency override。它继续占据原 Package coordinate 在该 Target 的 dependency slot 并可被宿主发现，但其 bytes 退出 Skiloom content ownership；Skiloom只保留 detach 时的 baseline provenance 用于诊断与提醒，后续相关 update 必须提示用户自行适配，不能自动覆盖、合并或宣称本地内容满足新的版本约束。

## Activation Rename

对 resolved Package 的 projected Skill identity 改名。Rename 不改变 Package coordinate、source resolution 或 Package Store `content-digest`；Skiloom 用 Managed Transformed Projection 同步修改目录名与顶层 `SKILL.md.name`，并继续自动更新该 projection。为灾难恢复，非默认 rename 作为稀疏 projection override 写入 Target Recovery Marker。

## Dependency Routing Overlay

当某个 declared Skill Dependency 在 Target 中使用非默认 projection name 时，Skiloom 对其直接 reverse dependents 生成确定性的 Agent-facing routing metadata，使依赖者明确看到该 dependency 的 package identity、原始 Skill name 与实际 projected name。该 overlay 只解决 capability routing，不把 Target 目录名或跨 Package 文件路径变成稳定 ABI。

## Target Identity

每个 Skiloom-managed Target 都有一个写入 `.skiloom-state` 的 opaque random `target-id`，它标识一组可同步的 Target 安装状态，不表示项目、仓库或 worktree 身份。Machine Registry 维护该身份的当前 exact installation state；文件系统中的旧副本再次被操作时必须显式选择同步到该身份的当前状态，或分叉为新的 `target-id`。

## Target Generation

一个 Target Identity 当前 accepted installation state 的单调递增 revision。Machine Registry 保存当前 generation，`.skiloom-state` 保存该目录副本最后同步的 generation；落后的副本只能单向同步到当前状态，或分叉为新的 Target Identity。

## Target Recovery Marker

每个 Skiloom-managed Target 根目录中的 `.skiloom-state` 轻量恢复锚点。它记录 `target-id`、Target Generation、用户直接安装的 top-level roots，以及恢复目标侧语义所需的 rename、managed transform 与 Detached Override 等稀疏标记；不展开 transitive dependency graph，也不保存用户修改后的 bytes。Machine Registry 丢失时，Skiloom 可从这些 roots 重新解析依赖并形成新的 recovery candidate，同时不得覆盖 marker 声明的 user-owned override。

## Package Store GC Boundary

Skiloom v0 不执行 destructive automatic Package Store GC。移除某个 projection 或 Direct Install Requirement 不直接删除共享 Store entry；Git Source Cache 可以独立做 LRU/size/age pruning。SQLite 不维护项目 registry，因此未来若要 destructive Store GC，必须另行设计不依赖隐式项目路径追踪的安全可达性/引用证明机制。

## Common Software Requirement

可选 `skiloom-package.toml [software]` 中声明的、Skiloom 内建只读 probe 能基础发现的常见软件要求。Skiloom 只检查并记录状态，不负责安装、升级或修复。

## Special Dependency

可选 `DEPENDENCIES.md` 中描述的复杂软件、硬件、服务、数据、驱动、授权或其他环境要求。由 Agent 检查；需要修改环境时必须先向用户说明并取得明确批准。

## Install Plan

在安装/同步前形成的 source 获取、Skill discovery、Package snapshot、Store 变化、Target projection preflight/rename 以及依赖检查计划。Skiloom 不把缺失宿主软件自动转换为系统安装动作。

## Skiloom Public Namespace

Skiloom v0 的公开 token 是 `skiloom`：CLI 为 `skiloom`，Package/Repository optional metadata 为 `skiloom-package.toml` / `skiloom-repo.toml`，公开 Package Snapshot format identifier 为 `SKILOOM-PACKAGE-V1`。普通安装不要求项目级 `skiloom.toml` / `skiloom.lock`；目标目录用 `.skiloom-state` 保留轻量恢复锚点，完整机器安装状态由 Skiloom Home 的 Machine Registry 管理。`.agents/skills` 等宿主目录只是 Target。旧 `AKM / akm` 只属于 pre-standard working draft，不形成 v0 compatibility alias。

## Official Product Contract

Skiloom 当前最高产品权威，定义官方产品必须遵守的安装、解析、状态、Target、恢复、来源确认与导入导出行为，以及稳定公开的数据格式。它不建立第三方实现的兼容等级或 conformance class；第三方若要兼容，应适配 Skiloom 已公开的行为与格式。

## Official Implementation Architecture

Skiloom 官方实现使用 Node.js + TypeScript + npm 作为主控制面与发行方式：Node.js >=22，开发/release 主线为 Node 24 LTS，公开 npm package / executable 均为 `skiloom`。复杂计算或底层热点允许使用预编译 Rust/C/C++ 等 standalone native helper，但它们只能位于窄的内部 seam 后，不能独立拥有网络、凭据、用户授权、Machine Registry 写入或 Target destructive mutation；产品行为权威是 Skiloom 官方产品规范与官方行为测试数据。

## Machine Registry

Skiloom Home 中的 machine-local SQLite 状态库，是普通安装日常管理的完整机器 authority：保存 accepted exact resolution、Target Identity/Generation 与 projection ownership 等机器状态；Package Store 独立负责 immutable content identity，live filesystem 只提供可验证观察，Target Recovery Marker 只提供恢复线索。同步或修复严格恢复这里已经接受的精确状态而不重新解析；安装、更新和数据库丢失后的恢复才允许形成新的 Installation Candidate。它不登记项目身份、不建立项目 registry，也不引入 `project.id`。

## Catalog

用于发现和比较 Skill 的外部目录层。Catalog 可以提供候选、展示元数据与质量/安全信号，但不能成为 Skiloom v0 source/version/content authority；进入安装解析前必须归一成可验证的 source candidate。

## First-party Skill Suite

Skiloom 自己发布的标准 Skill Packages，用于让 Agent 发现、管理、诊断和创作 Skills。它们走与第三方 Package 相同的 source、resolution、Store、Target projection 与 ownership 流程，不拥有系统级特权路径。

## Reproducible Export

用户显式生成的可传播 Skill 环境产物，用于跨机器或 CI 恢复一个状态一致的 Target。导出分为“依赖导出”和“完整导出”：两者都包含 TOML 精确清单以及全部 Skiloom 受管 Package 的实际内容；完整导出另外封装 Detached Override 与其他未受管 Skill 的当前内容；改名、依赖路由等可确定性重建的受管变换只记录规则，不额外封装变换后的副本字节。所有封装内容都必须通过摘要校验，因此导入可以离线完成；导入到新环境时重新选择 Target 并取得新的 `target-id`，允许在明确提醒后与已有不冲突 Skill 合并，但同名或同路径冲突必须失败。

## Agent Bootstrap

把 First-party Skill Suite 显式安装到用户选择 Target 的首次启用过程。npm 安装本身不修改任何 Skill Target；bootstrap 经一次明确授权后，后续 Agent 可以通过已安装的 Skiloom Skills 无感编排 Skiloom，但 source/graph 变化仍受普通 candidate acceptance 约束。
