# ADR 0010：依赖运行时状态只保存本机观察结果

- 状态：Partially Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：环境 requirement 与观察状态的职责分离继续有效；旧 `.agents/.skiloom/dependencies.lock` 项目路径和“四类项目状态”模型不再是当前产品权威。现行边界见 `docs/design/skiloom-v0-product-contract.md`。

## 背景

Skiloom 已经把 Package requirement 的来源固定在 immutable Package Snapshot 中：结构化常见软件 requirement 来自可选 `skiloom-package.toml [software]`，复杂软件、硬件、服务、数据与授权要求来自可选 `DEPENDENCIES.md`。早期 `.agents/.skiloom/dependencies.lock` 草案又复制了 requirement、`DEPENDENCIES.md` digest、检查时间与检查者等字段，造成同一事实存在多个来源，并引入没有必要的缓存失效规则。

## 决定

`.agents/.skiloom/dependencies.lock` 只保存当前机器的 dependency observations，不复制 immutable Package requirement。

每个 Package state 以 Package `content-digest` 作为唯一 freshness anchor：

```toml
[[package]]
coordinate = "akira-tl/matt-skills/ask-matt"
content-digest = "sha256:..."
```

Common software observation 固定字段为：

```text
name
status
```

可选字段为：

```text
detected-version
location
note
```

Special observation 固定字段为：

```text
name
status
```

可选 `note`。不保存 `checked-by`、`checked-at` 或授权信息。

Software 与 Special 共用五种 observation status：

```text
unknown
satisfied
missing
incompatible
blocked
```

进一步规则：

- `skiloom-package.toml`、`DEPENDENCIES.md` 或其中 requirement 任意 byte 变化都会改变 Package `content-digest`；digest 变化使该 Package 的全部 dependency observations 失效；
- Common software probe 只做少量便宜的只读 executable/runtime/version 检查，因此每次 `sync` 与 `doctor` 都重新 probe，不定义 TTL、`checked-at` 或环境 fingerprint；
- Special dependency 继续由 Agent 按 immutable `DEPENDENCIES.md` 检查；不存在 record 表示没有已保存 observation，不要求预生成 `unknown`；
- Skiloom Core 维护 Package identity 与 software observations；Agent 维护 special observations；任一 writer 原子重写文件时必须保留另一类仍有效 records；
- `dependencies.lock` 可以随时删除并重建，删除不会影响 Package resolution、Package Store、source provenance 或 `.agents/skills/` activation；
- `dependencies.lock` 不是环境修改授权日志。安装、升级、登录、下载、配置、服务变更等动作仍必须独立取得用户批准。

## 结果

项目的四类状态职责保持互斥：

```text
skiloom.toml          -> 用户意图
skiloom.lock          -> exact resolution
activation.lock   -> 当前机器的 Skill activation ownership/materialization
dependencies.lock -> 当前机器的 dependency observations
```

依赖状态文件因此可以保持小、可重建，并且没有 requirement duplication 或时间驱动的缓存一致性问题。
