# ADR 0025：用 mandatory Rust helper 实现 `operation.lock`

- 状态：Accepted
- 日期：2026-09-16

## 背景

Skiloom v0 已经接受一个机器级 `~/.skiloom/operation.lock`：所有状态型操作必须在同一个 OS 级独占文件锁下执行；锁的有效性不能由 lock file 是否存在、PID、mtime 或 stale timeout 判断；进程异常退出后必须依赖内核 handle/file-description 生命周期释放锁。

官方主实现仍是 Node.js 22+ / TypeScript，但 Node.js 22/24 标准库没有提供满足该契约的统一跨平台文件锁 API。使用 mkdir、`O_EXCL` lockfile、PID file 或 stale timeout 会重新引入 race 和崩溃恢复歧义，也违背既定产品语义。

Rust 标准库从 1.89 开始提供 `std::fs::File::try_lock()`，可以作为极小 standalone helper 的跨平台 OS lock 能力。

## 决定

1. v0 新增一个 mandatory System Capability Helper：`skiloom-lock`。
2. helper 使用 Rust，实现只依赖所需标准库文件锁能力；helper 源码最低 Rust 能力线为 1.89。
3. 最终用户不安装 Rust/toolchain；release CI 为支持平台预编译 standalone executable，并通过 npm platform package 分发。
4. Node 使用 direct `spawn` 启动 helper，不经过 shell，不使用 detached/unref/daemon 模式。
5. Node 显式传入 protocol version 和绝对 `operation.lock` 路径；helper 不自行发现 HOME、Registry、Store 或 Target。
6. 成功 handshake 固定为 `SKILOOM-LOCK-V1 ACQUIRED`；contention 固定为 `SKILOOM-LOCK-V1 CONTENDED`，Node 映射为 `OperationLocked`；不支持的能力映射为 `UnsupportedPlatformCapability`。
7. helper 在成功取得锁后通过 stdin lifetime pipe 与 Node 绑定；EOF 后退出并释放 OS lock。父进程异常结束导致 pipe 关闭，因此无需 stale lock reclamation。
8. `operation.lock` 文件可以长期存在；文件存在、PID、mtime、诊断文字都不是锁权威，删除文件也不是解锁协议。
9. helper 成功 handshake 后若在 Node 主动释放前异常退出，Node 报 `OperationLockLost` 并停止继续产生新的受保护 side effect；不得静默 reacquire 后接着执行。
10. helper 不拥有 Registry、Store、Target、resolver、network、credentials、source authorization、prompt 或 CLI policy。
11. `~/.skiloom/` 是 machine-local Skiloom Home。NFS/SMB 等网络/分布式挂载不属于 v0 官方支持范围；v0 不实现 distributed lease/heartbeat/lock server。
12. npm 的 `optionalDependencies` 可以作为多平台 binary package 选择机制，但 lock capability 本身不是 optional。匹配 helper 缺失时不得 fallback 到用户态锁。

## 结果

- `operation.lock` 的实现与既定产品语义一致：OS lock 才是互斥权威；
- Node/TypeScript 继续是 control plane，Rust helper 只桥接缺失的系统调用能力；
- 父进程崩溃不留下需要人工判断的 stale lock；
- 不引入 node-gyp、Node addon ABI、现场编译或运行时任意 binary 下载；
- `skiloom-lock` 成为 v0 第一个确定必须发行的 native binary，其他 resolver/Git/snapshot/export helper 仍保持 benchmark-driven optional compute helper；
- 官方实现架构从“只有 optional native compute helper”扩展为“mandatory system helper + optional compute helper”，但不形成通用 native provider/plugin framework。

详细协议、生命周期和测试要求见 [`../design/operation-lock-helper.md`](../design/operation-lock-helper.md)。
