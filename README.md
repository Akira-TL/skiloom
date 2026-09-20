# Skiloom

Skiloom 是面向 Agent Skill 的独立包管理器与安装器。它把标准 Agent Skill 作为真正的软件包处理，负责 GitHub 来源解析、依赖图、不可变内容存储、Target 投影、恢复和可传播环境导出。

当前实现版本为 **`0.8.5`**。`0.1.x`–`0.8.x` 的领域、解析、Machine State、Target、GitHub Source、生命周期、恢复/导入导出与 Product Surface 已完成，并补齐 Host Observation / public `observe`、GitHub authenticated/private-source 与 child-process secret isolation 闭环。#125 v0 产品语义漏洞图已无未决设计 frontier；**`0.9.x` Release Hardening 仍暂后**，当前继续做最终代码/规划遗漏复核。v0 架构已经收敛，canonical Spec 为 GitHub #31；后续开发继续按 executable implementation tickets 推进，不再使用早期 AKM、Project Lock 或第三方 conformance 模型作为当前产品权威。

## v0 开发路线

```text
0.1.x  Domain / Package / Discovery / Snapshot / Requirement
0.2.x  Deterministic Resolver
0.3.x  Store / Machine Registry / operation.lock
0.4.x  Target 管理
0.5.x  GitHub Source
0.6.x  install/update/remove 生命周期
0.7.x  恢复与 exact export/import
0.8.x  CLI / Catalog / 第一方 Skills
0.9.x  跨平台与发布硬化
```

版本规则保持简单：`0.x.0` 表示一个主要功能第一次完整成立，`0.x.y` 用于该主要功能的分支能力、补全、修正和硬化。

## 当前实现基线

- Node.js >= 22，Node 24 LTS 为主要开发/release 线；
- TypeScript strict + ESM；
- npm package / executable 名称均为 `skiloom`；
- 普通产品控制面由 Node/TypeScript 实现；
- `operation.lock` 使用预编译 mandatory Rust helper `skiloom-lock`；
- 其他 native compute helper 只有通过 benchmark gate 后才引入；
- 最高行为验收 seam 是 versioned offline behavior fixtures。

## 设计与实施入口

- [`CONTEXT.md`](CONTEXT.md)：当前领域词汇；
- [`docs/design/skiloom-v0-product-contract.md`](docs/design/skiloom-v0-product-contract.md)：v0 官方产品规范；
- [`docs/planning/skiloom-v0-implementation-plan.md`](docs/planning/skiloom-v0-implementation-plan.md)：实施顺序与工作包；
- [`docs/planning/skiloom-v0-version-roadmap.md`](docs/planning/skiloom-v0-version-roadmap.md)：`0.1.x`–`0.9.x` 版本路线；
- GitHub #31：canonical implementation Spec。

当前 `0.8.5` 已形成完整 canonical CLI、Catalog/Host diagnostics、第一方 Skill Suite / bootstrap Agent workflow；通过内建只读 Host probes 与公开 `skiloom observe` 闭合 dependency observation，按 `GH_TOKEN` > `GITHUB_TOKEN` > anonymous 的环境策略贯通 authenticated/private GitHub source lifecycle，并让 native helper / Host probe 子进程只继承最小非敏感环境。之后的 `0.9.x` release hardening 仍包括平台 helper npm packaging、`npm pack`/`npx`/global-install smoke、Linux/macOS/Windows 发布物级验证、fresh HOME 与故障/中断 release e2e，以及发布文档与许可收尾，但当前先保留为延期项。
