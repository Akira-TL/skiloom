# Skiloom v0 版本开发路线

状态：Planning

对应：`docs/planning/skiloom-v0-implementation-plan.md`

本文件只定义 v0 开发阶段的版本节奏与主要功能落点，不引入复杂 release channel、长期兼容承诺或额外版本层级。产品行为仍以 `docs/design/skiloom-v0-product-contract.md` 和后续 Accepted 公开格式规范为准。

## 1. 版本规则

Skiloom v0 从 `0.1.0` 开始。

规则保持简单：

- `0.x.0`：一个主要功能第一次形成完整、可验证的能力边界；
- `0.x.y`：该主要功能下的分支功能、补全、修正与硬化；
- 不为每个 commit、每张 ticket 或每个内部 module 单独发版本；
- v0 阶段不额外引入 alpha/beta/rc 版本制度；确有发布需要时再单独决定，不提前标准化；
- `1.0.0` 不在本路线中自动发生，必须在 v0 能力完成并经过单独 release review 后另行决定。

版本号表达的是用户或开发者可验证的能力进展，不表达内部代码量。

## 2. `0.1.x` — 领域基础与内容身份

### `0.1.0` — Repository Foundation + Domain Kernel

首次建立可运行的 Node.js / TypeScript 工程和离线行为测试基础，完成：

- structured product errors；
- GitHub Repository / Package Coordinate；
- `SKILL.md` Package admission；
- `skiloom-package.toml` / `skiloom-repo.toml` parser；
- repository discovery；
- `SKILOOM-PACKAGE-V1` snapshot / digest；
- Release Version Requirement parser / canonicalization。

完成标准：Package、discovery、snapshot、digest、requirement 都能在完全离线 fixture 下稳定运行。

### `0.1.x` 分支功能

按实际实现顺序使用 `0.1.1`、`0.1.2`……补充：

- metadata 边界与错误事实；
- portable path / casefold / executable mode 边界；
- requirement prerelease/build metadata 边界；
- fixture 扩充和缺陷修正。

不预先给每一个 patch 号绑定固定 ticket；实际交付时顺序递增即可。

## 3. `0.2.x` — Deterministic Resolver

### `0.2.0` — Whole-target Resolver

完成完整 Target 依赖图求解：

- repository-scoped constraints；
- Package direct requirement；
- repository-wide direct requirement；
- deterministic highest-first backtracking；
- cycle-safe graph expansion；
- duplicate/equal-precedence ambiguity；
- exact dependency edges。

### `0.2.x` 分支功能

逐步补充：

- candidate comparison；
- source added/removed/kind/version/tag/commit diff；
- deterministic source origin path；
- Release retarget 风险分类；
- resolver benchmark 与必要时的 native accelerator gate。

Resolver correctness 先于 native 优化。

## 4. `0.3.x` — Store 与 Machine Registry

### `0.3.0` — Immutable Store + Accepted State

首次把离线计算结果可靠持久化：

- `~/.skiloom/store/` immutable content-addressed Store；
- `registry.sqlite3` 当前已接受状态；
- direct requirements；
- exact sources / packages / dependency edges；
- projections / Detached Override baseline；
- DB-first 完整 Target state transaction。

### `0.3.x` 分支功能

逐步补充：

- schema migration / backup；
- corruption detection / recovery tooling；
- dependency observation；
- `operation.lock` 跨平台系统能力；
- Store verification 与 interrupted staging cleanup。

如果 Node 无法可靠实现 OS lock，本系列允许引入最小 mandatory System Capability Helper。

## 5. `0.4.x` — Target 管理

### `0.4.0` — Target Planner + Materialization

形成真正的 Target 管理能力：

- pure Target plan；
- flat activation namespace；
- rename / dependency routing transform；
- symlink / junction / managed copy；
- foreign-content protection；
- DB-first one-way materialization。

### `0.4.x` 分支功能

逐步补充：

- sync / repair；
- detach / rebind / forget；
- reachability remove；
- stale same-target-id sync-or-fork；
- DB-loss recovery candidate；
- crash / partial materialization hardening。

## 6. `0.5.x` — GitHub Source

### `0.5.0` — Exact GitHub Source Resolution

首次把 live GitHub 接入已经通过 fixture 验证的领域规则：

- published GitHub Releases；
- tag -> exact commit；
- explicit Git ref -> exact commit；
- repository redirect/rename detection；
- private/not-found access ambiguity；
- exact repository snapshot acquisition；
- Git executable mode preservation。

### `0.5.x` 分支功能

逐步补充：

- disposable source cache；
- transport retry / cancellation；
- large tree/object benchmark；
- 必要时的 Git tree/object native helper；
- source access diagnostics。

Catalog 不属于本系列 source authority。

## 7. `0.6.x` — 完整安装生命周期

### `0.6.0` — Install / Update / Remove

首次形成完整用户主链路：

```text
request
-> source facts
-> whole-target candidate
-> compare current state
-> acceptance
-> ensure Store
-> DB becomes authority
-> materialize Target
-> marker sync
```

覆盖：

- first install；
- add Package root；
- repository-wide install；
- whole-target update；
- remove + reachability；
- no-op identical state。

### `0.6.x` 分支功能

逐步补充：

- non-interactive acceptance policy；
- Release retarget policy hook；
- richer diff / diagnostics；
- interrupted operation recovery；
- install/update/remove UX hardening。

## 8. `0.7.x` — 恢复与可传播环境

### `0.7.0` — `.skiloom-state` + Exact Export/Import

实现公开恢复与复现格式：

- `.skiloom-state` v1；
- Target Identity / Generation；
- direct requirements；
- sparse rename/transform/detach metadata；
- dependency export；
- full export；
- `skiloom-export.toml`；
- offline exact import；
- merge import conflict handling。

### `0.7.x` 分支功能

逐步补充：

- format validation diagnostics；
- user-owned payload digest / portability hardening；
- interrupted export/import handling；
- large payload streaming benchmark；
- 必要时的 export/archive native helper。

公开格式 schema 在实现前必须由 #17 架构 Gate 固定。

## 9. `0.8.x` — Discovery UX、CLI 与第一方 Skills

### `0.8.0` — Usable Product Surface

形成面向用户和 Agent 的完整产品入口：

- CLI command surface；
- prompt / render / exit behavior；
- SkillsMP discovery；
- explicit GitHub coordinate install；
- Host preset；
- first-party `skiloom` Router / `skiloom-discover` / `skiloom-manage` / `skiloom-doctor` / `skiloom-author` Skills；
- Router 通过普通 Package dependency 显式依赖四个 specialist；
- 一次 bootstrap 只对一个用户选定 Target 执行普通 Router direct install；
- npm 安装本身不修改 Skill Target。

所有入口最终进入同一 install/update/runtime pipeline；第一方 Skill 不拥有隐藏安装权限，Router 也不是 CLI/runtime 正确性的前提。

### `0.8.x` 分支功能

逐步补充：

- Catalog UX；
- doctor diagnostics；
- bootstrap convenience；
- host-specific warnings；
- first-party Skill 内容与 Agent workflow polish。

第一方 Skills 不获得普通 Package 之外的隐藏安装特权。

## 10. `0.9.x` — 跨平台与发布收尾

### `0.9.0` — Release-ready v0

完成：

- Linux / macOS / Windows CI；
- Node 22 minimum / Node 24 mainline；
- npm package / executable；
- `npm pack` / `npx` / global install smoke tests；
- fresh HOME e2e；
- install/update/sync/export/import e2e；
- lock contention / corruption / interrupted materialization tests；
- platform helper packaging（仅真实存在时）。

### `0.9.x` 分支功能

用于 v0 正式公开发布前的：

- 跨平台缺陷修复；
- packaging 修复；
- performance hardening；
- documentation / diagnostics 修正；
- 已知 host filesystem 边界处理。

不在 `0.9.x` 中偷偷增加新的大产品功能；新的主要能力应另开后续 `0.x.0` 或进入未来 1.x 规划。

## 11. Native / Binary 与版本的关系

Native helper 不独立占一个主版本。它服务于所属主要功能：

- `operation.lock` helper -> `0.3.x`；
- resolver accelerator -> `0.2.x`；
- Git tree/object helper -> `0.5.x`；
- snapshot/digest helper -> `0.1.x`；
- export payload helper -> `0.7.x`。

Compute helper 只有通过 benchmark gate 才进入对应 `0.x.y`；没有性能瓶颈就不创建 helper，也不影响主版本完成。

## 12. 开发顺序

主顺序固定为：

```text
0.1.x Domain
  ↓
0.2.x Resolver
  ↓
0.3.x Store / Registry
  ↓
0.4.x Target
  ↓
0.5.x GitHub Source
  ↓
0.6.x Lifecycle
  ↓
0.7.x Recovery / Export
  ↓
0.8.x CLI / Catalog / First-party Skills
  ↓
0.9.x Release hardening
```

允许局部并行开发，但一个 `0.x.0` 的发布标准必须由该主要功能自己的 DoD 决定，不能因为下一系列已经开工就跳过当前系列的 correctness gate。

## 13. 一句话版本策略

```text
0.x.0 = 一个主要功能第一次完整成立
0.x.y = 这个主要功能内部继续长出分支能力并完成硬化
```

v0 先把产品做对、做完整，再讨论更复杂的版本治理。
