# Skiloom v0 协议工作草案

状态：Superseded

当前说明：本文记录 pre-target-centric 的早期工作草案，已被 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md) 与 ADR 0018 取代，不再作为当前产品权威。

## 当前阶段

以下内容保留为历史设计背景。

设计文件：

1. [`skill-package-layout.md`](skill-package-layout.md)
2. [`repository-discovery.md`](repository-discovery.md)
3. [`01-package-manifest.md`](01-package-manifest.md)
4. [`02-release-artifact.md`](02-release-artifact.md)
5. [`03-project-manifest-lock.md`](03-project-manifest-lock.md)
6. [`04-resolver-and-install-plan.md`](04-resolver-and-install-plan.md)
7. [`05-software-dependencies.md`](05-software-dependencies.md)
8. [`06-module-boundaries.md`](06-module-boundaries.md)
9. [`package-snapshot-digest.md`](package-snapshot-digest.md)
10. [`project-activation.md`](project-activation.md)
11. [`activation-runtime-state.md`](activation-runtime-state.md)
12. [`dependency-runtime-state.md`](dependency-runtime-state.md)
13. [`package-manifest-schema.md`](package-manifest-schema.md)
14. [`resolver-conformance.md`](resolver-conformance.md)
15. [`source-trust-conformance.md`](source-trust-conformance.md)
16. [`skiloom-core-conformance.md`](skiloom-core-conformance.md)
17. [`skiloom-public-namespace.md`](skiloom-public-namespace.md)

## 已明确的 v0 方向

- GitHub 是首个直接分发坐标系，不先建设独立 Registry；
- 用户安装目标使用 `<owner>/<repo>[/<package>]@<version-or-ref>`；
- 默认优先使用 GitHub Release；没有 Release 或明确要源码版本时显式进入 Git source；
- Release 只负责通过规范化 SemVer 选择 repository snapshot；v0 不定义 Skiloom 专用 per-Skill Release Asset；
- 一个 Skill Package 恰好包含一个 Skill；
- Package Root 与 Skill Root 重合；
- **唯一最低准入条件是合法 `SKILL.md`**；
- `skiloom-package.toml` 是可选结构化依赖元数据；
- `DEPENDENCIES.md` 是可选 Agent-readable 特殊依赖说明；
- Multi-Skill Package 不进入 v0；
- Router 是普通 Skill，能力族由 Router + 可见 dependency closure 形成；
- 运行时共享能力必须写成 dependency，不允许跨 Package hidden shared files；
- GitHub Release `@version` 只接受 SemVer，tag 允许可选前导 `v`，最终锁定实际 tag + exact commit；
- Git source `@ref` 最终锁定 exact commit；
- Git source 进入机器级 disposable source cache，再从 exact commit discovery/snapshot Skill Root；
- repository 默认零配置扫描合法 `SKILL.md`；可选 root-level `skiloom-repo.toml` 只过滤 discovery 范围，不改变 `SKILL.md` 的准入地位；`exclude` 优先于 `include`，v0 glob 只支持 literal / `*` / `**` / `?`；
- resolved Skill 直接扁平激活到项目 `.agents/skills/<activation-name>`；默认 activation name 等于 `SKILL.md.name`；
- 不同 source 的同名 Skill 会在 activation 层真实冲突；Skiloom 必须在写入前提示用户为新安装项 rename 或放弃，不能自动覆盖/自动改名；
- Package snapshot 以 `SKILOOM-PACKAGE-V1` canonical tree hash 计算 `content-digest`：独立 nested Skill 从祖先 snapshot 裁掉，v0 禁止 symlink/特殊文件，只保留 relative path、executable bit 与 exact bytes；
- Package Store 直接以 `content-digest` 寻址并跨来源去重；Package payload 机器级共享且 immutable；
- Skiloom 项目状态统一位于 `.agents/.skiloom/`：`skiloom.toml`、`skiloom.lock`、`activation.lock`、`dependencies.lock`；
- `.agents/.skiloom/skiloom.toml` 保存 top-level requirements，Release 用 version string，Git 用 `{ git = "<ref>" }`；用户批准的本地 Skill rename 写入 `[renames]`；同一 repository 不允许混用多个 Git ref 或 Release/Git source；
- `.agents/.skiloom/skiloom.lock` 采用 canonical `requirement -> repository -> package` 三层结构，source provenance 只写一次，Package Record 只保存 `package-root`、`content-digest` 与 exact dependency edges；Project Intent（允许范围）与 Confirmed Resolution（已接受 exact result）严格分离：已有匹配 Lock 的普通 `sync` 只恢复 Lock，只有 initial resolution / 显式 `update` 在明确接受后才能写入新的 Lock；
- `.agents/.skiloom/activation.lock` 只保存 `activation-name`、Package coordinate、`content-digest` 与 `mode`（`symlink` / `junction` / `copy`）；POSIX 未 rename 优先 symlink，Windows 未 rename 优先 junction，rename 一律 copy；managed drift 默认 fail closed；
- `.agents/.skiloom/dependencies.lock` 只保存当前机器 dependency observations，Package `content-digest` 是唯一 freshness anchor；Common software 每次 `sync` / `doctor` 重新只读 probe，Special dependency observation 由 Agent 管理；该文件可随时删除重建；
- Skiloom 只基础探测少量常见软件，不负责自动安装/修复宿主依赖。

## 核心关系

```text
GitHub repository snapshot
    ↓
SKILL.md discovery
    ├── Package A == Skill A
    ├── Package B == Skill B
    └── Package C == Skill C

optional skiloom-package.toml
    └── structured dependencies/software

optional DEPENDENCIES.md
    └── Agent-readable special requirements

Git Source Cache
    └── repository Git objects / exact commits

Package Store
    └── immutable selected Skill Root snapshots

Project Skill Activation
    └── .agents/skills/<activation-name>

Skiloom Project State
    └── .agents/.skiloom/{skiloom.toml, skiloom.lock, activation.lock, dependencies.lock}
```

## 当前没有的东西

v0 不提前引入：

- 必填 `skiloom-package.toml`；
- 独立 Registry namespace/package identity；
- Multi-Skill bundle；
- Package Index 作为 GitHub 的强制中间层；
- 全局 Skill name registry（只在单个项目 `.agents/skills/` activation 层要求名字唯一）；
- Software Provider 自动安装体系；
- Package 自定义系统安装脚本；
- repository runtime shared directory；
- 项目直接引用 mutable Git checkout。

## 当前决策状态

Wayfinder v0 foundational decision map 已收敛：Package/Skill cardinality、discovery、Manifest ownership、Release/Git source、Project Intent/Confirmed Resolution、deterministic Resolver、Source/Trust、Package Snapshot identity、Activation ownership、Host Observation boundary、Core conformance 与 public namespace 都已有 Accepted source of truth。

下一阶段是把这些分散的 Accepted decisions collapse 成一份 versioned normative Spec，并补齐 machine-readable grammar/schema 与 P/R/A conformance fixtures。Git Source Cache GC 的 LRU/size/age 策略属于 reference implementation；optional dependencies / feature flags 明确不进入 v0 Schema 1，不再阻塞 v0 formalization。

## 协议稳定后的候选实现顺序

1. GitHub coordinate + `SKILL.md` metadata parser；
2. Release/Git source cache + Package discovery；
3. optional Skiloom metadata parser + dependency resolver；
4. immutable Package Store；
5. flat `.agents/skills/` activation + collision/rename handling；
6. common dependency probes + `.agents/.skiloom/dependencies.lock`；
7. activation ownership/doctor/remove；
8. CLI/MCP surface。