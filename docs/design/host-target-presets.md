# Skiloom Host Target Preset v0

状态：Accepted

对应 Issue：#23 `Define Host preset and future adapter contract`

事实依据：[`../research/host-skill-targets-2026-09.md`](../research/host-skill-targets-2026-09.md)

## 1. 定位

Skiloom 的安装模型以通用 Target 为中心，不以某个 Agent 宿主为中心。

Host preset 只是一个**目标目录快捷映射**：把用户明确选择的宿主、scope 与当前工作区上下文解析成一个普通 Target。解析完成后，后续 Package Store、依赖图、投影、ownership、rename、detach、sync、repair、update 等行为全部复用同一套 Skiloom Target 逻辑。

Host preset 不是另一套安装器，不拥有自己的 Package Store，也不修改宿主配置。

## 2. Skiloom 自己的数据位置

Skiloom 官方实现的机器级内部数据位于 Skiloom Home：

```text
~/.skiloom/
```

其中 Package Store 默认位于：

```text
~/.skiloom/store/
```

Store 是机器级共享、不可变、按 Package Content Digest 寻址的内容仓库。任何 Host preset、任何 Target、任何 scope 都复用同一个 Store；不能因为用户选择 Claude、Codex、Gemini CLI 或 OpenCode 而创建另一份宿主专用 Store。

## 3. 默认 Target

用户没有提供显式 Target，也没有显式选择 Host preset 时，Skiloom 使用通用 `.agents/skills` 约定。

### workspace scope

```text
<workspace>/.agents/skills/
```

### user scope

```text
~/.agents/skills/
```

这里的 `<workspace>` 是本次操作明确使用的工作区根目录；Skiloom 不通过任意向上搜索猜测另一个项目身份。

`.agents/skills` 是 Skiloom 的默认公开安装面，不是 Package Store，也不承载 Skiloom 的机器级内部状态。

## 4. 内建 Host preset

v0 内建以下便利映射。

| Host preset | workspace scope | user scope | 说明 |
| --- | --- | --- | --- |
| `codex` | `<workspace>/.agents/skills` | `~/.agents/skills` | 使用 Codex 原生 `.agents/skills` |
| `claude` | `<workspace>/.claude/skills` | `~/.claude/skills` | 仅在用户明确选择 Claude preset 时使用 Claude 专用目录 |
| `gemini` | `<workspace>/.agents/skills` | `~/.agents/skills` | Gemini CLI 正式支持 `.agents/skills`，因此沿用 Skiloom 默认公共目录 |
| `opencode` | `<workspace>/.agents/skills` | `~/.agents/skills` | OpenCode 支持 `.agents/skills`，因此沿用 Skiloom 默认公共目录 |

Skiloom 不因为检测到机器上安装了某个宿主就自动把默认 Target 改到宿主专用目录。Host preset 只有在用户明确选择时才参与解析。

## 5. Target 选择优先级

固定优先级：

```text
显式 Target
> 显式 Host preset + scope
> Skiloom 默认 .agents/skills Target
```

规则：

1. 用户显式指定任意 Target 时，Skiloom直接使用该目录，不再让 Host preset 改写它；
2. 没有显式 Target、但明确选择 Host preset 时，按第 4 节映射解析；
3. 两者都没有时，按第 3 节使用 `.agents/skills`；
4. Host 自动探测只能用于提示，不得静默改变上述优先级。

## 6. Host preset 不修改宿主配置

v0 Host preset MUST NOT 为了让宿主发现 Skill 而自动：

- 改写 Claude Code / Gemini CLI / OpenCode / Codex 的配置文件；
- 增删宿主搜索路径；
- 把 `.claude`、`.gemini`、`.opencode`、`.agents` 整个目录互相链接；
- 创建宿主专用 Package Store 或第二套 dependency state；
- 赋予宿主配置文件任何 Skiloom ownership。

如果某个未来宿主只能通过配置才能加入自定义 Skill 搜索目录，该能力必须作为单独、显式、用户可见的集成动作设计，不能藏在普通 install 中。

## 7. Materialization 仍属于通用 Target 逻辑

Host preset 不决定 symlink / junction / copy。

普通受管 Package继续遵守 Skiloom 通用投影规则：

- 可安全使用 link 时，从共享 Store 投影到 Target；
- Windows 可使用适合目录投影的 junction；
- 当前平台、文件系统、宿主沙箱或目标环境不适合链接时，使用 Skiloom-managed copy；
- rename、dependency routing 等需要内容变换的投影继续使用 managed transformed copy；
- `detach` 后的副本退出 Skiloom 内容 ownership。

Host preset可以附带**能力提示 / 已知风险提示**，例如 OpenCode worktree + symlink 的已知边界，但提示本身不得形成另一套宿主专用 materialization 算法。

## 8. 同一 Package 投影到多个 Host Target

同一个 Store Package 可以同时投影到多个 Target，例如：

```text
~/.skiloom/store/<digest>/...
        ├──> <workspace>/.agents/skills/foo
        └──> <workspace>/.claude/skills/foo
```

两个 Target 分别拥有自己的 Target Identity、Generation、projection name、rename/detach 状态；但底层未变换的 Package 内容复用同一个 Store entry。

Skiloom 不把“同时给多个宿主安装”理解成复制多份包内容。

## 9. v0 preset 契约

内建 preset 的最小逻辑输入：

```text
host
scope = workspace | user
workspace-root   # 仅 workspace scope 需要
```

最小输出：

```text
target-path
可选 capability / risk hints
```

preset 输出 Target 后即结束职责。它不接收 dependency graph，不读写 Machine Registry，不执行 Package 获取，不负责来源确认，也不拥有 Target destructive mutation。

## 10. 未来扩展边界

v0 不建立第三方 Host Adapter SDK、动态 plugin registry 或宿主专用 installer framework。

未来新增宿主时，优先新增一个与上述输入/输出等价的内建数据/解析条目。只有真实需求证明“仅路径映射 + 提示”不足时，再单独设计更强的显式集成能力。

第三方工具若希望调用 Skiloom，可以直接传入显式 Target；不需要先注册成 Skiloom Host Adapter。

## 11. 一句话规则

```text
Skiloom 只维护一套 ~/.skiloom Store；
默认把 Skill 投影到 .agents/skills；
Host preset 只是用户明确选择时的 Target 快捷映射，不是另一套安装架构。
```
