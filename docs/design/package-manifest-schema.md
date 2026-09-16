# Package Manifest v0 Schema

状态：Partially Superseded

当前说明：`skiloom-package.toml` 的 Schema 1、Skill dependency、`[software]` 环境观察与禁止任意宿主写脚本等规则继续有效；Core / conformance / Confirmed Resolution 相关表述已退役。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

对应 Wayfinder：#4 `Define the Package Manifest schema and ownership boundaries`

> 公开文件名仍为 `skiloom-package.toml`。

## 1. 定位

Package Manifest 是可选增强文件。Skill Package 的最低准入条件仍只有合法 `SKILL.md`。

若 Manifest 不存在：

- Package 仍然是合法 Core Package；
- Core 不推断 Skill dependencies；
- Host Observation Extension 不推断 common software requirements。

若 Manifest 存在，Core implementation 必须先通过 Manifest envelope 与 Core 字段校验。不能把损坏的 Core dependency metadata 静默降级成“没有 Manifest 的裸 Skill”，因为这会改变 dependency graph。

Schema 1 同时提供一个已登记的 Host Observation Extension attachment point。Extension capability 缺失与 Core Manifest 无效是两个不同结果。

## 2. Schema 1 完整顶层结构

Schema 1 只登记三个顶层成员：

```toml
schema = 1

[dependencies]
"akira-tl/matt-skills/implement" = "^1.4"
"akira-tl/matt-skills/wayfinder" = "^1.4"

[software]
git = ">=2.40"
gh = ">=2.45"
```

ownership 固定为：

```text
schema
= Core Manifest envelope

[dependencies]
= Core Skill dependency semantics
= Class P/R 可观察 graph 输入

[software]
= registered Host Observation Extension attachment point
= 不进入 Skill dependency graph
= 不进入 Confirmed Resolution
= 不属于 Full Core P/R/A 必需能力
```

其中：

- `schema`：必填 integer，Schema 1 固定为 `1`；
- `[dependencies]`：可选 Core table；
- `[software]`：可选 registered extension table。

`schema = 1` 单独存在也是合法 Manifest，只是没有增强语义。

Schema 1 不定义 `[package]` table，也不接受其他未登记顶层 key/table。

## 3. Strict envelope

当 `schema = 1` 时，未知顶层字段或未知 table 是 Core envelope 错误：

```text
UnknownManifestField
```

例如：

```toml
schema = 1
name = "foo"
version = "1.0.0"

[package]
description = "..."

[features]
...
```

都不是合法 Schema 1 Manifest。

严格 envelope 的目的不是禁止未来 extension，而是让新字段必须先通过新的 Manifest schema 或明确登记的 extension attachment point 引入，避免旧实现因拼写错误或未知 graph-affecting 字段产生部分解释。

`[software]` 已在 Schema 1 中登记，因此“不实现 Host Observation Extension”不等于“未知顶层字段”。

## 4. Schema 演进

`schema` 使用正整数，不使用 `1.0` / `1.1`。

Core envelope 规则：

- 缺失 `schema`：`MissingManifestSchema`；
- 非 integer：`InvalidManifestSchema`；
- 当前实现不支持该 Manifest schema：`UnsupportedManifestSchema`；
- 不对未知 schema 做 best-effort 部分解析；
- 新增会改变 Core Package graph、identity、source 或其他 P/R/A 可观察语义的字段时，必须升级 Manifest schema；
- 同一个 schema 内只允许不改变数据模型的 parser bugfix / 校验澄清。

Host Observation Extension 可以有自己的 specification version/capability evolution，但只要它仍使用 Schema 1 的 `[software]` attachment point，就不得赋予该 table Core graph/source/host-write 语义。若未来需要改变 attachment 的结构类型或 Core envelope interpretation，再升级 Manifest schema。

未来实现可以同时支持多个已知 Manifest schema，但每个文件只声明一个 schema。

## 5. 不属于 Manifest Core identity 的字段

Schema 1 明确不保存：

```text
Package name
Package version
Skill description
Router / entrypoint flag
GitHub owner/repository
Release tag / commit
source kind / source URL
activation rename
project-local settings
platform/provider install commands
arbitrary scripts/hooks
license / author / homepage 等重复展示元数据
```

归属：

- Package name / description / Agent 行为 → `SKILL.md`；
- Release version / tag / commit / source provenance → source resolution + Project Lock；
- activation rename → Project Manifest；
- 特殊环境/硬件/服务/授权条件 → `DEPENDENCIES.md`；
- common software requirement → `[software]` Host Observation Extension attachment；
- 当前宿主 observation → project-local `dependencies.lock` reference state。

Manifest 不能通过增加字段建立第二套 Package identity/version/source authority。

## 6. Core `[dependencies]`

每个 key 表示一个 required Skill Package dependency：

```toml
[dependencies]
"owner/repo/package" = "<release-version-requirement>"
```

Core 结构规则：

- key 必须恰好包含三个非空 `/` 分隔段：`<owner>/<repo>/<package>`；
- `<package>` 必须符合当前引用的 Agent Skills `name` grammar；
- dependency 不允许省略 package，因此不能表达 repository-wide install；
- value 必须是非空 string；
- value 的具体 Release requirement grammar 由 #7 Class R Resolver 协议唯一拥有；Manifest schema 不复制第二套 grammar；
- Manifest dependency 不提供 `{ git = ... }`、URL、path、registry/provider 或其他 source override 语法；
- 如果 Project Intent 已把同 repository 显式绑定到 Git source，则 Resolver 按 repository-scoped binding 的既有规则处理；
- Schema 1 的全部 dependency edge 都是 required edge。

GitHub `owner/repo` 的 source semantics 由 [`source-trust-conformance.md`](source-trust-conformance.md) 定义：owner/repo 做 ASCII lowercase canonicalization，dependency graph、repository grouping 与 Lock 都使用 canonical coordinate；真正的 repository rename/transfer 不靠 redirect 静默迁移。#4 只定义 dependency coordinate 的结构位置与 required-edge 语义。

## 7. Registered `[software]` attachment

`[software]` 保留在当前物理 Package Manifest 中，以承载 ADR 0010 已接受的 common software observation 输入，但它的语义所有权属于 **Host Observation Extension**，不是 Core Skill dependency graph。

示例：

```toml
[software]
git = ">=2.40"
python = ">=3.11"
```

Core Manifest parser 对 Schema 1 的最低责任只有：

- 知道 `[software]` 是已登记 attachment，而不是 unknown field；
- 若存在，它必须是 TOML table；
- 不把其中 entry 转换成 Skill dependency edge、source constraint、Package identity 或 Confirmed Resolution 字段；
- 不因为当前实现没有 Host Observation Extension 或没有某个 probe capability，就把 otherwise-valid Package 判定为 Core-invalid。

Host Observation Extension specification 自行拥有：

- software requirement value grammar；
- canonical capability/probe identifiers；
- capability unsupported 行为；
- read-only probe semantics；
- observation status 与 machine-local state；
- extension 自身的 evolution/versioning。

因此 #7 **不再拥有** `[software]` 的 version requirement grammar。

任何 Host Observation implementation 都不得从 `[software]` 获得：

```text
probe command supplied by Package
install command
package-manager/provider choice
PATH/environment mutation
build/postinstall hook
其他宿主写操作
```

不支持 extension 或具体 observation capability，可以降低环境可见性；不能改变该 Package 的 Core Package admission、Skill dependency graph、source resolution、Package Content Digest 算法或 Confirmed Resolution。

## 8. Optional / features

Core Schema 1 不定义：

```text
optional dependencies
peer dependencies
feature flags
platform-conditioned Skill dependencies
extras / groups
```

所有 `[dependencies]` edge 都是 required edge。若未来确有需求，必须通过新的 Core Manifest schema 明确引入，不能让不同实现自行解释 Schema 1 中的隐式依赖语义。

Host Observation Extension 自己的环境适用条件不等价于 Core optional/platform-conditioned Skill dependency；两者不能混用。

## 9. 两层校验结果

Manifest validation 分成两个 ownership 层次。

### 9.1 Core Manifest validation

Core consumer 必须验证：

1. 文件是合法 TOML；
2. 顶层是 table；
3. `schema` 合法且被实现支持；
4. 只包含 Schema 1 已登记的顶层成员；
5. `[dependencies]` 若存在必须是 table；
6. dependency entry 类型、coordinate 与 #7 requirement grammar 全部合法；
7. `[software]` 若存在至少必须是 table attachment。

这些 Core 校验失败会使“该 Manifest 增强后的 Package”无法作为当前 Core schema Package 继续解析；实现不得静默丢弃 Core dependency metadata。

### 9.2 Host Observation Extension validation

只有声明支持 Host Observation Extension 的实现才解释 `[software]` payload。具体 key/value grammar、capability support 与 observation result 由 extension specification 决定。

Extension 不支持、某个 capability 不可用或 extension payload 无法被当前 Host Observation implementation 完整解释时：

- MUST NOT 把 Package 重新分类为 invalid Core Package；
- MUST NOT 删除/改写 Core `[dependencies]` graph；
- MUST NOT 写入另一份 Confirmed Resolution；
- reference manager MAY 阻止或降级**环境观察操作**并报告 extension-scoped diagnostic，但这种诊断不是 `InvalidOptionalManifest` 的 Core graph 错误。

## 10. Canonical semantics，不 canonicalize source bytes

TOML key 顺序、空白和注释不改变 Manifest 的解析语义；Core resolver 使用解析后的 `[dependencies]` map，Host Observation implementation 使用解析后的 extension payload。

但 Manifest 原始文件 bytes 属于 immutable Package Snapshot，因此纯格式变化仍会改变 Package `content-digest`。snapshot 前不得为了 Manifest 语义而自动格式化、重排或重写作者 TOML。

是否支持 Host Observation Extension也不得改变同一 Package Snapshot 的 `content-digest`。

## 11. Schema 1 摘要

```text
Package Manifest optional
  └─ present -> strict Core envelope
       ├─ schema = 1
       ├─ [dependencies]  Core required Skill edges
       └─ [software]      registered Host Observation Extension attachment

Core:
  SKILL.md-first admission
  no duplicate identity/version/source
  no source overrides
  no optional/features graph semantics
  no arbitrary host commands

Host Observation Extension:
  optional capability
  own software grammar/probe semantics
  unsupported capability != invalid Core Package
  never changes Core graph / Lock / content identity
```
