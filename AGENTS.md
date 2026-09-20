# Skiloom 项目规则

Skiloom 是独立的 Agent Skill 包管理器与安装器项目。v0 架构 Wayfinder 主体已收敛，canonical Spec 为 GitHub #31；当前实现已完成 `0.8.11` Product Surface/diagnostics/first-party workflow、dependency-observation、GitHub credential/private-source、child-process secret-isolation、Windows shell-free npm Host Observation、CLI help/version self-description、无锁 Registry snapshot-consistent read、install complete-candidate presentation，以及 update/install/remove/recover/fork detached-content compatibility risk 闭环。#125 已无未决设计 frontier；`0.9.x` Release Hardening 仍暂后，当前继续复核 v0 代码与既有规划是否还有遗漏。实现工作必须从已拆分、blocker 已解除的 executable ticket 进入，不在代码阶段重新发明已经接受的产品语义。

## 工程流程

### 问题追踪

项目使用 GitHub Issues 记录规范、决策项、研究项、原型项与后续实现票。具体操作见 `docs/agents/issue-tracker.md`。

### 工作流角色

Matt Engineering 的工作流角色通过 GitHub label 表达，映射见 `docs/agents/triage-labels.md`。面对跨度大、路径尚不清楚的架构工作，按 ask-matt 路由进入 Wayfinder：一次只解决当前可推进的一张普通决策票，先形成决定，不提前做实现拆票。

### 领域文档

本项目采用单一领域上下文。处理设计问题时先读取根目录 `CONTEXT.md`，需要理解历史取舍时再读取相关 `docs/adr/`、`docs/design/` 与研究记录；消费规则见 `docs/agents/domain.md`。

当前设计以 `CONTEXT.md` 与已经关闭的 Wayfinder 决策票为最新依据。旧的已接受 ADR、设计稿与 Core 规范仍可作为历史约束，但只在未被后续决定推翻的部分继续有效；发生冲突时不得把旧项目锁模型重新当成当前事实，也不要在 Wayfinder 尚未决定替代路径前静默重写旧 Core 规范。

## 当前已确认的设计边界

- 产品与协议族统一使用 `Skiloom`；公开 CLI 为 `skiloom`，可选元数据文件为 `skiloom-package.toml` 与 `skiloom-repo.toml`，目标恢复标记文件为 `.skiloom-state`，公开包快照格式标识为 `SKILOOM-PACKAGE-V1`。旧 `AKM / akm` 只属于标准确定前的历史草案，不形成兼容别名。
- 一个 Skill Package 恰好对应一个标准 Agent Skill，包根目录与 Skill 根目录重合。合法 `SKILL.md` 是最低准入条件；`skiloom-package.toml` 与 `DEPENDENCIES.md` 都是可选增强文件。
- v0 的直接来源仍是 GitHub。来源种类只有字面量 `github-release` 与 `git`：Release 通过 SemVer、实际 tag 与精确 commit 确定内容；Git 来源把用户给出的 ref 解析到精确 commit；两种来源不能因一种失败而静默切换到另一种。
- 仓库默认从合法 `SKILL.md` 零配置发现 Skill；可选根目录 `skiloom-repo.toml` 只负责限制发现范围，不能定义或伪造包身份。
- 包快照与包存储保持不可变、按内容摘要寻址；来源证明与安装状态不进入包存储键。v0 不执行破坏性的自动包存储清理。
- 普通安装采用“目标目录中心”模型，不再维护项目注册表、`project.id`、项目级意图文件或持续维护的项目锁文件。本机 SQLite 状态库保存日常管理所需的完整精确安装状态；`.skiloom-state` 只保存恢复所需的轻量信息；跨机器精确复现通过用户显式生成的单文件导出完成。
- 目标目录（Target）可以是用户选择的任意目录，也可以由已知宿主预设给出；`.agents/skills` 只是其中一个可能位置。目标目录内按 `<target>/<activation-name>` 平铺 Skill。
- 一个目标目录只有一套统一的已安装依赖图；同一个包坐标在同一目标目录内只能有一个精确解析结果和一个投影名称。不同顶层 Skill 可以共享同一个传递依赖。
- 无需变换的受管 Skill 默认通过软链接或目录链接指向不可变包存储。发生改名或依赖路由时，Skiloom 可以生成由自己完全管理、能够确定性重建的副本；这种副本仍由 Skiloom 自动更新，不代表用户获得手工编辑权。
- 用户想修改受管 Skill 时，必须显式把它转成自己维护的本地副本。该副本仍可原地留在目标目录供 Agent 发现和使用，但其内容不再由 Skiloom 更新、覆盖、合并或删除；后续相关更新必须提醒用户自行检查兼容性。
- 如果依赖 Skill 因同名冲突被改名，Skiloom 必须让直接依赖它的 Skill 明确知道实际投影名称；Skill 依赖表示能力依赖，不把跨包相对路径或目标目录名定义成稳定程序接口。
- 本机状态库存在时，同步与修复严格恢复已经接受的精确状态，不重新解析依赖。安装、更新以及数据库丢失后的恢复才允许重新解析并形成完整的新安装候选；操作请求本身不等于接受结果。
- 来源授权针对一次完整的新安装候选，而不是永久仓库白名单。界面可以重点展示新增、移除和变化，但最终接受的是完整结果；已经从当前安装状态消失的来源，以后重新出现时需要再次进入授权流程。
- Catalog 只负责发现与展示，不能在 v0 中替代 GitHub 成为版本、来源或内容权威。
- 第一方 Skiloom Skills 走与第三方包相同的来源、解析、包存储、目标投影与所有权流程，不拥有特殊系统路径或绕过授权的特权。
- 宿主软件与复杂环境要求属于只读检查边界。Skiloom 可以发现、记录并向用户说明缺失项，但不自动安装、升级或修复系统软件。

## 工程约定

- 当前已经进入实现阶段。实施顺序、版本路线与 blocker 以 canonical Spec #31、`docs/planning/skiloom-v0-implementation-plan.md` 和对应 executable ticket 为准；不要绕过 ticket 边界一次实现未来版本能力。
- Skiloom 官方实现采用 Node.js + TypeScript + npm 作为主控制面与发行方式；`skiloom-lock` 是已经接受的 mandatory Rust System Capability Helper，其余 native compute helper 只有 benchmark gate 通过后才允许引入。
- 仓库存在 `.codegraph/` 后，理解或定位代码时优先使用 CodeGraph；索引数据库属于机器本地状态，不进入 Git。
- 新决定在讨论充分并真正满足 ADR 条件时才写入 ADR；普通已确认领域词汇更新 `CONTEXT.md`，具体操作契约进入规范或对应 Wayfinder 决策记录，不把 `CONTEXT.md` 写成会议纪要。
- Git 提交遵守系统级 `AGENTS.md` 的原子提交与 `akira-guard` 规则。一个已经完成且可独立理解、验证和回退的修改目的，应先单独提交，再进入下一修改目的。
