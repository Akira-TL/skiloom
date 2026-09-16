# Machine Registry SQLite v0

状态：Accepted

对应 Issue：#29 `Define Machine Registry SQLite schema and recovery tooling`

对应产品规范：[`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)

本文件固定 Skiloom 官方实现的本机 SQLite 状态库、全局操作锁、schema migration 和损坏恢复方式。这里的数据库文件名、表结构和迁移机制都是 **Skiloom 官方实现细节**，不是第三方需要依赖的公开数据格式。

## 1. Skiloom Home 布局

v0 官方实现固定：

```text
~/.skiloom/
├── registry.sqlite3
├── operation.lock
├── store/
└── backups/
```

含义：

- `registry.sqlite3`：当前本机 Machine Registry；
- `operation.lock`：所有状态型操作共用的机器级互斥锁载体；
- `store/`：按 Package Content Digest 寻址的共享不可变 Package Store；
- `backups/`：SQLite schema migration 前产生的数据库备份。

上述路径属于官方实现，不进入 Skiloom 公开导出格式，也不写入 Target `.skiloom-state`。

## 2. 单进程状态操作锁

Skiloom 不是常驻并发服务。v0 不建立复杂的多进程乐观并发协议，而是在执行状态型操作前取得 `~/.skiloom/operation.lock` 的 **操作系统级独占文件锁**。

必须取得同一把锁的操作包括：

- install / update / remove；
- sync / repair；
- 数据库丢失恢复；
- import；
- detach / forget；
- schema migration / backup restore；
- dependency/full export，因为导出必须观察一个不被并发修改的完整 Target 状态。

纯搜索、Catalog 浏览和不读取可变 Target 内容的只读查询不需要这把锁。

锁规则：

1. 锁的有效性由 OS file lock 决定，**不能以 `operation.lock` 文件是否存在判断是否被占用**；
2. 进程异常退出后，内核释放锁；残留的空文件不是 stale lock；
3. 取得锁后可以把 PID / command 等诊断文字写入文件，但这些文字不具有权威性；
4. 无法取得锁时返回 `OperationLocked`，不得强行删除文件或绕过锁；
5. v0 默认 fail fast，不自动排队执行第二个状态型操作。

`generation` 继续是 Target 状态版本和恢复判断依据，但不承担 Skiloom 进程之间的乐观并发控制职责。

## 3. SQLite 基线

打开 `registry.sqlite3` 时官方实现固定启用：

```text
PRAGMA foreign_keys = ON
PRAGMA journal_mode = WAL
PRAGMA synchronous = FULL
```

schema version 使用：

```text
PRAGMA user_version
```

数据库保存 **当前已接受状态**，不作为安装历史、审计日志或 event store。

核心关系必须正常建表；不得把一个 Target 的完整状态塞入单个巨大 JSON blob。只有 rename/routing 等可扩展的小型 transform 参数允许使用受应用层 schema 约束的 JSON 字段。

## 4. 权威表

### 4.1 `targets`

每个 Target Identity 一行：

```text
target_id        TEXT PRIMARY KEY
generation       INTEGER NOT NULL
```

约束：

- `target_id` 是 opaque random id；
- `generation >= 0`；
- 一次完整新状态提交只递增一次 generation。

Target path 不放在本表，因为 Target Identity 不等于某个项目路径或 worktree。

### 4.2 `target_locations`

记录本机见过的 Target 副本路径：

```text
path                 TEXT PRIMARY KEY
target_id            TEXT NOT NULL
observed_generation  INTEGER
```

`target_id -> targets.target_id`。

用途仅是本机定位与诊断。路径暂时不存在时 Target Identity 可以保持 dormant；同一个 `target_id` 也可能因为目录复制被观察到多个路径。

### 4.3 `direct_requirements`

记录用户当前对该 Target 的全部直接安装要求：

```text
target_id            TEXT NOT NULL
package_coordinate   TEXT NOT NULL
source_kind          TEXT NOT NULL   # github-release | git
version_requirement  TEXT NULL
git_requested_ref    TEXT NULL
PRIMARY KEY (target_id, package_coordinate)
```

规则：

- `github-release` 可以有 canonical version requirement，也可以为 NULL 表示未指定版本；
- `git` 必须有 `git_requested_ref`；
- Release 与 Git 的约束字段不得混用。

### 4.4 `resolved_sources`

每个 Target 中每个 repository 一条当前已接受的精确来源绑定：

```text
target_id             TEXT NOT NULL
repository_coordinate TEXT NOT NULL
source_kind           TEXT NOT NULL
release_version       TEXT NULL
actual_tag            TEXT NULL
git_requested_ref     TEXT NULL
exact_commit          TEXT NOT NULL
immutable_signal      INTEGER NULL
PRIMARY KEY (target_id, repository_coordinate)
```

其中：

- repository coordinate 已按 Skiloom 规则 canonicalize；
- `exact_commit` 始终必填；
- Release 保存已选 SemVer 与 actual tag；
- Git 保存用户 requested ref 与 exact commit；
- immutable signal 只是 provenance signal，不替代 commit / content digest。

### 4.5 `resolved_packages`

每个 Target 中每个 Package coordinate 恰好一条：

```text
target_id             TEXT NOT NULL
package_coordinate    TEXT NOT NULL
repository_coordinate TEXT NOT NULL
package_root          TEXT NOT NULL
content_digest        TEXT NOT NULL
PRIMARY KEY (target_id, package_coordinate)
```

`repository_coordinate` 必须引用同一 Target 的 `resolved_sources`。

### 4.6 `dependency_edges`

保存当前完整精确图中的依赖边：

```text
target_id          TEXT NOT NULL
from_package       TEXT NOT NULL
to_package         TEXT NOT NULL
PRIMARY KEY (target_id, from_package, to_package)
```

两端都必须引用同一 Target 的 `resolved_packages`。cycle 合法。

### 4.7 `projections`

保存 Package 在 Target 中的当前投影和所有权：

```text
target_id          TEXT NOT NULL
package_coordinate TEXT NOT NULL
activation_name    TEXT NOT NULL
ownership          TEXT NOT NULL    # managed | detached
materialization    TEXT NOT NULL    # symlink | junction | copy
transform_json     TEXT NULL
PRIMARY KEY (target_id, package_coordinate)
UNIQUE (target_id, activation_name)
```

规则：

- `transform_json` 只保存可确定性重建的小型 rename/routing 参数；
- 普通投影没有 transform 时为 NULL；
- detached projection 的 bytes 不进入数据库；
- foreign / forgotten 内容不进入此表。

### 4.8 `detached_baselines`

Detached Override 必须保留 detach 时的 baseline provenance，而不是把后续用户字节当作 Skiloom Package：

```text
target_id             TEXT NOT NULL
package_coordinate    TEXT NOT NULL
repository_coordinate TEXT NOT NULL
source_kind           TEXT NOT NULL
release_version       TEXT NULL
actual_tag            TEXT NULL
git_requested_ref     TEXT NULL
exact_commit          TEXT NOT NULL
package_root          TEXT NOT NULL
content_digest        TEXT NOT NULL
PRIMARY KEY (target_id, package_coordinate)
```

这条 baseline 可以与 Target 后来接受的新来源/version 不同，用于 update 警告、诊断和恢复说明。

## 5. 可重建观察表

宿主软件 / 特殊依赖观察不是 Exact Installation Resolution 的一部分，但官方实现可以把它们一并保存在同一 SQLite 中。

建议单表：

```text
dependency_observations
  target_id
  package_coordinate
  package_content_digest
  kind               # software | special
  name
  status
  detected_version   NULL
  location           NULL
  note               NULL
  PRIMARY KEY (target_id, package_coordinate, kind, name)
```

`package_content_digest` 是 freshness anchor。Package digest 改变时，该 Package 的旧 observation 失效并可删除。

这些 observation 可删除重建，不参与 Target generation，也不影响 resolver/source authority。

## 6. 不做历史数据库

Machine Registry 不长期保存：

- 旧 generation 的完整依赖图；
- 已删除 Direct Install Requirement 的历史；
- 旧来源集合；
- CLI 操作审计流水；
- Catalog 搜索结果；
- 用户凭据、GitHub token、Catalog API key 或其他 secret。

长期可传播的精确状态由显式 export 负责；SQLite 只维护这台机器当前接受的状态。

## 7. 一次状态变化的执行顺序

全程持有 `operation.lock`。

```text
1. 读取当前已接受状态
2. 在事务外完成 source/resolver、Store 获取、Target 安全 preflight
3. 准备新 projection 的 sibling temp 内容
4. 用户/策略接受完整新状态
5. 写入临时进行中操作记录
6. 执行 Target 文件系统变化
7. 一个 SQLite transaction 替换该 Target 的完整当前状态并 generation + 1
8. 删除进行中操作记录
9. 最后写/更新 Target `.skiloom-state` generation
```

步骤 7 必须是单一 SQLite transaction：同一 Target 的 direct requirements、resolved sources/packages、dependency edges、projection/detach state 与 generation 要么一起成为当前状态，要么完全不改变。

Store entry 在进入 Target 变更前必须已经完整写好并通过 Package Content Digest 验证；Store immutable，因此不需要与 Target state transaction 做数据库级联合事务。

## 8. 最小崩溃恢复日志

SQLite 与任意 Target filesystem 不能形成真正的跨资源 ACID transaction。v0 不因此建立历史库，只保留一个 **临时、可删除的进行中操作日志**。

建议：

```text
pending_operations
  operation_id
  target_id
  base_generation
  next_generation

pending_projection_actions
  operation_id
  target_path
  activation_name
  action_kind
  action_json
```

它只描述当前一个未完成状态型操作需要安全识别的 Target 路径动作，不保存长期历史。

正常完成后立即删除。

如果进程在 SQLite 最终状态提交前中断：

- 当前 accepted state 仍是旧 generation；
- 下次取得 `operation.lock` 后检测到 pending operation；
- Skiloom 只根据旧 accepted state + pending action 信息清理本次自己创建的临时/新路径，并把 Target 精确恢复到旧 accepted state；
- 中断的安装/更新不自动视为已经完成，用户重新运行原操作。

如果 SQLite 最终状态已经提交但 marker 尚未更新：

- pending rows 与最终 transaction 一起删除；
- DB generation 高于 `.skiloom-state`；
- 下次按既有规则把 Target/marker sync 到数据库当前 accepted state。

因此 pending log 是崩溃恢复工具，不是第二份 Lock，也不是安装历史。

## 9. Schema migration

使用 `PRAGMA user_version` 作为唯一 schema generation。

打开数据库：

1. DB `user_version == current`：正常；
2. DB `user_version < current`：必须持有 `operation.lock`，先做 backup，再按版本顺序 migration；
3. DB `user_version > current`：返回 `RegistrySchemaTooNew`，拒绝写入，不猜测兼容；
4. v0 不支持自动 downgrade。

Migration 要求：

- 使用 SQLite backup API 把迁移前完整数据库复制到 `~/.skiloom/backups/`；
- migration 按版本逐步执行；
- 每一步在 transaction 内完成；
- 只有该步完整成功后才提高 `PRAGMA user_version`；
- migration 失败保持原 schema version，并保留 backup；
- backup retention 属于后续运维策略，不在 v0 schema 契约里固定数量。

## 10. 完整性检查与损坏处理

正常打开数据库至少执行 SQLite 基础完整性检查；官方 `doctor` 可以执行更完整的 `integrity_check`。

发现数据库结构或页面损坏时返回：

```text
RegistryCorrupt
```

并 fail closed。

禁止：

```text
发现损坏
→ 自动删除 registry.sqlite3
→ 扫描 .agents/skills
→ 猜测哪些内容原来属于 Skiloom
```

允许的恢复路线只有：

### 10.1 从可信 migration backup 恢复

用户明确选择某个 backup 后恢复数据库，再按 Target Identity / Generation 规则检查所有已知 Target。

如果 Target marker generation 高于恢复后的数据库 generation，这是既有 rollback/recovery anomaly，不能静默把 Target 反向采纳进数据库。

### 10.2 按数据库丢失流程恢复

没有可用可信 backup 时，用户明确进入数据库丢失恢复：

- 从各 Target `.skiloom-state` 取得 direct requirements 与稀疏 override；
- 重新解析完整依赖图；
- 重新确认完整来源集合；
- 形成新的 accepted state；
- 不把未知目录、额外 symlink 或本地修改 bytes 猜成原 Package identity。

这不是 exact replay。

## 11. Credential 边界

`registry.sqlite3`、backup 和 `.skiloom-state` 都不得保存：

- GitHub token；
- Catalog API key；
- password；
- SSH private key；
- bearer token；
- 其他访问 secret。

数据库只保存来源事实和解析结果。凭据由环境、系统凭据设施或对应 credential provider 在运行时提供。

## 12. 一句话模型

```text
operation.lock
    = 串行化所有状态型 Skiloom 操作

registry.sqlite3
    = 当前已接受的完整本机 Target 状态

pending operation rows
    = 一次操作崩溃时的临时清理线索，不是历史

store/
    = 不可变 Package 内容

.skiloom-state
    = Target 身份、generation 与恢复线索
```
