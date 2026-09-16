# Skiloom v0 官方产品规范

状态：Accepted

对应 Issue：#28 `Supersede pre-shift specs with the official Skiloom product contract`

本文件是 Skiloom v0 当前产品行为的统一权威。它描述 Skiloom 自己必须遵守的产品规则、公开数据格式与安全边界；不建立第三方实现兼容等级、认证体系或 conformance class。第三方若选择兼容 Skiloom，应适配这里公开的行为和格式。

## 1. 产品边界

Skiloom 是面向 Agent Skill 的安装、依赖解析、目标目录管理、恢复与可传播环境打包工具。

v0 只把标准 Agent Skill 作为 Package：

- 一个合法 `SKILL.md` Skill Root 就是一个 Skill Package；
- `Package Root == Skill Root`；
- 一个 Package 恰好一个 Skill；
- Package Name 只来自 `SKILL.md.name`；
- `skiloom-package.toml` 始终可选；没有它的 Skill 仍是合法 leaf Package。

Skiloom v0 不把 prompts、agents、commands、hooks、MCP、plugin 等其他 Agent primitive 扩展成 Package 类型，也不允许 Package metadata 获得任意 install/build/postinstall 脚本执行能力。

## 2. 公开产品格式

以下内容属于 Skiloom 对外产品契约，必须由当前产品规范或其专门格式规范定义：

- `SKILL.md`（其基础合法性来自 Agent Skills Specification）；
- `skiloom-package.toml`；
- `skiloom-repo.toml`；
- `DEPENDENCIES.md`；
- 目标目录根部的 `.skiloom-state` v1（`SKILOOM-STATE-V1`）；
- 精确导出包及其中的 `skiloom-export.toml`；
- Package Snapshot 格式 `SKILOOM-PACKAGE-V1`；
- GitHub Repository / Package Coordinate；
- Release Version Requirement 语法与语义；
- CLI machine-output envelope `SKILOOM-CLI-V1`。

以下内容属于 Skiloom 官方实现细节，不作为公开持久化格式承诺：

- 本机 SQLite 文件的绝对路径、表结构与迁移方式；
- Git Source Cache 的物理目录；
- Package Store 的物理目录布局；
- 临时目录和原子切换的内部路径；
- Node.js 内部模块边界与调用链；
- CLI 的具体自然语言文案、颜色/表格布局、spinner、进度显示与网络重试策略。

## 3. Repository discovery 与 Package Snapshot

对一个确定的 repository snapshot：

- 默认发现其中全部合法、版本化的 `SKILL.md` Skill Root；
- 可选 `skiloom-repo.toml` 只通过 repository-relative `include` / `exclude` 过滤 discovery；`exclude` 优先；
- discovery control 不能创建没有合法 `SKILL.md` 的 Package，也不能改写 Package name、version、dependency 或 source；
- 不同名称的 nested Skill Root 可以同时存在；最终 Package Name 重复时返回 `AmbiguousPackageDiscovery`；
- 已进入最终 discovery set 的 nested Skill Root 从祖先 Package Snapshot 中裁掉；被 discovery filter 排除的 nested `SKILL.md` 继续作为普通内容保留；
- Package Snapshot 只允许 regular files，并执行既定 portable path 校验、Unicode casefold collision 检查与 raw UTF-8 path ordering；
- executable bit 来自 Git mode；时间戳、owner/group 和普通权限不进入内容身份。

Package Content Digest 使用 `SKILOOM-PACKAGE-V1`，最终形式为：

```text
sha256:<64 lowercase hex>
```

相同 Package Snapshot 不因 repository、source kind 或传输路径不同而改变 digest。Source provenance 不进入 Store key 或 Package Content Digest。

## 4. Package Manifest 与宿主环境要求

可选 `skiloom-package.toml` 当前包含 Skill 依赖与已登记的软件观察信息：

- `[dependencies]` 形成 Skill dependency graph；
- `[software]` 只描述 Skiloom 可基础只读检查的常见软件要求，不进入 Skill dependency graph；
- `DEPENDENCIES.md` 用于复杂软件、硬件、服务、数据、驱动、授权等特殊环境要求；
- 环境 requirement 不是安装、升级、登录、下载、配置或服务修改授权；需要修改宿主环境时必须另行取得用户明确批准；
- Package metadata 不允许提供任意 probe command、installer command、package-manager command、build/postinstall hook。

宿主环境观察结果可以由官方实现保存在可删除重建的本机状态中，但其物理文件位置和数据库格式不是公开产品格式。Package `content-digest` 仍是环境观察有效性的唯一 Package 内容锚点。

## 5. GitHub 来源模型

Skiloom v0 的普通来源为 GitHub repository，并明确区分：

```text
github-release
git
```

规则：

- GitHub Repository Coordinate 为 `<owner>/<repo>`；Package Coordinate 为 `<owner>/<repo>/<package>`；
- owner/repo 在语义比较中统一使用 ASCII lowercase；case-only 差异不是来源变化；
- Release source 以 repository-level GitHub Release SemVer 选择 snapshot；
- Git source 只在用户显式请求时使用，并把 requested ref 解析到 exact commit；
- 两种 source kind 不互相静默 fallback；
- 同一个 Target 的一次完整解析中，同一个 repository 只能对应一个 exact source snapshot；
- Release 只考虑 published (`draft=false`) records；SemVer authority 是 actual tag，不使用 `target_commitish` 代替 tag -> exact commit；
- GitHub `immutable` 只作为 provenance signal，不是安装准入条件；exact commit 与 Package Content Digest 始终必须存在；
- repository rename/transfer/redirect 到另一个 canonical coordinate 时返回 `RepositoryCoordinateChanged`，不自动改写来源坐标；
- Catalog 只负责发现与展示，不能在 v0 中改变 source/version/content authority；v0 默认使用 SkillsMP，只有能明确归一成 GitHub `owner/repo` 的条目才能进入安装候选，且必须重新经过 Skiloom 自己的 GitHub 来源验证。

## 6. 版本要求与完整依赖解析

Release Version Requirement 使用 Cargo-style SemVer profile：

- 支持 default/caret/tilde/wildcard/comparison/comma-intersection；
- 不支持 `||` union、hyphen range 或 whitespace-as-AND；
- 裸版本使用 caret 语义；exact version 使用 `=`；
- prerelease 使用 Cargo opt-in 语义；
- build metadata 不参与 precedence 或 matching。

同 repository 的全部 Release requirements 形成同一 constraint set。Resolver：

- 按 SemVer precedence 从高到低选择 Release candidate；
- 允许确定性 backtracking 以寻找第一个完整可行解；
- 不使用发布时间、GitHub API 顺序、tag 字典序或旧状态制造额外版本偏好；
- dependency cycle 本身合法，只要完整约束可满足；
- duplicate normalized version 或 equal-precedence ambiguity 按既定错误分类 fail closed。

一个 Target 始终只有一套统一安装依赖图。同一 Package coordinate 在同一 Target 只能有一个精确结果与一个投影名称。不同 Target 可以解析到不同结果。

## 7. 直接安装要求与更新

每个 Target 保存用户当前的全部直接安装要求。直接安装要求有两种目标：

- Package requirement：`<owner>/<repo>/<package>`，把一个明确 Package 作为直接 root；
- Repository-wide requirement：`<owner>/<repo>`，把所选 exact repository snapshot 经当前 discovery policy 发现的**全部 Package**作为直接 roots。

Package dependency edge 始终精确指向 Package Coordinate，不允许用 repository-wide requirement 表达传递依赖。

Release 直接安装要求可以：

- 显式保存版本要求；后续更新继续遵守该要求；
- 不指定版本；后续更新允许选择当前最新合法版本。

Git 直接安装要求保存目标 coordinate 与用户请求的 ref；改变来源、约束或 ref 属于显式请求。

Repository-wide requirement 在每次重新解析时都针对本次候选 exact snapshot 重新运行 discovery。因此仓库后来新增或删除合法 Skill 时，直接 root 集合可以随候选版本变化；这些增删必须作为完整候选状态的一部分展示并接受，不能在普通 sync/repair 中静默发生。

安装或更新不是局部修改某个依赖闭包。Skiloom 根据该 Target 的全部直接安装要求重新解析完整统一依赖图，使系列 Skill、共享依赖和传递依赖保持同一批次的一致状态。

旧的当前精确状态只用于比较变化和来源确认，不参与新方案的 candidate ordering。

## 8. 本机精确状态、Target 与恢复标记

Skiloom 官方实现使用本机 SQLite 状态库维护日常权威状态。产品语义要求它能够保存：

- 当前已接受的完整精确安装状态；
- Target Identity 与 Target Generation；
- 直接安装要求；
- exact repository/source provenance；
- exact Package records 与 dependency edges；
- projection name、rename、managed transform、detach 等 ownership facts。

SQLite 的表结构、路径和迁移策略不是公开产品格式。官方实现 v0 使用 `~/.skiloom/registry.sqlite3`，schema generation 使用 `PRAGMA user_version`；迁移前通过 SQLite backup API 备份到 `~/.skiloom/backups/`。数据库损坏必须返回 `RegistryCorrupt` 并 fail closed，不能通过扫描 Target 猜测原有 Package identity。

Skiloom 不是常驻多写服务。所有 install/update/remove/sync/repair/recovery/import/detach/forget、schema migration、backup restore 以及需要读取一致 Target 状态的 export 共用 `~/.skiloom/operation.lock` 的 OS 级独占文件锁。锁由操作系统持有，不能以 lock file 是否存在、PID 或 mtime 判断占用；无法取得锁时返回 `OperationLocked`。已经成功取得锁的状态型操作若在完成前失去锁能力，则返回 `OperationLockLost` 并停止继续产生新的受保护 side effect，不能静默重新取得后继续。`~/.skiloom/` 的 v0 官方支持范围是 machine-local filesystem，不建立 NFS/SMB 等网络共享 Home 的 distributed lock 语义。Target Generation 继续用于状态版本与恢复，不承担 Skiloom 多进程写入的主要并发控制职责。

Machine Registry 只长期保存当前已接受状态，不保存旧 generation 的完整安装历史。SQLite 与 Target filesystem 之间允许使用最小临时 pending-operation 记录处理进程中断；正常完成后立即删除，它不是第二份 Lock 或操作历史。

Target 是宿主可见的 Skill 目标目录。Skiloom 官方默认工作区 Target 为 `<workspace>/.agents/skills`，默认用户级/全局 Target 为 `~/.agents/skills`；已知 Host preset 与用户显式 `--target` 可以选择其他目录。`.agents/skills` 是 Skiloom 的默认公共安装面，但不是唯一合法 Target，也不是 Package Store。

每个 Skiloom-managed Target 根部具有公开 TOML 恢复标记 `.skiloom-state`。v1 格式标识固定为 `SKILOOM-STATE-V1`，完整 schema 见 [`target-recovery-marker-v1.md`](target-recovery-marker-v1.md)。它只保存：

- canonical lowercase UUID v4 `target-id`（产品语义仍是 opaque random identity）；
- 非负 Target Generation；
- Package 或 repository-wide Direct Install Requirements；
- 非默认 projection activation name；
- Detached Override 的 logical Package 与 detach 时 baseline provenance/digest。

v1 不展开完整传递依赖图、不保存 exact transitive source/version、物理 materialization、Dependency Routing Overlay 展开内容、Target/Store/cache 绝对路径、Host preset、来源授权历史、Catalog metadata、凭据或 detach 后的用户修改字节。Routing overlay 必须由恢复后的 dependency edges + projection names 确定性重建；symlink/junction/copy 由当前平台重新选择。

`.skiloom-state` 使用严格 schema：未知字段、重复条目或非法字段组合返回 `InvalidTargetState`；未知 `format` 返回 `UnsupportedTargetStateVersion`，旧程序不得猜测解析或自动降级重写。官方 writer 输出稳定 canonical TOML，Marker 仍是 machine-managed state file，不承诺保留手写注释或原始顺序。

## 9. 状态权威与同步 / 修复 / 恢复

日常权威分工：

- 本机状态库：当前已接受的完整精确安装状态；
- Package Store：不可变内容权威；
- live filesystem：当前观察结果；
- `.skiloom-state`：身份和恢复线索。

已有本机精确状态时：

- `sync` / repair 只恢复或校验已经接受的精确状态；
- 不重新解析、不枚举新版本、不改变来源。

安装、更新或数据库丢失后的恢复才允许重新解析形成完整新状态。

数据库丢失、但 `.skiloom-state` 存在时：

- marker 只提供直接安装要求和稀疏目标信息；
- Skiloom 必须重新解析完整依赖图；
- 新发现的完整来源集合必须重新确认；
- 这不是精确恢复，不能把 marker 当作旧锁文件。

Store 缺失或损坏、但本机精确状态仍存在时，Skiloom按已接受 provenance + digest 做精确 repair，不重新解析或更新。

## 10. 新状态接受与来源确认

用户发起 install/update/recovery 只表示请求计算，不等于接受最终结果。

流程为：

```text
用户提出操作
→ 计算完整新状态
→ 与当前已接受状态比较
→ 展示变化
→ 用户或显式策略接受
→ 原子应用
```

接受对象是完整新状态，差异只用于解释。

Skiloom 不维护永久来源白名单。来源确认属于每一次完整新状态：新增、移除、source kind、version/tag/commit、immutable signal 等来源变化都进入比较；已经消失的来源以后重新出现时仍需重新进入确认。

同一 Release tag 指向不同 commit 属于高风险来源漂移：sync/repair 不能接受；普通 update/re-resolution 可作为新状态明确展示并要求交互接受，无人值守默认拒绝，除非显式策略允许 release retarget。

## 11. Target 投影与所有权

Target 内使用平铺 `<target>/<activation-name>` 结构。

普通受管 Package 默认通过 link/junction 指向不可变 Store；rename、dependency routing 等 Skiloom 可确定性重建的变换可以使用 managed transformed copy。

规则：

- foreign/unknown path 冲突 fail closed；
- 不自动生成 `foo-2` 一类名字；
- rename 是 Target + Package 属性，不改变 Package coordinate 或 Store digest；
- 某个 dependency 使用非默认 projection name 时，Skiloom 只向**声明该依赖的直接反向依赖 Package**生成确定性的 Dependency Routing Overlay；不得全局猜测或改写无关 Package；
- Skill dependency 是能力依赖，不是跨 Package 路径/name ABI；Package 不得依赖 `../OtherSkill/...` 或某个 projection dirname 作为稳定接口；
- 受管 transformed copy 仍完全归 Skiloom 管理，用户不能把它当作本地编辑副本；
- managed 内容被未知修改时，不自动 merge 或 adopt；
- 移除一个直接安装要求后，从剩余直接 roots 重新计算 reachability；只移除新变得不可达且仍由 Skiloom 管理的投影，共享依赖只要仍可达就必须保留。

用户可以显式 `detach`：

- 当前内容原地变成 user-owned local copy；
- logical Package binding 继续存在；
- Skiloom 保留 detach 时 baseline provenance 供诊断、路由和恢复提示；
- 后续相关 update 只警告用户自行适配，不自动覆盖、合并或声称修改后的内容满足新约束。

如果 Detached Override 后来被用户在 Skiloom 外手动移动或改名，Skiloom 不猜测新的绑定；该 logical binding 保持 broken，直到用户显式 rebind。若 Detached Override 已不再被任何 root/dependency 需要且自身也不是直接 root，Skiloom 只移除 logical binding，绝不删除用户目录；如果它仍是直接 root，则绑定继续存在直到用户 remove/forget。

用户显式 `forget` 后释放 Skiloom 关联，字节继续作为 foreign/user-owned 内容保留。

## 12. Target Identity / Generation 与副本

同一个 `target-id` 代表一组可同步的 Target 副本，不代表项目、Git repository 或 worktree。

- 本机状态库保存该身份的当前 generation；
- 目标目录 marker 保存该副本最后同步的 generation；
- 落后副本必须显式选择单向同步到当前已接受状态，或 fork 为新的 `target-id`；
- marker generation 超前于本机状态属于回滚/恢复异常，fail closed；
- marker 丢失而数据库完整时，只在目标投影可验证为当前精确状态时允许修复 marker；否则进入 reconcile/fail-closed；
- 数据库仍记录 target-id、但路径暂时不存在时，该身份可以保持 dormant。

## 13. Package Store

Package Store 是机器级共享的不可变 Package Snapshot 存储，以 Package Content Digest 为 key。Skiloom 官方实现把机器级内部数据放在 `~/.skiloom/`，Package Store 默认位于 `~/.skiloom/store/`；Store 目录不直接作为宿主 Skill Target。相同内容可以被多个 Target 复用，并且每个 Target 独立选择 projection name / rename。

所有 Host、scope 与 Target 共用这一套 Store，不创建宿主专用 Store。

v0 不执行 destructive automatic Package Store GC。移除某个直接安装要求或 Target projection 不直接删除共享 Store entry；未来若要 destructive GC，必须另行建立安全的引用/可达性证明。

### 13.1 默认 Target 与 Host preset

没有显式 Target 或 Host preset 时，workspace scope 默认使用 `<workspace>/.agents/skills/`，user scope 默认使用 `~/.agents/skills/`。

Host preset 只是用户明确选择时的 Target 快捷映射，不是另一套安装器。v0 中 Codex、Gemini CLI、OpenCode preset 使用 `.agents/skills`；Claude preset 使用 `.claude/skills`。Target 选择优先级固定为：显式 Target > 显式 Host preset + scope > 默认 `.agents/skills`。

Host preset 不修改宿主配置，也不决定 symlink/junction/copy；通用 Target materialization 规则继续负责投影方式。详细契约见 [`host-target-presets.md`](host-target-presets.md)。

## 14. 精确导出与导入

Skiloom 提供两种单文件导出产物，两者都包含 TOML 精确清单以及 Skiloom 受管 Package 的实际内容。只有处于已协调一致状态的 Target 才能导出；stale copy、待修复 projection、marker/DB 身份异常等状态必须先 sync、repair 或 fork，不能把异常现场直接封装成精确导出。

### 依赖导出

包含：

- `skiloom-export.toml`；
- 当前全部 Skiloom-managed Package 的精确来源、版本/tag/commit、Package Root、内容摘要、依赖边、直接安装要求与必要的 Target 语义；
- 全部 Skiloom-managed Package 的实际内容。

可确定性重建的 rename / dependency routing transformed copy 不额外保存变换后字节，只保存重建规则。

### 完整导出

在依赖导出基础上另外包含：

- Detached Override 的当前用户字节；
- Target 中其他可识别、未由 Skiloom 管理的 Skill 当前内容。

完整导出只接受普通文件和目录；用户 Skill 中出现 symlink、设备文件、管道等不可移植特殊内容时明确失败，不跟随、不静默忽略。对于用户所有/未受管 Skill 自己声明但当前环境并不存在的依赖，导出不联网获取或补齐，只产生可见警告，也不把这类声明自动提升成 Skiloom resolver constraint。

### 内容完整性

所有实际封装内容都必须有摘要验证。受管 Package 继续使用 `SKILOOM-PACKAGE-V1`，不因进入 export 产生第二套 managed content identity；完整导出中的 Detached Override / 未受管 Skill 使用独立 `SKILOOM-USER-PAYLOAD-V1` portable-tree 摘要域。导入时逐项重算并验证，损坏、漏文件或摘要不匹配时失败。

### 导入语义

- import 不重新选择受管版本，不静默升级或替代；
- 导出包本身包含精确内容，因此允许完全离线导入；远端仓库、旧 commit 或旧 tag 当前不可访问不阻止从已验证包内容恢复；
- TOML 仍保留原始来源 provenance，并重新进入来源确认；
- 若联网观察到 tag retarget 等来源漂移，可以警告，但不能用远端当前内容替代包中记录内容；
- 导入到新环境重新选择 Target 并创建新的 `target-id`；
- 目标目录可以已经存在其他不冲突 Skill；继续前必须明确提醒这是合并导入，最终整个 Target 不等于原导出环境；
- 同名或同路径冲突直接失败，不自动覆盖、不自动改名；
- 完整导出中的 detach / 未受管 Skill 导入后继续归用户管理。

导出包不得携带或恢复机器本地身份/实现路径，包括原机器绝对 Target path、可复用的旧 `target-id` / generation、Package Store 物理路径、缓存/日志路径或任何凭据。来源 provenance、Package 内容身份和必要 Target 语义可以传播，但新环境必须建立自己的 Target Identity。

v1 单文件扩展名为 `*.skiloom-export`，外层 format identifier 为 `SKILOOM-EXPORT-V1`。Container 使用未压缩、确定性的顺序二进制 framing：`SKILOOM-EXPORT-V1\0` magic、little-endian manifest length、UTF-8 `skiloom-export.toml`，随后为按 payload/path 稳定排序的 regular-file frames。Manifest 严格记录 Direct Install Requirements、exact sources、managed Packages、dependency edges、projection names，以及 full mode 才有的 detached/user-owned records；未知字段、非法组合、frame/payload 不一致或摘要错误 fail closed。Dependency Routing Overlay 与 symlink/junction/copy 等物理 materialization 不进入导出物，而由 exact graph + projection name 或当前平台规则重建。完整公开 schema 与 framing 见 [`exact-export-package-v1.md`](exact-export-package-v1.md)。

## 15. 已退役的 pre-v0 模型

以下概念不再是 Skiloom v0 当前产品模型：

- Project Intent 文件；
- Project Lock / canonical Lock；
- `activation.lock`；
- 把 `.agents/skills` 视为唯一且不可替换的项目激活目录；
- frozen replay 作为公开产品模式；
- Class P / Class R / Class A；
- Full Core Manager；
- 第三方 conformance / compatibility certification。

历史 ADR 和旧 design 文档可以保留用于解释设计演进，但凡与本规范冲突，以本规范和后续明确更新的官方产品规范为准。

## 16. Catalog 发现层

Skiloom v0 默认内建 SkillsMP 作为 Catalog discovery provider，但 Catalog 不属于安装来源。Catalog 搜索结果必须先归一成 GitHub `owner/repo` 与可选 Skill path hint，再由 Skiloom 重新执行 GitHub source resolution、Package discovery、snapshot、digest、resolver 与来源确认。

Catalog 的 stars、installs、评分、安全扫描、分类等信号只用于搜索排序和展示，并保留 provider provenance；它们不能影响版本选择、来源接受、Package Content Digest、当前已接受的精确安装状态或精确导出/导入。Catalog 自己的 version、hash、snapshot、zip/download 也不能直接进入 v0 安装流程。

没有可验证 GitHub provenance 的 Catalog 条目可以展示但不能直接安装。Catalog 超时、限流、认证失败或 API 变化不能影响明确 GitHub coordinate 的 install/update/sync/repair。

v0 不默认自动聚合多个 Catalog，也不建立第三方 Catalog Provider SDK；未来新增 provider 必须继续遵守发现层边界。

## 17. 第一方 Skill Suite 与 Bootstrap

Skiloom v0 提供五个第一方标准 Skill Package：`skiloom`、`skiloom-discover`、`skiloom-manage`、`skiloom-doctor`、`skiloom-author`。它们与第三方 Package 使用完全相同的 discovery、source、resolver、Store、Target projection 与 ownership 规则，不形成第一方专用安装权限。

`skiloom` 是 Router Skill，通过普通 Package dependency 显式依赖另外四个 specialist，并根据用户意图进行委托。Router 不是 resolver、dependency routing 或 CLI/runtime 正确性的前提；每个 specialist 也可以独立作为 direct root 安装。

职责边界为：

- `skiloom-discover` 负责 Catalog/GitHub 发现、候选解释与来源提名，不修改 Target；
- `skiloom-manage` 把 Agent/用户管理意图映射到统一 Skiloom CLI/runtime；
- `skiloom-doctor` 默认只读诊断，任何修复重新进入普通 sync/repair/recovery/manage 路径；
- `skiloom-author` 创建/检查标准 Skill 与 Skiloom metadata，不拥有特殊发布或安装能力。

Bootstrap 本质是一次用户显式发起的普通 Router direct install，一次只处理一个用户选择的 Target，并继续使用“显式 Target > 显式 Host preset + scope > 默认 `.agents/skills`”的 Target 选择规则。默认 bootstrap 不使用 repository-wide install，因此官方 repository 后来新增其他 Skill 时，不会仅因 discovery 到新 Package 就自动进入现有 Suite；Suite 扩展必须通过 Router dependency 变化进入普通 update candidate 和 acceptance。

`npm install -g skiloom` / `npx skiloom` 本身不得修改任何 Skill Target，也不得通过 postinstall 或首次运行副作用静默 bootstrap。第一方 Skill 不能直接写 Machine Registry、修改 Store、绕过 `operation.lock`、自动接受来源/Release retarget 或取得普通 Package 之外的隐藏 Target 写权限。

Suite 启用后的 update/remove/sync/repair/detach/rename 等生命周期全部沿用普通 Target 规则。详细契约见 [`first-party-skill-suite-bootstrap.md`](first-party-skill-suite-bootstrap.md)。

## 18. 官方实现技术栈

Skiloom 官方实现继续采用：

- Node.js >= 22；开发/release 主线 Node.js 24 LTS；
- TypeScript strict + ESM；
- npm package / executable `skiloom`；
- Node 层拥有 CLI、GitHub access、credentials、状态接受、Store/Target side effects 与用户交互；
- `operation.lock` 使用一个预编译 mandatory Rust standalone helper `skiloom-lock` 提供跨平台 OS file lock capability；
- 真实计算热点仍可按 benchmark 使用可选预编译 Rust/C/C++ standalone helper；
- native helper 不拥有网络、凭据、用户授权、本机状态库写入或 Target destructive mutation；
- 不在安装时要求用户现场编译 native code，不预先设计通用 native provider/plugin framework；
- `~/.skiloom/` 是 machine-local Skiloom Home，v0 不承诺 NFS/SMB 等网络/分布式挂载上的 Machine Registry 锁语义。

官方行为测试数据用于验证上述产品规则与算法，不承担第三方实现认证含义。

## 19. CLI、候选接受与机器输出

Skiloom v0 使用一组 canonical CLI commands：`search`、`status`、`doctor`、`validate`、`install`、`update`、`remove`、`rename`、`sync`、`repair`、`detach`、`rebind`、`forget`、`recover`、`fork`、`export`、`import`、`bootstrap`。v0 不维护 `add/rm/fix/upgrade` 等同义 alias，也不提供 `--force` 绕过完整性或 ownership 检查。

`install/update/remove/recover/fork/import/bootstrap` 都属于完整 Candidate 操作，并统一支持 `--plan`：只计算、验证和展示完整 candidate，不接受、不写 Machine Registry、不修改 live Target。non-interactive 执行若 candidate 需要提交，必须显式 `--yes`；`--json` 自动禁止 prompt，但不隐含 `--yes`。Release tag retarget 还需要显式 `--allow-release-retarget`，merge import 还需要显式 `--merge`；v0 不把这些授权持久化成长期 source whitelist 或 policy profile。

`sync/repair` 只恢复当前已接受 exact state，不重新解析，因此不再次要求接受当前状态。`rename/detach/rebind/forget` 是用户显式局部状态操作，命令本身提供该局部授权，但仍必须经过 `operation.lock`、ownership preflight、Machine Registry transaction 与 DB-first Target materialization。

Target CLI 选择固定为互斥的显式 `--target <path>` 或 `--host codex|claude|gemini|opencode` + `--scope workspace|user`；未指定时以当前工作目录为 workspace context，默认 `<cwd>/.agents/skills`，v0 不自动搜索 Git repository root。

Agent/CI 使用 `--json` 得到一个 `SKILOOM-CLI-V1` JSON document，固定 envelope 为 `schema`、`ok`、`command`、`result|error`、`warnings`；具体产品错误通过 `error.code` 表达。Shell exit code 只保留少量类别：`0` success/no-op、`1` product/runtime failure、`2` invalid argv、`3` approval absent/declined/`InteractionRequired`、`130` SIGINT。完整命令、参数与交互规则见 [`cli-surface-v0.md`](cli-surface-v0.md)。
