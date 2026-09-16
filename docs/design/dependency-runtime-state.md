# Dependency Runtime State v0

状态：Partially Superseded

当前说明：环境 requirement 与观察状态的职责分离继续有效；固定 `.agents/.skiloom/dependencies.lock` 项目路径已经退役，观察结果的物理存储属于官方实现细节。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

对应 Wayfinder：#8 `Define the external software dependency model`

对应历史 ADR：[`0010-dependency-runtime-state.md`](../adr/0010-dependency-runtime-state.md)。

## 1. `dependencies.lock` 只保存观察结果

Package requirement 的 source of truth 已经存在于 immutable Package Snapshot：

```text
skiloom-package.toml [software]
DEPENDENCIES.md
```

因此 `.agents/.skiloom/dependencies.lock` 不复制 requirement 文本或单文件 digest，只保存“当前这台机器观察到了什么”。

Canonical schema：

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

## 2. Package-level `content-digest` 是唯一 freshness anchor

不再保存：

```text
dependencies-doc-digest
manifest-digest
software requirement copy
```

原因：`skiloom-package.toml`、`DEPENDENCIES.md` 和它们的 requirement 都属于 Package Snapshot。任意 byte 变化都会改变 Package `content-digest`。

因此：

```text
state.content-digest == current skiloom.lock package content-digest
```

是该 Package dependency observations 仍可复用的最低前提。

若 digest 不同，整个 Package dependency state 失效：

- software records 重新 probe；
- special records 删除并回到未检查状态。

## 3. Common software 每次 `sync` / `doctor` 重新 probe

Common software probe 本来就限定为少量便宜、只读的 runtime/executable/version 检查，因此 v0 不把 `dependencies.lock` 当长期 software probe cache。

当当前 Package Manifest 存在 `[software]`：

- `sync` 对当前 resolved graph 中声明的软件重新 probe；
- `doctor` 同样重新 probe；
- probe 结果覆盖对应 `[[package.software]]`；
- requirement 本身从 Store 中的 Manifest 读取，不复制进 state file。

这样不需要 TTL、`checked-at` 或复杂环境 fingerprint。

## 4. 状态枚举统一保持五种

v0 对 software 与 special observation 共用：

```text
unknown
satisfied
missing
incompatible
blocked
```

固定语义：

- `unknown`：尚未检查，或检查结果不足以判断 requirement；
- `satisfied`：已确认满足；
- `missing`：所需对象/能力不存在；
- `incompatible`：对象存在但不满足版本/兼容性 requirement；
- `blocked`：由于权限、策略、不可访问服务等原因无法完成检查或满足 requirement。

`note` 可选，用于保存不能由结构化字段表达的简短本机观察。

## 5. Software observation 最小字段

固定：

```text
name
status
```

可选：

```text
detected-version
location
note
```

不保存：

```text
requirement
checked-at
probe command
provider / package-manager choice
install command
```

`name` 必须是当前 Manifest `[software]` 中的 canonical key。`detected-version` 和 `location` 只有成功发现时才出现。

## 6. Special observation 由 Agent 管理

`DEPENDENCIES.md` 是 Agent-readable natural-language contract，Skiloom Core 不把它强行解析成结构化 requirement schema。

Agent 在完成只读检查后可以写：

```toml
[[package.special]]
name = "GitHub authentication"
status = "satisfied"
note = "Target private repository is readable with the current identity."
```

规则：

- `name` 是 Package 内 human-readable observation label；同一 Package 内应唯一；
- absence of a special record = 未记录/需要按 `DEPENDENCIES.md` 判断，不需要预生成 `unknown` record；
- 不保存 `checked-by = "agent"`，因为 special observation 本身就由 Agent 流程管理；
- v0 不设基于时间的自动过期；Package digest 变化、用户/Agent 明确要求 recheck，或 Agent 已知环境变化时重新检查；
- 任何安装、升级、登录、下载、配置、服务变更仍必须先取得用户批准，`dependencies.lock` 不是授权记录。

## 7. Writer ownership 与 canonical output

声明支持 Host Observation Extension 的 Skiloom implementation / reference manager 负责：

- Package state 的 `coordinate` / `content-digest`；
- `[[package.software]]` probe records；
- orphan / stale Package state 清理。

这些 writer responsibilities 不属于 Full Core P/R/A conformance。Agent 负责：

- `[[package.special]]` observation records。

任一 writer 重写文件时必须保留另一类仍有效记录，并使用 atomic replace。

Canonical output：

1. `[[package]]` 按 coordinate UTF-8 bytes 升序；
2. 每个 Package 下 software 按 `name` 升序；
3. special 按 `name` 升序；
4. UTF-8、LF、无生成注释；
5. 不写时间戳，避免无意义 churn。

Package 若当前既没有 `[software]`，也没有 special observations，可以从 `dependencies.lock` 完全省略。

## 8. 可删除、可重建边界

`.agents/.skiloom/dependencies.lock` 不是 reproducible resolution state，也不是授权日志。

删除它的结果只是：

- common software 在下一次 `sync` / `doctor` 重新 probe；
- special requirements 失去旧 observation，需要 Agent 在需要时重新检查。

不会影响：

- Package resolution；
- Package Store；
- `.agents/skills/` activation；
- source provenance。
