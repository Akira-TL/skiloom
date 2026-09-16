# ADR 0022：第一方 Skill Suite 与普通 Target Bootstrap

- 状态：Accepted
- 日期：2026-09-16

## 背景

Skiloom v0 计划提供 `skiloom`、`skiloom-discover`、`skiloom-manage`、`skiloom-doctor`、`skiloom-author` 五个第一方 Agent Skill，帮助 Agent 使用 Skiloom。Target-centric 架构已经明确 Package、来源确认、Machine Registry、Store、Target ownership、Catalog 和 Host preset 的统一边界，因此第一方 Skill 不应再创建另一套特权安装或状态写入机制。

剩余问题是 Router 与 specialist 如何分工、bootstrap 如何选择 Target、第一方 Suite 如何进入依赖图，以及 npm 安装本身是否应该自动修改用户的 Skill Target。

## 决定

1. 五个第一方 Skill 都是普通标准 Skill Package，完整服从普通 discovery、source、resolver、Store、Target projection 与 ownership 规则。
2. `skiloom` 是 Router Skill，只识别意图并委托给 `skiloom-discover`、`skiloom-manage`、`skiloom-doctor`、`skiloom-author`；Router 不复制 resolver/runtime 逻辑，也不是产品正确性的前提。
3. Router 通过普通 Package dependency 显式依赖四个 specialist。默认 bootstrap 只把 Router Package 作为 direct root，不使用 repository-wide install 自动吸收未来新增的官方 Skill。
4. 每个 specialist 仍是独立合法 Package，可以被用户单独直接安装。移除 Router 时按普通 reachability 规则处理；被其他 direct root 继续需要的 specialist 不删除。
5. `skiloom-discover` 只负责发现、候选解释和 GitHub 来源提名，不把 Catalog metadata 变成 source authority，也不直接修改 Target。
6. `skiloom-manage` 只把 Agent/用户意图映射到统一 Skiloom CLI/runtime 操作；真正的 acceptance、operation lock、Registry、Store 和 Target side effects 仍由普通产品路径执行。
7. `skiloom-doctor` 默认只读诊断。任何修复都重新进入普通 sync/repair/recovery/manage 路径，不能通过 doctor Skill 获得隐藏写权限。
8. `skiloom-author` 负责标准 Skill 与 Skiloom metadata 的创建/检查，不拥有特殊发布、安装或 hook 能力。
9. Bootstrap 是用户显式发起的一次普通 Router direct install，一次只针对一个用户选择的 Target。Target 选择继续遵守“显式 Target > 显式 Host preset + scope > 默认 `.agents/skills`”。
10. `npm install -g skiloom` / `npx skiloom` 本身不得修改任何 Skill Target，也不得通过 postinstall 或首次运行副作用静默 bootstrap。
11. 第一方身份不授予直接写 `registry.sqlite3`、修改 Store、绕过 `operation.lock`、自动接受来源、自动允许 Release retarget、删除/覆盖 Target 或其他隐藏宿主写权限。
12. CLI/runtime 在没有安装第一方 Skill Suite 时也必须保持完整正确性。第一方 Skill 只提供 Agent UX 和 workflow guidance。
13. Suite 已启用后的 update/remove/sync/repair/detach/rename 等生命周期全部复用普通 Target 规则；bootstrap 不形成第二套升级或维护语义。
14. 第一方 Package 与主代码可以同仓，但 repository discovery control 必须把正式产品 Skill roots 与仓库内部开发辅助 Skill/fixture 隔离。

## 结果

- 第一方 Suite 完整 dogfood Skiloom 自己的 Package/Target 模型；
- Agent 可以通过 Router 获得统一入口，又不会让 Router 成为 resolver/runtime 的隐藏依赖；
- npm 程序安装与用户 Target 修改严格分离；
- bootstrap 不引入跨多个 Target 的事务或自动宿主扫描；
- 第一方 Skill 不形成比第三方 Package 更高的安装权限等级。

完整设计见 [`../design/first-party-skill-suite-bootstrap.md`](../design/first-party-skill-suite-bootstrap.md)。
