# ADR 0012：Skiloom Core 只标准化跨实现可观察语义

- 状态：Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：跨第三方实现的 Core / conformance / P-R-A 分类不再是 Skiloom 产品目标；当前权威是 `docs/design/skiloom-v0-product-contract.md`。

## 背景

当前协议已经接受 Package discovery、canonical Package Snapshot、repository-scoped source binding、Project Lock、flat activation ownership 与 host dependency observation 等多项设计。若把参考 CLI 当前采用的所有缓存、Store、materialization 和本机状态细节都称为“Core”，独立实现将被迫复制并不影响互操作性的物理策略；反之，如果 Core 只剩一个抽象 Package 名称，又无法保证两个实现得到相同 discovery、digest、resolution、Lock 与 activation safety 结果。

竞争架构审计也表明，lockfile、content hash、global store、symlink、frozen install 等单项能力本身并不足以形成新的标准化边界。Skiloom 的价值应来自对 Agent Skill Package identity、dependency semantics、source provenance、Confirmed Resolution 与安全 activation 的精确组合，而不是参考 CLI 的功能总和。

## 决定

Skiloom Core 采用以下边界：

1. **标准化可观察协议结果，不标准化物理实现策略。** 两个实现若采用不同规则会产生不同 discovery、dependency graph、source resolution、Lock、Package Content Digest 或 activation ownership 结果，则该规则属于 Core；只影响性能、磁盘路径、交互或平台优化的规则不属于 Core。
2. **Core 继续保持 Skill-only。** 合法 `SKILL.md` 是 Package 最低准入条件，`Package Root == Skill Root`，一个 Package 恰好一个 Skill；Core 不扩展成 prompts/agents/hooks/MCP/plugin 等通用 agent context package system。
3. **Core 包含 deterministic Package model。** Repository discovery、optional dependency Manifest 的 Core 语义、canonical Package Snapshot 与 source-independent Content Digest 都属于 Core。
4. **Core v0 包含 mandatory GitHub source profile。** source binding 是 repository-scoped；Release/Git 都解析到 exact repository snapshot 后共享 discovery/snapshot pipeline；source provenance 与 Package Content Identity 分离。
5. **Core 包含 Project Intent / Confirmed Resolution 与 canonical Lock 语义。** 已有匹配 Lock 的 replay 必须 lock-preserving；只有显式 resolution-changing operation 在接受后才能替换 Confirmed Resolution。CLI 是否把这些操作命名为 `sync` / `update` / `frozen` 不属于规范要求。
6. **Core 包含 flat activation 的安全语义。** `.agents/skills/<activation-name>`、显式 rename/abort、foreign-content protection、managed drift fail-closed 与 resolution/activation state separation 属于 Core；symlink/junction/copy 的具体选择与 machine-local activation state schema 属于 reference implementation profile。
7. **Host Observation 不属于 Full Core conformance。** 已接受的 `dependencies.lock` / common software probe 行为继续约束 reference manager，但跨实现标准化时必须作为单独 versioned extension/profile；它不得改变 Package graph、Confirmed Resolution 或取得 arbitrary host installer 权限。
8. **Core 不定义 arbitrary host installers。** Package metadata 不能获得 install/build/postinstall/package-manager script 能力，dependency declaration 也不是宿主修改授权。
9. **Full Core conformance 分为三个累进 class：**
   - Class P：Package Model Consumer；
   - Class R：Resolver / Lock Consumer-Producer，依赖 P；
   - Class A：Project Activation Manager，依赖 R。
   只有同时通过 P + R + A 当前同一 Core version conformance suite 的实现可以声明 Full Core Manager conformance。
10. **正式 standard claim 有独立门槛。** 在 versioned normative spec、formal schema/grammar、conformance fixtures、digest test vectors、evolution/security policy 与独立 consumer 重现结果之前，只称 proposed standard / reference protocol，不声称已经形成 industry standard interoperability。

详细 MUST / MUST NOT、Non-Goals、class 契约与后续 Issue 约束见 [`../design/skiloom-core-conformance.md`](../design/skiloom-core-conformance.md)。

## 结果

- 现有 Accepted ADR 的产品行为保持有效，但其中 cache path、Store layout、symlink/junction preference、machine-local observation schema 等实现细节不因“已接受”而自动成为跨实现 Core requirement；
- #4 需要把 Core dependency metadata 与 Host Observation extension 清楚分界；
- #7 需要以 Class R 的 deterministic fixtures 为标准收敛 version grammar 与 candidate selection；
- #9 需要把 v0 trust 限定在 source authorization boundary、exact provenance、retarget detection 与 content integrity，而不是扩张成 registry reputation / publisher PKI / provider marketplace；
- 后续 reference CLI 可以自由优化缓存、Store、materialization 与 UX，只要不改变 Core observable semantics。
