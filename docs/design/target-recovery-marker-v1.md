# `.skiloom-state` v1 公开格式

状态：Accepted

对应 Issue：#32 `Define .skiloom-state v1 public recovery format`

对应产品规范：[`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)

`.skiloom-state` 是每个 Skiloom-managed Target 根目录中的轻量恢复锚点。它公开保存 Target Identity、该目录副本最后同步的 Target Generation、用户直接安装要求，以及恢复目标侧语义必须保留的稀疏 override。它不是完整精确安装状态、不是旧式 Lock，也不是用户内容备份。

## 1. 文件位置与编码

文件名固定为：

```text
<target>/.skiloom-state
```

v1 使用 UTF-8 TOML。格式标识固定为：

```toml
format = "SKILOOM-STATE-V1"
```

Skiloom writer 必须通过 sibling temporary file + atomic replace（在当前平台能力允许的范围内）写入完整新文件，不允许原地逐段修改。

`.skiloom-state` 是 machine-managed state file，不是用户配置文件。Skiloom 不承诺在重写时保留用户手写注释、空白或原始字段顺序。

## 2. 顶层字段

v1 顶层必须且只能包含：

```toml
format = "SKILOOM-STATE-V1"
target-id = "550e8400-e29b-41d4-a716-446655440000"
generation = 12
```

以及零个或多个：

```toml
[[requirements]]
[[projection-overrides]]
[[detached]]
```

字段含义：

- `format`：必须精确等于 `SKILOOM-STATE-V1`；
- `target-id`：canonical lowercase UUID v4 文本；它在产品语义上仍是 opaque random identity，消费者不得从 UUID 内容推导项目、仓库、主机或路径含义；
- `generation`：非负整数，表示当前这个目录副本最后成功同步到的 Target Generation。

## 3. `[[requirements]]` — 直接安装要求

每条直接安装要求必须包含：

```toml
[[requirements]]
kind = "package"            # package | repository
coordinate = "owner/repo/pkg"
source = "github-release"   # github-release | git
```

### 3.1 Package requirement

```toml
[[requirements]]
kind = "package"
coordinate = "akira-tl/skills/ask-matt"
source = "github-release"
version = "^1.4.0"
```

`kind = "package"` 时，`coordinate` 必须是 canonical `<owner>/<repo>/<package>`。

### 3.2 Repository-wide requirement

```toml
[[requirements]]
kind = "repository"
coordinate = "akira-tl/extra-skills"
source = "git"
ref = "main"
```

`kind = "repository"` 时，`coordinate` 必须是 canonical `<owner>/<repo>`，表示每次重新解析时把候选 exact repository snapshot discovery 出来的全部 Package 作为直接 roots。

### 3.3 Release requirement

`source = "github-release"` 时：

- `version` 可选；
- 存在时必须是 Skiloom canonical Release Version Requirement；
- 缺失表示用户没有固定版本要求；
- 不允许 `ref`。

### 3.4 Git requirement

`source = "git"` 时：

- `ref` 必填，保存用户当初请求的 Git ref；
- 不允许 `version`。

Marker 不保存这条 requirement 上次解析到的 exact commit；数据库丢失恢复必须重新解析并重新接受完整新状态。

### 3.5 唯一性

同一 Marker 中 `(kind, coordinate)` 必须唯一。重复条目即无效 Marker，不做 last-one-wins 合并。

同一 repository 可以同时存在 repository-wide requirement 与一个或多个 Package requirement；它们表达不同的用户直接安装意图。

## 4. `[[projection-overrides]]` — 非默认投影名

只保存不能由默认 Package Name 推导的非默认 activation name：

```toml
[[projection-overrides]]
package = "akira-tl/skills/ask-matt"
activation-name = "matt"
```

规则：

- `package` 必须是 canonical Package Coordinate；
- `activation-name` 必须满足当前 Agent Skill name / Target projection name 的合法性要求；
- 同一 `package` 最多一条；
- 只允许保存非默认名字；若 `activation-name` 等于 Package 默认 name，writer 必须省略该条目。

v1 不保存：

- symlink / junction / copy 物理 materialization；
- dependency routing overlay 的展开内容；
-内部 transformed-copy 文件列表。

Dependency Routing Overlay 必须在恢复后根据重新解析得到的 dependency edges + 当前 projection names 确定性重建。物理 materialization 由恢复机器当前平台能力重新选择。

## 5. `[[detached]]` — Detached Override 恢复标记

每个仍有 logical binding 的 Detached Override 保存一条：

```toml
[[detached]]
package = "akira-tl/skills/local-helper"
baseline-source = "github-release"
baseline-version = "1.2.0"
baseline-tag = "v1.2.0"
baseline-commit = "0123456789abcdef0123456789abcdef01234567"
baseline-package-root = "skills/local-helper"
baseline-content-digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

共同必填字段：

- `package`：canonical Package Coordinate；
- `baseline-source`：`github-release | git`；
- `baseline-commit`：40 lowercase hex Git commit id；
- `baseline-package-root`：repository-relative Package Root；
- `baseline-content-digest`：`sha256:<64 lowercase hex>`。

### 5.1 Release baseline

`baseline-source = "github-release"` 时还必须包含：

- `baseline-version`：detach 时已接受的 normalized SemVer；
- `baseline-tag`：detach 时实际 GitHub tag。

且不得出现 `baseline-ref`。

### 5.2 Git baseline

`baseline-source = "git"` 时还必须包含：

- `baseline-ref`：detach 时 Direct Install Requirement / source binding 中保留的 requested ref（若该 Package 来源于传递依赖，则保存当时 repository source binding 对应的 requested ref）。

且不得出现 `baseline-version` / `baseline-tag`。

### 5.3 Detached bytes 不在 Marker 中

`baseline-content-digest` 只描述 detach 发生时的受管 Package Snapshot，不描述用户后来修改后的当前目录内容。

Marker：

- 不保存 Detached Override 当前 bytes；
- 不计算或声称当前 user-owned bytes 等于 baseline digest；
- 不把 Detached Override 当前内容重新采纳成 Skiloom Package identity。

数据库丢失恢复时，如果重新解析后的图仍需要该 Package，Skiloom 必须保留 user-owned override，不能覆盖它。若新的图不再需要该 logical binding，用户目录仍是 foreign/user-owned 内容，不得删除或猜测采纳。

同一 `package` 最多一条 `[[detached]]`。

## 6. 明确不保存的内容

v1 Marker 不保存：

- 完整 transitive dependency graph；
- exact resolved source set；
- transitive Package version/tag/commit；
- Package Store 物理路径；
- Git/source cache 路径；
- Target 绝对路径；
- Host preset 或 scope；
- symlink/junction/copy materialization choice；
- dependency routing overlay 展开内容；
- Catalog metadata / score / audit；
- source authorization history；
- credentials、token、API key；
- Detached Override 当前用户字节；
- foreign / forgotten Skill 清单。

如果实现需要上述日常精确事实，应从 Machine Registry 读取，而不是扩张 Marker。

## 7. 严格解析与错误

v1 采用 fail-closed 严格 schema。

以下任一情况返回 `InvalidTargetState`：

- TOML 语法错误；
- 缺少 v1 必填字段；
- 出现 v1 schema 未定义的顶层字段、table 或 table 字段；
- `target-id` 不是 canonical lowercase UUID v4；
- `generation` 不是非负整数；
- coordinate / version requirement / activation name / commit / digest / Package Root 非法；
- Release 字段与 Git 字段混用；
- 重复 requirement、projection override 或 detached binding；
- default activation name 被错误写成 projection override；
- 同一 Package 的 sparse metadata 自相矛盾。

如果 `format` 是未知版本，例如：

```toml
format = "SKILOOM-STATE-V2"
```

返回 `UnsupportedTargetStateVersion`，不得按 v1 猜测解析，也不得用旧程序自动重写降级。

严格 unknown-field 行为的目的，是避免拼写错误或未来语义被旧程序静默丢弃。

## 8. Canonical writer

Parser 不依赖 TOML table 出现顺序，但 Skiloom v1 writer 必须生成稳定输出。

顶层顺序：

```text
format
target-id
generation
requirements
projection-overrides
detached
```

数组稳定排序：

- `requirements`：先按 `kind`，再按 canonical `coordinate` raw UTF-8 byte order；
- `projection-overrides`：按 canonical Package Coordinate；
- `detached`：按 canonical Package Coordinate。

同一个逻辑 Marker 经 canonical writer 重写必须得到稳定等价文本，不得依赖数据库查询顺序或 JavaScript Map 插入顺序。

## 9. 与 Machine Registry 的关系

日常状态权威仍是 Machine Registry。Marker 不参与正常 resolver candidate ordering，也不替代当前已接受的精确状态。

一次新状态接受顺序固定：

```text
candidate accepted
→ Store 已验证
→ SQLite transaction 提交 generation N，成为新权威
→ materialize/reconcile Target
→ canonical write .skiloom-state generation N
```

如果数据库已经是 generation N、但 Marker 仍是 N-1，则该目录副本是 stale copy；后续按 Machine Registry -> Target 单向 `sync`。

如果 Marker generation 高于数据库，属于 rollback/recovery anomaly，fail closed，不把 Marker 或 live filesystem 反向采纳进数据库。

## 10. Marker 缺失或损坏

### 10.1 Machine Registry 完整

Marker 缺失或无效时，不得直接覆盖。

Skiloom 必须先验证 Target projection 是否与数据库当前 accepted state 一致；只有完整验证成功时，才允许从数据库当前状态重新生成 canonical Marker。

验证失败则进入 reconcile/fail-closed，不猜测 unknown/foreign 内容所有权。

### 10.2 Machine Registry 丢失

数据库不存在且 Marker 也缺失/无效时，没有足够信息执行 Target recovery。

Skiloom 不得扫描 Target 目录猜测：

- 原 Direct Install Requirements；
- Package coordinate；
- source identity；
- managed ownership。

该 Target 只能作为现存文件系统内容对待，直到用户显式提供新的管理意图。

## 11. 数据库丢失恢复

合法 v1 Marker 在 Machine Registry 丢失时只提供 recovery candidate 输入：

```text
Direct Install Requirements
+ projection overrides
+ Detached Override baseline markers
```

Skiloom 必须：

1. 根据 Direct Install Requirements 重新解析完整图；
2. 对新得到的完整 source set 重新做来源确认；
3. 应用仍相关的 projection override；
4. 对仍相关的 Detached Override 保持 user-owned，不覆盖；
5. 向用户展示新候选与恢复结果；
6. 接受后创建新的本机精确状态。

这不是 exact replay。Marker 从不承诺恢复到数据库丢失前相同的 transitive version/commit。

## 12. v1 示例

```toml
format = "SKILOOM-STATE-V1"
target-id = "550e8400-e29b-41d4-a716-446655440000"
generation = 12

[[requirements]]
kind = "package"
coordinate = "akira-tl/skills/ask-matt"
source = "github-release"
version = "^1.4.0"

[[requirements]]
kind = "repository"
coordinate = "akira-tl/extra-skills"
source = "git"
ref = "main"

[[projection-overrides]]
package = "akira-tl/skills/ask-matt"
activation-name = "matt"

[[detached]]
package = "akira-tl/skills/local-helper"
baseline-source = "github-release"
baseline-version = "1.2.0"
baseline-tag = "v1.2.0"
baseline-commit = "0123456789abcdef0123456789abcdef01234567"
baseline-package-root = "skills/local-helper"
baseline-content-digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

## 13. 一句话边界

```text
.skiloom-state v1
= Target Identity + Generation
+ Direct Install Requirements
+ sparse projection rename
+ Detached Override baseline marker

!= exact dependency Lock
!= transitive resolution database
!= user-content backup
```
