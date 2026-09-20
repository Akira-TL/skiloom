# ADR 0030：v0 CLI 提供 human-only help/version self-description

- 状态：Accepted
- 日期：2026-09-20
- 对应 Wayfinder：#134 `Decide v0 CLI help version and no-argument behavior`

## 背景

Skiloom 在 `0.8.x` 已经形成完整 canonical product command surface：

```text
search status doctor validate
install update remove
rename sync repair detach rebind forget observe
recover fork export import bootstrap
```

但截至 `0.8.6`：

```text
skiloom --help
skiloom --version
```

都会进入普通 argv parser 并返回 `InvalidArguments` / exit 2；bare `skiloom` 同样只表现为缺少命令。每个 canonical command 也没有标准 help flag。

这不是 resolver/lifecycle correctness 问题，但属于 Product Surface 自描述缺口。它不能在实现阶段随意补成新的 `help` command 或引入 CLI framework，因为 #35 已经固定 canonical product commands、machine JSON envelope、approval 与 exit policy。

## 决定

### 1. Top-level meta flags

v0 支持：

```text
skiloom --help
skiloom -h

skiloom --version
skiloom -V
```

行为：

- help 输出 human-readable top-level help 到 stdout，exit 0；
- version 输出：

```text
skiloom <installed-package-version>
```

并以换行结尾、exit 0；
- version 必须来自**实际正在执行的 Skiloom package metadata**，不得维护一个需要人工同步的第二份 hard-coded version 常量。

Top-level `--version` / `-V` 只在 product command 之前作为 meta flag。已有：

```text
skiloom install <coordinate> --version <requirement>
```

继续表示 Release version requirement，不产生冲突。

### 2. Bare invocation

```text
skiloom
```

直接输出与 `skiloom --help` 相同的 top-level help 到 stdout，并 exit 0。

理由：Skiloom 没有隐式默认状态型操作；bare invocation 最有价值的行为是告诉人类可用入口，而不是把“没有命令”当作普通业务 argv 错误。

### 3. Per-command help

每个 canonical product command 都支持：

```text
skiloom <command> --help
skiloom <command> -h
```

Help 是**短路 meta operation**：

- 在 command 参数 parser、network、operation lock、Registry、Store、Target 副作用之前返回；
- 即使同时出现其他 operand/option，只要该 canonical command argv 中出现 `--help` / `-h`，help 优先并且不执行产品操作；
- human help 应展示该 command 当前实际支持的 usage、Target selector、candidate/approval/high-risk flags 等必要信息。

v0 不增加：

```text
skiloom help
```

作为 canonical command，也不增加 product-command alias。

### 4. 与 JSON machine surface 的边界

Help/version 是 human meta surface，不是一次产品命令结果，因此不进入 `SKILOOM-CLI-V1`。

以下组合属于 invalid argv，exit 2：

```text
skiloom --help --json
skiloom --version --json
skiloom <command> --help --json
skiloom <command> -h --json
```

不为 help/version 发明第二套 JSON schema，也不让 `--json` 改变 help/version 的 human-only 属性。

### 5. Help 内容的稳定性

必须由一份实现内静态 command-help specification 驱动：

- canonical command 名；
- usage；
- 当前公开 options/flags；
- 必要的 non-interactive / approval 说明。

测试要验证 canonical command 集与 help specification 一致，避免文案与 parser 漂移。

Help 的自然语言句式、换行和未来展示格式不属于稳定 machine contract；Agent/CI 仍使用正常 command + `--json`，不得解析 human help。

### 6. 不引入 CLI framework

这一能力使用现有 thin CLI boundary 实现，不因为 help/version 引入：

- TUI；
- persistent command registry framework；
- generic plugin command system；
- 新的 third-party CLI parser dependency。

## 结果

Skiloom v0 CLI 可以自描述和报告实际安装版本，同时保持：

- canonical product commands 不变；
- `install --version` 语义不变；
- `SKILOOM-CLI-V1` 不变；
- product operation parser/side effects 不因 help 运行；
- 不新增 `help` command 或复杂 CLI framework。
