# ADR 0021：Machine Registry SQLite 与全局状态操作锁

- 状态：Accepted
- 日期：2026-09-16

## 背景

Skiloom 已经确定：本机 SQLite 状态库保存每个 Target 当前已接受的完整精确安装状态；Package Store 保存不可变内容；Target `.skiloom-state` 只保存身份、generation 与恢复线索。剩余问题是官方实现如何物理持久化这些事实、如何迁移数据库、如何处理损坏，以及是否需要复杂的并发控制。

Skiloom 不是常驻多写服务。与其为低概率的并发安装建立复杂的乐观并发协议，v0 更适合采用类似系统包管理器的单写者模型。

## 决定

1. 官方实现把 Machine Registry 固定为 `~/.skiloom/registry.sqlite3`，Package Store 位于 `~/.skiloom/store/`，迁移备份位于 `~/.skiloom/backups/`。
2. 所有会读取并改变 Target/Registry 一致状态的操作使用同一个 `~/.skiloom/operation.lock` OS 级独占文件锁。锁由操作系统持有，不以 lock file 是否存在判断占用；异常退出后内核释放锁。无法取得时返回 `OperationLocked`。
3. `generation` 继续用于 Target 状态版本与恢复判断，但不作为 Skiloom 多进程写入的主要并发协议。
4. SQLite 只保存当前已接受状态，不长期保存旧 generation 的完整图或操作历史。核心关系采用关系表：Target、位置、直接安装要求、精确来源、Package、依赖边、投影和 Detached Override baseline。直接安装要求同时支持 Package coordinate 与 repository-wide `owner/repo` requirement；后者的当前展开结果由 exact snapshot discovery 后的 `resolved_packages` 表达。小型 transform 参数可使用受约束 JSON。
5. dependency observation 可以存在同一数据库中，但属于可删除重建的非权威观察状态，不参与 Target generation。
6. 一次完整状态变化先完成来源/解析/Store/Target preflight 和用户接受，然后用一个 SQLite transaction **先**原子替换该 Target 的完整当前状态并递增 generation，再严格按数据库新状态 materialize/reconcile Target，最后同步 `.skiloom-state` generation。SQLite 新状态先成为权威；Target 若中断或失败，只能随后从 Machine Registry 单向 `sync`，不能反向采纳残留文件系统状态。
7. 因 SQLite 与 Target filesystem 不能形成跨资源 ACID transaction，v0 只允许最小 `pending_operations` / `pending_projection_actions` 线索标识 Skiloom 自己创建的 sibling staging/temp 路径。它只用于安全清理临时内容，不承担 live Target 回滚、安装历史或第二份 Lock 职责。
8. schema version 使用 `PRAGMA user_version`。旧 schema 在持有操作锁时先通过 SQLite backup API 备份，再逐版本 transaction migration；新于当前程序支持的 schema 返回 `RegistrySchemaTooNew`；v0 不自动 downgrade。
9. 数据库损坏返回 `RegistryCorrupt` 并 fail closed。不得删除数据库后扫描 Target 猜测 Package identity。恢复只能显式选择可信 backup，或进入既有数据库丢失恢复流程重新解析和重新确认来源。
10. Registry、backup 与 Target marker 不保存 GitHub token、Catalog API key 或其他凭据。
11. SQLite 路径、表名、字段、migration 和 operation lock 都是 Skiloom 官方实现细节，不成为公开可移植格式。

完整 schema 和恢复流程见 [`../design/machine-registry-sqlite.md`](../design/machine-registry-sqlite.md)。

## 结果

- Skiloom v0 采用简单单写者模型，不为低概率并发安装引入复杂的数据库竞争协议；
- 当前 Target 状态保持关系化、可检查、可迁移，不退化为巨大 JSON blob；
- 突然退出不会迫使 Skiloom猜测 unknown Target 内容的所有权；
- SQLite 损坏不会触发危险的自动 adoption；
- 公开产品契约继续只描述逻辑状态和恢复行为，而不绑定第三方到官方数据库结构。
