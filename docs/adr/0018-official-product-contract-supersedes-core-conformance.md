# ADR 0018：官方产品契约取代旧 Core / Conformance 与项目锁模型

- 状态：Accepted
- 日期：2026-09-16

## 背景

Skiloom 的产品模型已经从“项目内 `skiloom.toml` + `skiloom.lock` + 固定 `.agents/skills` 激活”转向“本机精确状态 + 任意目标目录 + 轻量恢复标记 + 显式精确导出/导入”。与此同时，旧 ADR 0012 把 Skiloom Core 定义为面向第三方独立实现的跨实现一致性协议，并进一步引出了 Class P / R / A、Full Core Manager 与 conformance fixture 等概念。

当前产品目标并不是建立第三方实现认证体系。Skiloom 只需要把自己的产品行为、公开数据格式与官方实现边界定义清楚；第三方如果选择兼容 Skiloom，应适配 Skiloom 已公开的行为和格式，而不是由 Skiloom 反向为第三方实现设计兼容等级。

## 决定

1. **当前最高规范对象是 Skiloom 官方产品契约。** 它定义 Skiloom v0 接受什么输入、如何解析和管理 Skill、保存哪些逻辑状态、如何操作目标目录、如何恢复，以及生成哪些公开数据格式。
2. **不再建立跨第三方实现的 Core / conformance 体系。** Class P、Class R、Class A、Full Core Manager、第三方兼容认证和“独立实现必须得到相同结果”的标准化目标退出当前产品设计。
3. **旧项目模型正式退役。** 普通安装不再维护 Project Intent、Project Lock、`activation.lock` 或 frozen replay；`.agents/skills` 也不再是唯一或固定目标目录。Skiloom 以用户选择的 Target 为安装边界，以本机状态库保存当前已接受的完整精确状态，以 `.skiloom-state` 保存轻量恢复信息。
4. **保留具体产品规则，不保留旧抽象外壳。** Package discovery、Package Snapshot、内容摘要、GitHub source identity、Release/Git 来源、SemVer requirement、确定性解析、来源确认、foreign-content protection、rename/detach 等仍有效的规则进入新的官方产品规范；旧文档中的 Project Lock、Confirmed Resolution、Core class 和 conformance 术语不继续作为当前权威。
5. **公开格式与内部实现明确分开。** `SKILL.md`、`skiloom-package.toml`、`skiloom-repo.toml`、`DEPENDENCIES.md`、`.skiloom-state`、精确导出包及其中的 `skiloom-export.toml`、`SKILOOM-PACKAGE-V1`、GitHub Package Coordinate 与版本要求语法属于 Skiloom 的公开产品契约。SQLite 文件位置/表结构/迁移方式、缓存和 Store 的物理目录、临时文件布局、Node.js 内部模块与 CLI 内部调用链属于官方实现细节。
6. **本机状态的逻辑内容属于产品行为，SQLite 结构不是公开契约。** Skiloom 必须正确维护当前已接受的精确安装状态、Target Identity/Generation、直接安装要求、依赖图、来源与投影所有权等事实，但不承诺第三方可依赖 SQLite schema。
7. **旧 conformance fixtures 改为官方行为测试数据。** 版本选择、内容摘要、来源漂移、冲突、恢复、导入导出等固定样例继续用于验证 Skiloom 官方实现，取消第三方兼容等级或认证含义。
8. **ADR 0008、0009、0011、0012 整体被本 ADR 与新的官方产品规范取代。** ADR 0010、0013、0014、0015、0016 中仍有效的具体规则由新规范吸收，旧项目路径、Lock/Core/conformance 措辞不再具有当前权威。ADR 0017 的 Node.js + TypeScript + npm 官方实现技术栈继续有效，但应去除 Project Lock/Core conformance 的旧措辞。

## 结果

仓库从此只维护一套当前产品权威：Skiloom 官方产品规范 + 仍有效的实现 ADR。历史 ADR 和旧 design 文档可以保留用于解释设计演进，但必须清楚标记其当前状态，不能再与目标目录中心模型并列作为规范来源。
