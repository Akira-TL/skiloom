# ADR 0026：固定 v0 CLI Surface 与 Acceptance Policy

- 状态：Accepted
- 日期：2026-09-16

## 背景

Skiloom 的 Package、Resolver、Machine Registry、Target、恢复格式、精确导出、第一方 Skill Suite 与跨平台 operation lock 已经收口。最后一个实现前 Gate 是：公开 CLI 到底叫什么、哪些动作形成完整 Candidate、交互与无人值守怎样接受状态，以及 Agent/CI 如何稳定读取结果。

v0 需要足够明确，避免实现阶段自行发明永久 policy、隐藏 alias 或危险 `--force`；同时不应为了“CLI 完整”而提前设计复杂配置语言或 TUI。

## 决定

1. **固定 canonical commands。** v0 使用 `search/status/doctor/validate/install/update/remove/rename/sync/repair/detach/rebind/forget/recover/fork/export/import/bootstrap`，不提供同义 alias compatibility layer。
2. **Target selector 统一。** `--target` 与 `--host`/`--scope` 互斥；默认 workspace 为 `<cwd>/.agents/skills`，不自动搜索 Git root。
3. **`install` 同时新增或修改 Direct Install Requirement。** 默认 GitHub Release，`--version` 表达 Release Requirement，`--git <ref>` 显式选择 Git，二者互斥；Package 可以 `--name`，repository-wide 不可以。
4. **完整 Candidate 命令统一支持 `--plan`。** `install/update/remove/recover/fork/import/bootstrap` 都能只计算、展示而不接受/提交。
5. **sync/repair 不重新接受状态。** 它们严格恢复 Machine Registry 当前已接受 exact state；rename/detach/rebind/forget 的显式命令本身就是局部状态操作授权，但仍必须经过 lock、ownership preflight 与 DB-first transaction。
6. **非交互普通候选要求 `--yes`。** 非 TTY 或 `--non-interactive` 不得 prompt；`--json` 自动隐含 non-interactive，但不隐含 `--yes`。缺少批准时返回 `InteractionRequired`。
7. **高风险授权独立。** Release retarget 的非交互执行必须 `--yes --allow-release-retarget`；merge import 必须显式 `--merge`，非交互执行还必须 `--yes`。v0 不持久化 source whitelist / policy profile。
8. **Interactive UX 固定信息层次，不固定文案。** 完整 Candidate 至少展示 Target、直接要求、来源、Package/graph 变化、projection/ownership 变化与风险；普通确认默认拒绝。v0 不做 TUI。
9. **`--json` 使用 `SKILOOM-CLI-V1` envelope。** 固定 `schema/ok/command/result|error/warnings`；stdout 只包含一个 JSON document，具体错误通过 `error.code` 表达。
10. **Exit code 保持少量类别。** `0` success/no-op，`1` product/runtime failure，`2` usage，`3` approval absent/declined/InteractionRequired，`130` SIGINT。
11. **不提供 `--force`。** 完整性、ownership、foreign path、schema/version 和 lock 类错误始终 fail closed。

完整命令与参数边界见 [`../design/cli-surface-v0.md`](../design/cli-surface-v0.md)。

## 结果

- 人类、CI 和第一方 Agent Skills 共享同一公开 CLI/runtime；
- `--plan` 提供安全候选检查入口，`--json` 提供稳定机器接口；
- 无人值守操作仍然需要当前 invocation 的显式批准；
- 高风险 Release retarget / merge import 不会被普通 `--yes` 悄悄吞掉；
- v0 不承担永久 policy DSL、alias compatibility、TUI 或强制覆盖语义的复杂度。
