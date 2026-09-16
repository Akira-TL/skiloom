# 第一方 Skiloom Skill Suite 与 Bootstrap v0

状态：Accepted

对应 Issue：#27 `Define first-party Skiloom Skill suite bootstrap across Targets`

对应产品规范：[`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)

本文固定 Skiloom v0 第一方 Agent Skill Suite 的职责、依赖关系和 bootstrap 行为。第一方 Skill 只改善 Agent 侧的发现、管理、诊断和创作体验；它们必须完整复用普通 Package / Source / Resolver / Store / Target / acceptance 语义，不形成第二套特权安装路径。

## 1. Suite 组成

v0 第一方 Suite 由五个标准 Skill Package 组成：

- `skiloom`：Router Skill；
- `skiloom-discover`：发现与候选解释；
- `skiloom-manage`：管理操作意图；
- `skiloom-doctor`：诊断；
- `skiloom-author`：Skill 创作与格式检查。

五者都必须是普通、可 discovery 的 Skiloom Skill Package；第一方身份不改变 Package Snapshot、来源确认、依赖解析、Store、Target projection 或 ownership 规则。

## 2. Router 与 specialist 职责

### 2.1 `skiloom`

`skiloom` 只负责识别用户意图并把工作委托给对应 specialist，例如：

- 找 Skill / 比较候选 -> `skiloom-discover`；
- 安装、更新、删除、同步、修复、detach、rebind、forget、导入导出 -> `skiloom-manage`；
- 检查 Registry / Store / Target / marker / dependency observation -> `skiloom-doctor`；
- 创建或检查 Skill Package 元数据 -> `skiloom-author`。

Router 不复制 resolver、来源确认或 Target 管理逻辑，也不是 CLI/runtime 正确性的前提。

### 2.2 `skiloom-discover`

只负责：

- 使用 Catalog / GitHub 信息帮助用户发现候选；
- 解释 Catalog provider provenance、热度、评分和安全扫描等展示信号；
- 把可安装候选归一到 GitHub repository/package/source request。

它不能直接把 Catalog version/hash/snapshot/download 当成安装来源，也不能自行修改 Target。

### 2.3 `skiloom-manage`

负责把 Agent 理解到的管理意图映射为 Skiloom 的公开管理操作。真正的 source resolution、candidate comparison、acceptance、operation lock、Registry transaction、Store 和 Target side effects 全部由同一套 Skiloom CLI/runtime 执行。

### 2.4 `skiloom-doctor`

默认执行只读诊断和解释：

- Machine Registry；
- Package Store；
- Target / `.skiloom-state`；
- projection ownership / drift；
- dependency observation；
- 可解释的来源/状态异常。

任何会修改状态的“修复”必须重新进入普通 manage/repair/sync/recovery 流程，不由 doctor Skill 绕过 acceptance 或 ownership 检查直接写状态。

### 2.5 `skiloom-author`

用于创建、解释和检查：

- `SKILL.md`；
- `skiloom-package.toml`；
- `skiloom-repo.toml`；
- `DEPENDENCIES.md`。

它不拥有特殊发布协议、Registry source、安装特权或任意 build/postinstall hook。

## 3. Package 依赖关系

Router 通过普通 Package dependency 声明另外四个 specialist：

```text
skiloom
├── skiloom-discover
├── skiloom-manage
├── skiloom-doctor
└── skiloom-author
```

因此 bootstrap 的直接安装要求只需要把 `skiloom` Router Package 作为 direct root；其余 specialist 由普通 resolver 作为传递依赖进入完整 Target graph。

第一方 Suite 不使用 repository-wide direct requirement 作为默认 bootstrap 机制。这样未来官方 repository 新增其他 Skill 时，不会仅因为 discovery 到新 Package 就自动进入所有已经 bootstrap 的环境；Suite 扩展必须通过 Router 的显式 dependency 变化进入正常 update candidate 和 acceptance 流程。

每个 specialist 仍是独立合法 Package，可以被用户单独直接安装。Router 只是 UX 聚合入口，不是 specialist 的运行前提。

## 4. 官方 repository 与 discovery 边界

第一方 Suite 可以与 Skiloom 主代码位于同一官方 GitHub repository，但必须放在明确的产品 Skill roots 中，并使用 repository discovery control 把产品 Package discovery 范围与仓库内部开发辅助 Skill / `.agents/skills` 等目录隔离。

不得因为“同仓库”而把开发环境、测试 fixture 或内部 Agent Skill 自动当成发布给用户的第一方 Package。

## 5. Bootstrap

Bootstrap 是用户显式发起的首次启用动作，本质是一次普通 direct install：

```text
选择一个 Target
→ 请求安装官方 skiloom Router Package
→ 普通 resolver 得到 specialist dependencies
→ 展示完整 candidate/source changes
→ 用户或策略接受
→ 普通 Store / Machine Registry / Target 流程
```

### 5.1 npm 安装不触发 bootstrap

以下动作只安装 Skiloom 程序，不修改任何 Skill Target：

```text
npm install -g skiloom
npx skiloom ...
```

不能使用 npm postinstall 或首次运行副作用偷偷写入 `.agents/skills`、`.claude/skills` 或其他 Host Target。

### 5.2 一次只处理一个 Target

v0 一次 bootstrap 只对一个用户已选择的 Target 生效。

Target 选择继续遵循统一优先级：

```text
显式 Target
> 显式 Host preset + scope
> 默认 .agents/skills
```

Skiloom 不自动扫描并同时修改 Codex、Claude、Gemini CLI、OpenCode 或多个 workspace 的 Skill Target。用户需要在哪个 Target 启用，就分别对该 Target bootstrap。

## 6. 第一方身份不提供权限提升

任何第一方 Skill 都不得直接：

- 写 `registry.sqlite3`；
- 修改 Package Store；
- 绕过 `operation.lock`；
- 直接删除或覆盖 Target 内容；
- 自动接受来源集合；
- 永久授权传递 repository；
- 自动接受 Release retarget；
- 获取普通第三方 Skill 不具备的隐藏宿主写权限。

正确调用链始终是：

```text
First-party Skill
→ Agent / 用户意图
→ Skiloom CLI/runtime
→ 普通 product rules / acceptance / Store / Registry / Target
```

CLI/runtime 在没有安装任何第一方 Skill 时也必须保持完整正确性。

## 7. Bootstrap 后的生命周期

Bootstrap 只负责第一次把 Router direct root 加入一个 Target，不创建第二套后续生命周期。

- Suite 已经处于当前一致状态时，再次 bootstrap 可以报告已启用，不把 bootstrap 解释成隐式 update；
- projection 缺失或 drift 使用普通 `sync` / `repair`；
- Suite 升级使用普通 whole-target `update`；
- 来源或依赖图变化继续进入完整 candidate acceptance；
- 移除 Router direct root 后，从剩余 roots 重新计算 reachability；没有其他 root 需要的 specialist 按普通受管 Package 规则移除；
- 若某个 specialist 同时被用户单独作为 direct root 安装，则移除 Router 后该 specialist 继续保留；
- detached / foreign / rename 等行为完全沿用普通 Target ownership 规则。

## 8. v0 非目标

v0 不建立：

- 第一方 Skill 专用 Package 类型；
- 第一方专用 Store；
- bootstrap 多 Target 分布式事务；
- 自动宿主探测后批量安装；
- 第一方后台 daemon；
- 第一方 Skill 绕过 CLI/runtime 的私有写 API；
- 把 Router 变成 resolver / dependency routing 的正确性依赖。

## 9. 最终边界

```text
第一方 Skill Suite
= 普通 Skill Packages
+ Router UX
+ specialist Agent workflows

Bootstrap
= 对一个用户选择 Target 的普通 Router direct install
```

因此第一方 Suite 完整 dogfood Skiloom 自己的 Package、依赖、来源、状态接受与 Target 管理规则，而不形成产品内部的第二套特权系统。
