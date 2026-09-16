# 软件依赖说明与本地状态模型 v0

状态：Partially Superseded

当前说明：Package 侧软件/特殊环境 requirement 的产品语义继续有效；旧项目级 `dependencies.lock` 路径和 canonical runtime-state schema 已退役。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

对应历史 Wayfinder：#8 `Define the external software dependency model`

历史运行时状态设计见 [`dependency-runtime-state.md`](dependency-runtime-state.md) 与 [`0010-dependency-runtime-state.md`](../adr/0010-dependency-runtime-state.md)。

## 1. Package 最低条件仍只有 `SKILL.md`

软件/环境依赖能力是可选增强，不影响普通 Skill 安装。

一个 Package 可以只有：

```text
foo/
└── SKILL.md
```

也可以增加：

```text
foo/
├── SKILL.md
├── skiloom-package.toml       # optional structured Skill/software requirements
└── DEPENDENCIES.md        # optional Agent-readable special requirements
```

两种可选文件职责不同，Skiloom 不因为缺失它们而拒绝 Package。

## 2. 三层依赖模型

```text
Skill dependency
→ optional skiloom-package.toml [dependencies]
→ Skiloom Resolver 自动解析/安装

常见可机械探测软件
→ optional skiloom-package.toml [software]
→ Skiloom Core 只读 probe
→ .agents/.skiloom/dependencies.lock

复杂软件/硬件/服务/数据/授权条件
→ optional immutable DEPENDENCIES.md
→ Agent 检查/解释
→ .agents/.skiloom/dependencies.lock
```

没有声明时，Skiloom 不从 `SKILL.md` 自然语言、目录名或脚本内容猜测 requirement。

## 3. `DEPENDENCIES.md` 永不写当前状态

`DEPENDENCIES.md` 存在时属于 immutable Package payload，只描述：

- requirement；
- check 方法；
- resolution guidance；
- 哪些环境修改必须先征求用户批准。

例如：

```markdown
# Dependencies

## Special requirements

### Blender
- Requirement: Blender 4.3+ with Example Add-on enabled.
- Check: verify version and Add-on state.
- Resolution: explain the gap and ask before modifying Blender.
```

当前机器 observation 永远写 `.agents/.skiloom/dependencies.lock`，不得回写 `DEPENDENCIES.md`。

## 4. `[software]` 是可选结构化 probe 输入

Package Manifest 可以声明少量 Skiloom 内建 probe 支持的常见软件：

```toml
[software]
git = ">=2.40"
gh = ">=2.45"
python = ">=3.11"
node = ">=22"
```

Skiloom Core 对这些 requirement 最多：

- 找 executable/runtime；
- 尝试读取版本；
- 判断当前 requirement 是否满足；
- 写本机 observation。

Skiloom Core 不执行：

- 安装/升级/删除软件；
- 自动选择 apt/brew/winget/choco 等 provider；
- 修改 PATH；
- 登录或写凭据；
- 驱动/服务/系统配置变更；
- Package 自定义系统安装脚本。

## 5. `.agents/.skiloom/dependencies.lock`

它是当前机器的可重建 observation state，默认不提交版本控制：

```toml
lock-version = 1

[[package]]
coordinate = "akira-tl/matt-skills/ask-matt"
content-digest = "sha256:3333333333333333333333333333333333333333333333333333333333333333"

[[package.software]]
name = "git"
status = "satisfied"
detected-version = "2.45.2"
location = "/usr/bin/git"

[[package.software]]
name = "gh"
status = "missing"

[[package.special]]
name = "GitHub authentication"
status = "unknown"
note = "Private repository access has not been checked yet."
```

Package `content-digest` 是唯一 freshness anchor。`dependencies.lock` 不重复：

```text
dependencies-doc-digest
manifest-digest
software requirement
checked-at
checked-by
probe command
provider/package-manager choice
install command
```

## 6. Observation status

Software 与 Special observation 共用：

```text
unknown
satisfied
missing
incompatible
blocked
```

语义：

- `unknown`：尚未检查，或证据不足以判断；
- `satisfied`：已经确认满足；
- `missing`：所需对象/能力不存在；
- `incompatible`：对象存在，但版本或兼容条件不满足；
- `blocked`：权限、策略、服务不可访问等使检查或满足 requirement 无法完成。

## 7. Common software 每次 `sync` / `doctor` 重新 probe

Common software probe 被限定为便宜的只读检查，所以 v0 不把 software observation 当长期缓存：

```text
sync
→ 对当前 resolved graph 中 [software] 重新 probe

doctor
→ 对当前 resolved graph 中 [software] 重新 probe
```

因此不需要 TTL、时间戳或复杂环境 fingerprint。

当 Package `content-digest` 变化时，该 Package 原有 dependency state 全部失效：

- software 重新 probe；
- special observation 删除，回到未保存 observation 的状态。

## 8. Special dependency 由 Agent 管理

Skiloom Core 不把 `DEPENDENCIES.md` 强行解析成结构化 requirement schema。

Agent 完成只读检查后可以记录：

```toml
[[package.special]]
name = "GitHub authentication"
status = "satisfied"
note = "Target private repository is readable with the current identity."
```

同一 Package 内 `name` 应唯一。不存在对应 special record 表示没有已保存 observation，不要求提前写一个 `unknown` record。

Special observation 不按时间自动过期；以下情况重新检查：

- Package `content-digest` 变化；
- 用户或 Agent 明确要求重新检查；
- Agent 已知相关外部环境发生变化。

需要安装、升级、登录、下载、修改配置、启停服务或其他环境写入时，仍必须先取得用户批准；`dependencies.lock` 不是授权记录。

## 9. Writer ownership

Skiloom Core 负责：

- Package `coordinate` / `content-digest`；
- `[[package.software]]` records；
- stale/orphan Package state 清理。

Agent 负责：

- `[[package.special]]` records。

任一 writer 原子重写文件时，都必须保留另一类仍有效 records。

Canonical output：

1. `[[package]]` 按 coordinate UTF-8 bytes 升序；
2. 每个 Package 的 software 按 `name` 升序；
3. special 按 `name` 升序；
4. UTF-8、LF、无生成注释；
5. 不写时间戳。

Package 若没有 `[software]` 且没有 special observations，可以完全省略。

## 10. 可删除、可重建

删除 `.agents/.skiloom/dependencies.lock` 只会导致：

- 下一次 `sync` / `doctor` 重新做 common software probe；
- Special requirement 在需要时由 Agent 重新检查。

不会改变：

- `.agents/.skiloom/skiloom.lock` resolution；
- Package Store；
- source provenance；
- `.agents/skills/` activation。

## 11. 可复用 Agent 能力仍使用 Skill dependency

如果 requirement 本质上是另一个 Agent Skill 能力，而作者希望 Skiloom 自动安装，应声明：

```toml
[dependencies]
"owner/repo/helper-skill" = "^1.0"
```

不要通过 repository shared runtime directory、`DEPENDENCIES.md` 或 software probe 隐式表达 Skill dependency。
