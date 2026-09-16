# 主流 Agent Skill 目标目录与文件系统行为调研（2026-09）

状态：Research Complete

对应 Issue：#22 `Research current Agent Skill target locations and filesystem capabilities`

本调研只记录截至 2026-09-16 可确认的宿主事实，供后续 Host preset / adapter 设计使用；不在这里决定 Skiloom 默认选择哪个宿主目录。

## 1. 共同基线

Agent Skills 规范把 Skill 定义为一个包含 `SKILL.md` 的目录。规范要求 `name` 为 1–64 个字符，只使用小写字母、数字和单连字符，不得以连字符开头/结尾，不得包含连续连字符，并且必须与父目录名一致；`description` 必填且不超过 1024 个字符。

来源：

- https://agentskills.io/specification

这与 Skiloom 当前 `Package Root == Skill Root`、一个 Skill 一个 Package、Target 平铺 `<target>/<activation-name>` 的方向一致。

## 2. Codex

### 2.1 官方发现位置

Codex 当前文档明确支持：

- repository scope：从当前工作目录向 repository root 逐级扫描每一层的 `.agents/skills`；
- user scope：`$HOME/.agents/skills`；
- admin scope：`/etc/codex/skills`；
- system scope：Codex 自带 Skills。

同名 Skill 不会合并；文档明确说两个同名 Skill 都可能出现在 Skill 选择器中。

来源：

- https://developers.openai.com/codex/skills （当前重定向到 ChatGPT Learn 的 Build skills 文档）

### 2.2 链接行为

Codex 官方文档明确写明：**支持 Skill 目录本身是 symlink，并在扫描时跟随 symlink target。**

因此，对 Codex 的本地宿主目录，Skiloom 使用“Target entry -> Package Store”的目录链接在产品层有官方文档依据。

文档没有把 Windows directory junction 单独列为承诺能力，因此 junction 应视为 Skiloom 在 Windows 上的 materialization 实现选择，需要实际能力探测，而不应宣称是 Codex 文档保证。

### 2.3 对 Skiloom 的事实约束

- `.agents/skills` 是 Codex 的原生路径，不是兼容别名；
- repository scope 不是只有 repository root 一个目录，Codex 会沿 CWD -> repo root 扫描多层 `.agents/skills`；
- Skiloom 不应依赖 Codex 自己替我们解决同名 Package 冲突，因为 Codex 可以同时暴露多个同名 Skill。

## 3. Claude Code

### 3.1 官方发现位置

Claude Code 当前文档支持：

- personal：`~/.claude/skills/<skill-name>/SKILL.md`；
- project：`.claude/skills/<skill-name>/SKILL.md`；
- nested：`<subdir>/.claude/skills/<skill-name>/SKILL.md`；
- additional directory：通过 `--add-dir` 加入目录后，也加载其中的 `.claude/skills/`；
- enterprise / plugin / claude.ai synced Skills 还有各自独立来源。

Claude Code 会从启动目录向 repository root 读取项目 Skills；较深子目录里的 Skills 可在实际访问该子目录后动态加入当前 session。

来源：

- https://code.claude.com/docs/en/skills

### 3.2 链接行为

Claude Code 官方文档明确写明：enterprise、personal、project 三类位置中的 `<skill-name>` entry 可以是指向其他磁盘目录的 symlink；Claude Code 会读取 target 中的 `SKILL.md`，并对多个指向同一 target 的位置做单次加载处理。

因此 Claude Code 同样有明确的 directory symlink 支持。

文档没有把 Windows junction 作为单独保证项。

### 3.3 名称与覆盖行为

Claude Code 的本地 personal/project Skill 比 Agent Skills 基础规范更宽松：`name` frontmatter 对本地 Skill 不是命令名的唯一来源，目录名决定 `/command` 名；个人、项目、企业位置之间还有自己的 precedence。嵌套 Skill 与根 Skill 同名时可以同时存在，并用目录限定形式调用。

这意味着 Skiloom 不能把 Claude Code 的命令解析规则当作 Package identity；继续以 Skiloom 自己的 Package Name / activation name 管理目标目录更安全。

### 3.4 对 Skiloom 的事实约束

- Claude Code **不把 `.agents/skills` 列为 personal/project Skill 发现路径**；
- 所以 `.agents/skills` 不能作为 Claude Code preset 的唯一目标；
- 要支持 Claude Code，本机/项目 preset 必须能投影到 `.claude/skills`，或未来使用 Claude plugin 等另一条明确分发路径。

## 4. Gemini CLI

### 4.1 官方发现位置

Gemini CLI 当前 discovery tiers 从低到高为：

1. built-in；
2. extension；
3. user：`~/.gemini/skills/` 或 `~/.agents/skills/` alias；
4. workspace：`.gemini/skills/` 或 `.agents/skills/` alias。

同一 tier 中 `.agents/skills/` alias 的优先级高于 `.gemini/skills/`；workspace tier 又高于 user tier。

来源：

- https://geminicli.com/docs/cli/skills/
- https://geminicli.com/docs/cli/creating-skills/
- https://geminicli.com/docs/cli/tutorials/skills-getting-started/

### 4.2 Skill 目录深度

Gemini 的 troubleshooting 文档明确写明，在一个 skill source 中，`SKILL.md` 只从 source root 或一层子目录发现；更深层的 `SKILL.md` 不发现。推荐形式仍是：

```text
skills/<skill-name>/SKILL.md
```

Skiloom 当前平铺 Target 正好满足这一限制。

### 4.3 链接行为

Gemini CLI 提供官方 `gemini skills link <path>` / `/skills link` 命令，CLI reference 明确描述为通过 **symlink** 链接本地 Agent Skills。

来源：

- https://geminicli.com/docs/cli/cli-reference/
- https://geminicli.com/docs/cli/using-agent-skills/

因此目录 symlink 是 Gemini CLI 明确支持的工作流。

补充观察：2026-08 的 Gemini CLI GitHub issue #28944 报告，当用户把 `.gemini` 与 `.agents` 用 symlink 或 Windows junction 互相映射时，Gemini 会从两个入口扫描到同一 Skill 并报告 duplicate warning。这不是产品契约，但说明“把两个宿主根目录互相链接”不是好的 Skiloom 策略；Skiloom 应直接选择一个 Target 路径，而不是把整个 `.gemini` / `.agents` 根目录做镜像链接。

观察来源：

- https://github.com/google-gemini/gemini-cli/issues/28944

### 4.4 对 Skiloom 的事实约束

- `.agents/skills` 是 Gemini 官方支持的 alias；
- 它与 Codex 的原生 user/project 路径形成明显交集；
- 对 Gemini + Codex 的共享场景，`.agents/skills` 是后续 preset 设计值得优先考虑的公共目标；
- 但不要同时向 `.gemini/skills` 和 `.agents/skills` 投影同一批 Skill，否则可能产生重复发现/覆盖语义。

## 5. OpenCode

### 5.1 官方发现位置

OpenCode 当前文档支持：

- global：`~/.config/opencode/skills`；
- global compatibility：`~/.claude/skills`、`~/.agents/skills`；
- project：`.opencode/skills`；
- project compatibility：`.claude/skills`、`.agents/skills`。

Project sources 从当前目录向 project root 搜索每一级对应目录。当前 v2 文档还支持通过 `opencode.json/jsonc` 的 `skills` 数组添加相对路径、home-relative path、绝对路径和 HTTP catalog。

来源：

- https://opencode.ai/docs/skills
- https://opencode.ai/v2/docs/skills

### 5.2 名称与覆盖行为

OpenCode 文档要求标准目录型 Skill 的 `name`：

- 1–64 字符；
- 小写字母/数字/单连字符；
- 不以连字符开头/结尾；
- 不允许连续 `--`；
- 与包含 `SKILL.md` 的目录名一致。

当多个 source 给出相同 Skill ID 时，后注册/高优先级 source 覆盖前者，而不是让 Skiloom 获得一个统一冲突语义。

因此 Skiloom 仍应在自己的 Target 内部保持 activation name 唯一，不依赖 OpenCode precedence 处理冲突。

### 5.3 链接行为

OpenCode 官方 Skills 文档目前**没有明确承诺目录 symlink / junction 的稳定语义**。

现实证据表明简单 symlink 场景曾经可用，但存在明确边界：

- issue #18848：project `.claude/skills` 在 OpenCode git-worktree sandbox 中为 symlink 时，Skill 可能不被发现；
- issue #31977：`.claude/skills -> .agents/skills` 时，OpenCode 可能从两个来源重复发现并打印 duplicate warnings。

来源：

- https://github.com/anomalyco/opencode/issues/18848
- https://github.com/anomalyco/opencode/issues/31977

因此在 #23 设计 OpenCode preset 时，不能把“directory symlink 永远可靠”当作宿主保证。copy 一定符合其文档中的普通目录模型；如果 Skiloom 想默认链接，需要以实际版本探测/验证或选择 OpenCode 自身的显式 `skills` path 配置方式。

## 6. Copy / symlink / junction 总表

| Host | 普通目录 / copy | directory symlink | Windows junction | 研究结论 |
| --- | --- | --- | --- | --- |
| Codex | 官方路径就是普通目录，支持 | 官方明确支持 | 未单独承诺 | link 可作为优先实现；junction 需平台验证 |
| Claude Code | 官方路径就是普通目录，支持 | 官方明确支持 | 未单独承诺 | link 可作为优先实现；junction 需平台验证 |
| Gemini CLI | 官方 install 会产生普通目录 | 官方 `skills link` 明确使用 symlink | 无正式承诺；issue 中可被扫描但有 duplicate 边界 | link 可用；不要链接整个宿主根目录制造双入口 |
| OpenCode | 官方路径就是普通目录，支持 | 文档未正式保证；已有成功场景也有 worktree bug | 未正式保证 | v0 preset 不应无条件依赖链接；需要 host-specific 验证/fallback |

这里的“copy 支持”表示宿主官方就是从普通目录树扫描 Skill，因此 Skiloom 把受管内容复制成同样目录结构不会破坏发现。它不表示宿主会替 Skiloom管理 copy 生命周期。

## 7. 对 Skiloom 后续 Host preset 的直接输入

本调研不替 #23 做最终产品决定，但可以确定以下事实边界：

1. **不存在一个被四个宿主共同原生采用的唯一 Skill 根目录。** `.agents/skills` 已被 Codex 原生采用，并被 Gemini/OpenCode正式支持，但 Claude Code personal/project 仍使用 `.claude/skills`。
2. **一个 Host 可以有多个 scope。** 至少应区分 user 与 project/workspace；Codex、Claude、OpenCode 还会沿目录层级发现多个 project-local source。
3. **Target 应继续是“一个具体目录”，不要把 Host 抽象成唯一目录。** 同一个 Host preset 可以根据 scope/context 解析出不同 Target。
4. **Skiloom 的 flat Target 是安全公共子集。** Gemini 的一层发现限制尤其说明 `<target>/<activation-name>/SKILL.md` 是合适的最低共同布局。
5. **不依赖宿主自己的 duplicate/precedence 机制。** Codex、Claude、Gemini、OpenCode 对同名 Skill 的处理都不同；Skiloom 应继续在单个 Target 内先做自己的冲突 preflight。
6. **Host preset 不应通过把 `.claude`、`.gemini`、`.agents` 等整个根目录互相 symlink 来实现共享。** 这会制造重复扫描和宿主特有异常。Skiloom 应直接把 Package 投影到用户选择/Host preset解析出的 Skill Target。
7. **物理 materialization 需要 Host + platform 能力矩阵。** Codex/Claude/Gemini 有明确 symlink依据；OpenCode 需要更保守。Windows junction 应作为 Skiloom 平台实现能力验证，而不是假设所有 Host 都正式承诺。

## 8. #23 可以直接决定的事项

基于以上事实，#23 不再需要重新研究目录；只需决定：

- 首批 Host preset 的名字与 scope 输入；
- Codex / Claude Code / Gemini CLI / OpenCode 各 scope 的首选 Target 路径；
- `.agents/skills` 是否作为 Codex/Gemini/OpenCode 的共享便利 preset，而不是全局唯一标准目录；
- 每个 Host/platform 的 link/junction/copy 优先级和能力探测；
- Host preset 只负责“解析 Target + 能力提示”，还是还负责宿主配置修改；
- 对 OpenCode 是否优先使用其 native/compatibility directory，还是以后利用显式 `skills` path 配置。
