# ADR 0013：Package Manifest 分离 Core dependency 与 Host Observation extension ownership

- 状态：Partially Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：`skiloom-package.toml` 中 Skill dependency、`[software]` 环境观察和禁止任意宿主写脚本的产品规则继续有效；Core / P-R-A / conformance 分类不再是当前权威。现行规则见 `docs/design/skiloom-v0-product-contract.md`。

## 背景

Package Manifest Schema 1 已倾向只包含 `schema`、`[dependencies]` 与 `[software]`。此前 Proposal 把两张 table 都作为同一层“Skiloom Manifest 语义”处理：`[dependencies]` 影响 Skill dependency graph，`[software]` 则由内建 probe 检查；未知 software probe ID 甚至会让 Package fail fast，并且 software version requirement 曾计划复用 #7 Resolver grammar。

ADR 0012 已明确 Skiloom Core 的 Full conformance 只包含 Package Model、Resolver/Lock 与 Project Activation（P/R/A）。Host software observation 不改变 Package graph、Confirmed Resolution 或 activation ownership，因此属于单独 Host Observation Extension。与此同时，ADR 0010 已接受 `[software]` 作为 reference manager 的 common software observation 输入，不应为了新的标准化分类重新移动或删除该字段。

## 决定

Package Manifest Schema 1 保持一个物理文件与三个已登记顶层成员：

```text
schema
[dependencies]
[software]
```

但语义 ownership 分开：

- `schema` 与 `[dependencies]` 属于 Skiloom Core；
- `[software]` 是 Schema 1 中已登记的 Host Observation Extension attachment point；
- 不实现 Host Observation Extension 的 P/R/A implementation 仍必须把 `[software]` 识别为已登记 table，而不是 unknown Core field；
- 缺少 extension 或具体 probe capability，不得让 otherwise-valid Package 失去 Core Package conformance；
- `[software]` 不进入 Skill dependency graph、source constraints 或 Confirmed Resolution；
- Host Observation Extension 自己拥有 software requirement grammar、probe/capability identifiers、unsupported behavior、observation semantics 与 evolution；
- #7 只拥有 Skill Release requirement grammar，不再拥有 host software version grammar；
- Package metadata 仍不得提供 probe command、install/provider command、build/postinstall hook 或其他宿主写操作。

Core Manifest envelope 继续 strict/fail-closed：未知顶层字段必须通过新的 Manifest schema 或明确登记 attachment 引入；损坏或不支持的 Core dependency metadata不能被静默忽略。

## 结果

- ADR 0010 的 reference-manager 行为保持不变：`[software]` 仍可以被只读 probe 消费，observation 仍写入 machine-local `dependencies.lock`；
- Full Core conformance 不再取决于某个实现支持哪些 software probe IDs；
- Class R 不需要为了 Package resolution 实现 host runtime 的版本类型系统；
- future Host Observation evolution 可以独立于 Skill dependency resolver 演进，只要不改变 Schema 1 attachment 的 Core envelope 角色；
- #4 的 Package Manifest ownership boundary 因此可以关闭，具体 Host Observation capability grammar 属于 extension spec，而不是重新打开 Package Manifest Core schema。
