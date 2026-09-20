# ADR 0028：v0 Host Observation 使用内建只读 probe 与公开 `observe` 写入口

- 状态：Accepted
- 日期：2026-09-20
- 对应 Wayfinder：#126 `Decide v0 dependency-observation execution and ownership surface`

## 背景

Skiloom 已经接受三条同时成立但此前没有完整闭环的规则：

1. `skiloom-package.toml [software]` 是 registered Host Observation attachment，用于少量常见软件的只读环境检查，不进入 Skill dependency graph；
2. Machine Registry 已有 machine-local `dependencyObservations`，Package `content-digest` 是 observation freshness anchor；
3. v0 的 `skiloom doctor` 已在较晚的 Product Surface 决策中固定为严格只读，第一方 Skills 也不得直接写 Registry、Store、marker 或 Target。

旧 ADR 0010 曾要求 common software 在 `sync` / `doctor` 重探测，并让 Agent 维护 special observations。但它基于已经退役的 project-local `dependencies.lock` 模型，也没有提供与当前 canonical CLI 兼容的 Agent 写入口。若照字面让 Doctor 重探测后直接写 Registry，会破坏后来的只读 Doctor 契约；若让第一方 Skill 私写 Registry，则会破坏第一方无特权边界；若完全不实现 observations，则 `[software]`、Registry schema 与 Doctor surface 会形成长期空壳。

## 决定

### 1. Common Software 是有限内建能力

v0 Host Observation 只支持固定的内建 probe ID：

```text
node
npm
git
gh
python
```

Package 只能通过 `[software]` 选择这些 capability 并声明 requirement。Package metadata 不得提供 executable path、argv、shell、probe command、provider、installer、package-manager command 或其他宿主写行为。

未知 probe ID 不使 Package Core-invalid；它产生 Host Observation scoped 的 `unknown` 结果与诊断。

### 2. v0 software requirement grammar 独立且最小

Host software requirement 不复用 Skill Release Requirement grammar。v0 只接受：

```text
*
<comparator><numeric-version>
<comparator><numeric-version>,<comparator><numeric-version>,...
```

其中 comparator 为：

```text
=  <  <=  >  >=
```

numeric version 为一个或多个十进制整数段：

```text
N(.N)*
```

比较时按 numeric tuple 逐段比较，缺失尾段视为 0。v0 不定义 caret、tilde、wildcard（除单独的 `*`）、union、hyphen range、prerelease 或 build metadata 语义。

无法解释的 requirement 不使 Package 无效；Host Observation 返回 `unknown` 并产生 extension-scoped diagnostic。

### 3. Probe 是只读且由实现固定

每个内建 probe 只 direct-spawn 实现固定的 executable candidate 与固定 version argv，不经过 shell，也不执行 Package 提供的命令。

Observation status 继续使用：

```text
unknown
satisfied
missing
incompatible
blocked
```

- executable 不存在 -> `missing`
- 检测到版本且满足 requirement -> `satisfied`
- 检测到版本但不满足 -> `incompatible`
- OS/权限等阻止 probe -> `blocked`
- unsupported capability、无效 requirement 或无法解释 version -> `unknown`

`detected-version`、`location` 与 `note` 仍是可选 observation facts。

### 4. Doctor 永远只读

`skiloom doctor` 每次运行都可以根据当前 accepted Package snapshots 读取 `[software]` 并实时执行 common software probes，但不得因此写 Registry。

Doctor 输出：

- 本次实时 common software observations；
- 当前 Package content digest 仍有效的已保存 special observations；
- Host Observation scoped diagnostics。

因此环境变化可以立即被 Doctor 看见，而不需要把 Doctor 变成写操作。

### 5. Sync 可以刷新 common software cache

`skiloom sync` 在完成 accepted exact state replay 后，可以重新运行 common software probes，并把结果写入 Machine Registry 的 disposable observation cache。

Observation cache mutation：

- 必须在 `operation.lock` 下；
- 不改变 direct requirements、exact sources/packages/edges、projection ownership 或 Target bytes；
- **不递增 Target Generation**；
- 不形成 Installation Candidate，也不需要 `--plan` / `--yes`；
- Package content digest 改变时旧 observation 失效并被丢弃。

`repair` 不因本 ADR 自动获得额外环境 probe 语义；需要环境刷新时可运行 `sync` 或 `doctor`。

### 6. Special Observation 通过公开 `observe` 命令写入

`DEPENDENCIES.md` 继续是复杂软件、硬件、服务、数据、驱动、授权等特殊 requirement 的 immutable Agent-readable guidance。

v0 保留 special observation persistence，但只允许通过公开 CLI：

```text
skiloom observe <package> <name> --status <status> [--note <text>]
skiloom observe <package> <name> --clear
```

并支持普通 Target selector。

规则：

- 只能操作 selected accepted Target 中已经存在的 Package；
- `kind` 固定为 `special`，不能伪造 Skiloom-owned `software` observation；
- Package `content-digest` 由 Registry 当前 accepted Package 自动取得，不能由 caller 指定；
- 写入/clear 必须取得 `operation.lock`；
- observation write 不改变 Target Generation、Target bytes、marker、source authorization 或 exact graph；
- `observe` 是显式局部 machine-state 操作，不是 Candidate 操作，因此不使用 `--plan` 或 `--yes`；
- 第一方 Agent workflow 如需保存检查结果，只能调用这个公开入口，不得私写 Registry。

### 7. Observation 永不传播为环境权威

Dependency observations 是 machine-local、disposable、可重建/可清除的辅助状态。它们不进入：

- Package Content Digest；
- resolver/source identity；
- Direct Install Requirement；
- Target Recovery Marker；
- dependency/full exact export；
- import identity；
- host mutation authorization。

环境 requirement 仍不授权安装、升级、登录、下载、配置、服务修改或其他宿主写操作。

## 结果

- `[software]` 不再是只有 parser 没有执行面的空 attachment；
- Doctor 保持严格只读，同时能报告当前机器事实；
- Special dependency 检查结果有合法公开写路径；
- 第一方 Skills 继续没有隐藏 Registry 权限；
- observation 与 accepted exact Target Generation 解耦，不再因为纯环境变化制造 Target generation；
- ADR 0010 中“Doctor 重探测”继续有效，但“Doctor 因此写 observation state”的旧含义被本 ADR 取代；
- 不建立通用 probe/provider framework，也不把 Skiloom 变成宿主软件安装器。
