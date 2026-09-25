# Skiloom v0 CLI Surface 与交互策略

状态：Accepted

对应 Issue：#35 `Define v0 CLI surface, acceptance policy, and interaction UX`

对应产品规范：[`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)

本文固定 Skiloom v0 的公开 CLI command surface、Target 选择参数、候选状态接受方式、非交互调用边界、机器可读输出和核心交互层次。目标是让人类、CI 与第一方 Agent Skills 共用同一套 CLI/runtime，而不为 v0 引入永久 policy DSL、profile 系统、TUI 或绕过完整性/ownership 规则的 `--force`。

## 1. 基本原则

1. 一个产品动作只有一个 canonical command name，不同时维护 `add/rm/fix/upgrade` 等同义 alias；
2. CLI 只表达用户意图、候选接受和展示，产品规则仍属于 domain/runtime；
3. 形成完整新 Target 状态的操作必须先计算完整 candidate，再接受，再提交；
4. sync/repair 只重放 Machine Registry 当前已接受 exact state，不重新解析；
5. 非交互执行不能靠“默认 yes”越过来源变化或高风险状态变化；
6. `--json` 是 Agent/CI 的正式机器输出入口；
7. v0 不提供能绕过 digest、ownership、foreign path、schema 或 lock 错误的 `--force`。

## 2. Canonical command surface

```text
skiloom search <query>
skiloom status
skiloom doctor
skiloom validate [path]

skiloom install <coordinate>
skiloom update
skiloom remove <coordinate>
skiloom rename <package> <activation-name>

skiloom sync
skiloom repair

skiloom detach <package>
skiloom rebind <package> <activation-name>
skiloom forget <package>
skiloom observe <package> <name> --status <status>
skiloom observe <package> <name> --clear

skiloom recover
skiloom fork

skiloom export <file>
skiloom import <file>

skiloom bootstrap
```

v0 不建立 `upgrade`、`uninstall`、`add`、`rm`、`fix`、`heal` 等 alias，也不保留隐藏 alias。

### 2.1 CLI 自描述 meta surface

CLI 自描述不属于新的产品 command，固定为：

```text
skiloom
skiloom --help
skiloom -h
skiloom --version
skiloom -V
skiloom <canonical-command> --help
skiloom <canonical-command> -h
```

规则：

- bare `skiloom` 与 top-level `--help` / `-h` 输出相同 human help 到 stdout，exit 0；
- top-level `--version` / `-V` 输出 `skiloom <installed-package-version>` 并换行，exit 0；版本必须从实际运行 package metadata 读取，不能维护第二份 hard-coded version；
- 每个 canonical command 的 `--help` / `-h` 是短路 meta operation：一旦出现，就在该 command 的 operand/option parser、network、operation lock、Registry、Store 或 Target 副作用之前输出 human help 并 exit 0；其他 command operands/options 即使同时存在也不得执行产品操作；
- `install --version <requirement>` 仍是 `install` 自己的 Release requirement 参数；只有 product command 之前出现的 top-level `--version` / `-V` 才表示 CLI version；
- help/version 是 human-only surface，不使用 `SKILOOM-CLI-V1`；与 `--json` 混用属于 invalid argv，exit 2；
- v0 不增加 `skiloom help` command，也不增加 product-command alias；
- human help 中的 command/usage/public flags 由实现内同一份静态 help specification 驱动并受测试约束；自然语言句式和排版不是 machine API。

## 3. Target 选择

显式路径：

```text
--target <path>
```

Host preset + scope：

```text
--host codex|claude|gemini|opencode
--scope workspace|user
```

规则：

- `--target` 与 `--host` / `--scope` 互斥；
- 使用 `--host` 但未提供 `--scope` 时默认 `workspace`；
- 完全不指定时默认 `workspace`，Target 为 `<cwd>/.agents/skills`；
- v0 不自动寻找 Git repository root；当前工作目录就是 workspace context。

## 4. `install`

`install` 同时承担新增或修改一个 Direct Install Requirement。

默认 source kind 为 `github-release`：

```text
skiloom install owner/repo/package
skiloom install owner/repo/package --version '^1.4'
skiloom install owner/repo
skiloom install owner/repo --version '^2'
```

显式 Git source：

```text
skiloom install owner/repo/package --git main
```

`--git` 与 `--version` 互斥；v0 不额外暴露 `--source github-release|git`。

Package requirement 可以带：

```text
--name <activation-name>
```

Repository-wide requirement 不允许 `--name`。

Coordinate 语义：

```text
owner/repo/package  -> Package Direct Install Requirement
owner/repo          -> repository-wide Direct Install Requirement
```

再次对相同 requirement kind + canonical coordinate 执行 `install` 时修改原直接要求，而不是创建重复 requirement。

## 5. 完整 Candidate 操作

以下命令会形成新的完整 Target candidate：

```text
install
update
remove
recover
fork
import
bootstrap
```

统一执行：

```text
用户操作
→ 计算完整新状态
→ 与当前已接受状态比较
→ 展示变化/风险
→ 用户或策略接受
→ Store/Registry/Target 提交
```

其中：

- `update` 始终重新解析整个 Target graph，没有 partial dependency update；
- `remove` 删除对应 Direct Install Requirement 后重算 reachability；
- `recover` 根据合法 `.skiloom-state` 重新解析 recovery candidate；
- `fork` 为 stale/copied Target 建立新的 Target Identity，并按恢复语义形成新状态；
- `import` 使用 export 中 exact graph/payload，不重新选版本，但仍需要来源确认；
- `bootstrap` 本质是向选定 Target 普通安装官方 `skiloom` Router direct root。

若完整计算结果与当前状态相同且没有待处理风险，则 no-op 成功，不要求确认。

## 6. `--plan`

上述完整 Candidate 命令统一支持：

```text
--plan
```

含义：

```text
解析 / 验证 / 获取必要来源事实
→ 计算完整 candidate
→ 计算 delta / risk
→ 展示结果
→ 不接受
→ 不写 Machine Registry
→ 不修改 live Target
```

`--plan` 可以读取网络和 disposable cache，但不得把 candidate 正式提交为 accepted state。v0 不提供 `--dry-run` alias。

## 7. 不产生新 resolution 的状态操作

`sync`：

```text
Machine Registry 当前已接受 exact state
→ Target
```

不重新解析版本、不改变直接要求、不改变 source assignment。

`repair` 按当前已接受 exact provenance + digest 修复 Store / managed Target projection；不形成新 candidate，也不能覆盖 Detached Override 或 foreign/user-owned bytes。

因此 `sync` / `repair` 不再次询问“是否接受当前状态”。安全 preflight 或 ownership 冲突仍然 fail closed。

## 8. 显式局部 ownership / projection 操作

以下命令本身就是明确用户授权：

```text
rename
detach
rebind
forget
```

v0 不再机械增加第二次普通确认。

它们仍必须取得 `operation.lock`、做 ownership preflight、通过 Machine Registry transaction 更新状态、按 DB-first materialize/reconcile Target，并更新 Target Generation / `.skiloom-state`。任何 foreign path、ownership 或状态异常继续 fail closed。

### 8.1 Machine-local dependency observation

`observe` 是另一类显式局部状态操作：它只记录或清除当前 accepted Package 的 `special` dependency observation，不修改 Package graph、Target bytes、projection ownership 或 `.skiloom-state`，也不递增 Target Generation。

```text
skiloom observe owner/repo/package <name> --status unknown|satisfied|missing|incompatible|blocked [--note <text>]
skiloom observe owner/repo/package <name> --clear
```

它继续支持统一 Target selector，并必须取得 `operation.lock`。Package coordinate 必须已经存在于 selected Target 的 accepted state；caller 不能提供 `content-digest`，CLI 自动绑定当前 accepted Package digest。`observe` 只能写 `special` observation；`software` observation 由 Skiloom 内建只读 probe 拥有。

`observe` 本身就是对这一次 machine-local metadata write 的显式授权，不是完整 Candidate 操作，因此没有 `--plan` 或 `--yes`。第一方 Skill 若要保存 Agent 对 `DEPENDENCIES.md` 的检查结果，也必须走这个公开命令。

`doctor` 仍严格只读：它可以实时运行 common-software read-only probes 并合并展示当前有效的 saved special observations，但不得因为诊断而写 Registry。`sync` 可以在锁内刷新 disposable software observation cache；这种刷新同样不递增 Target Generation。

## 9. Interactive 与 non-interactive

模式选择：

```text
交互 TTY          -> interactive
非 TTY            -> non-interactive
--non-interactive  -> 强制 non-interactive
--json             -> 自动隐含 --non-interactive
```

v0 不提供“强制 interactive”参数。

### 9.1 普通候选接受

non-interactive 下，一个会改变完整已接受状态的 Candidate 命令必须显式提供：

```text
--yes
```

没有 `--yes` 且 candidate 需要提交时返回 `InteractionRequired`。

`--yes` 表示接受该 invocation 计算出的完整普通 candidate，但绝不绕过 digest mismatch、foreign path conflict、invalid state/export、unsupported schema、ownership violation、`OperationLocked` / `OperationLockLost`、unsupported platform capability 等产品完整性错误。

## 10. 独立高风险授权

### 10.1 Release tag retarget

interactive 模式必须先单独展示并确认 retarget 风险，再进入普通完整 candidate 确认。

non-interactive 必须同时提供：

```text
--yes --allow-release-retarget
```

只有 `--yes` 不足以接受 retarget。

### 10.2 Merge import

向已有内容的 Target 合并 import 必须显式：

```text
--merge
```

interactive 模式下单独提示最终 Target 不再等同于原 export environment；同名或同路径冲突仍失败。

non-interactive 合并执行要求：

```text
--merge --yes
```

`--merge` 从不授权覆盖或自动 rename 冲突内容。

### 10.3 不建立永久信任策略

v0 不创建 trusted repository、approval profile、`policy.toml`、source whitelist 或永久 Release-retarget allowlist。无人值守授权只属于当前 invocation。

## 11. Interactive UX 层次

TTY 下完整 Candidate 命令统一展示：

```text
Target
Direct Install Requirements
Sources
Packages / dependency graph changes
Projection / ownership changes
Warnings / special risks
```

普通确认语义固定为：

```text
Apply this complete state? [y/N]
```

默认拒绝。

具体自然语言、颜色、表格宽度、spinner 与布局不是稳定 API；但不能隐藏完整 source set、ownership change 或独立高风险变化。v0 不实现全屏 TUI。

## 12. `--json` 机器输出

`--json` 是 Agent / CI 的正式结构化输出入口，并自动禁用 prompt。

成功：

```json
{
  "schema": "SKILOOM-CLI-V1",
  "ok": true,
  "command": "update",
  "result": {},
  "warnings": []
}
```

失败：

```json
{
  "schema": "SKILOOM-CLI-V1",
  "ok": false,
  "command": "update",
  "error": {
    "code": "OperationLocked"
  },
  "warnings": []
}
```

v0 固定 envelope 字段：

```text
schema
ok
command
result | error
warnings
```

规则：

- `schema = "SKILOOM-CLI-V1"`；
- stdout 只写一个完整 JSON document；
- prompt 永不出现在 JSON 模式；
- warnings 进入 `warnings`；
- ordinary diagnostics 不混入 stdout；
- runtime diagnostics 如需输出只能走 stderr；
- `--json` 不等于 `--yes`；会改变 candidate 的命令仍需显式 `--yes`；
- 调用者用 `error.code` 区分产品错误，不解析终端自然语言。

各 command 的 `result` 详细字段由对应 implementation/domain ticket 固定，不在 v0 架构层复制一整套 domain schema。

## 13. 只读与辅助命令边界

- `search`：Catalog discovery-only 搜索；Catalog 故障不影响明确 GitHub coordinate 操作。
- `status`：快速摘要，不默认重新 hash 整个 Store/Target。
- `doctor`：更深的只读诊断；发现问题后建议 `sync` / `repair` / `recover`，不自动修复。
- `validate [path]`：检查本地 Skill / repository metadata、discovery 和静态规则；默认 path 为当前目录，不安装、不发布、不改 Target。
- `bootstrap`：Suite 已经一致时 no-op，不隐式执行 `update`。
- `export <file>`：默认 dependencies export；`--full` 为 full export；目标文件已存在时失败，v0 不提供 `--force` 覆盖。

## 14. Exit codes

```text
0    success / no-op
1    product/runtime operation failure
2    CLI usage / invalid argv
3    approval absent / declined / InteractionRequired
130  interrupted by SIGINT
```

具体产品错误通过 `--json` 的 `error.code` 表达，不扩张成几十个 shell exit code。Interactive 用户拒绝候选也返回 `3`。

## 15. v0 明确不做

- command alias compatibility layer；
- permanent trust/source whitelist；
- policy DSL / approval profile；
- TUI framework；
- 自动 Git root/workspace root discovery；
- 多 Target 一次事务操作；
- `--force` integrity/ownership bypass；
- partial dependency update；
- doctor 自动修复；
- bootstrap 自动 update；
- 需要 Agent 解析 human terminal output 的机器接口；
- `--token` / `--credential` 参数或持久 credential profile。GitHub API metadata credential 只按 ADR 0029 使用 `GH_TOKEN`，其次 `GITHUB_TOKEN`；没有时匿名访问。Git repository transport 按 ADR 0032 委托给 system Git/SSH，允许其使用用户既有 SSH config/agent，但 Skiloom 不读取这些 secret；两类 credential 都不进入 argv、candidate presentation、JSON output 或持久状态；
- `skiloom help` command 或独立 help JSON schema；CLI 自描述只使用 ADR 0030 定义的 human-only help/version meta flags。

## 16. 最终边界

```text
CLI
= 明确 canonical commands
+ Target selector
+ --plan
+ --yes
+ 少量独立高风险授权 flag
+ SKILOOM-CLI-V1 JSON envelope

!= 第二套 product-rule engine
!= 永久授权系统
!= 安全检查绕过层
```
