# `operation.lock` 跨平台实现机制 v0

状态：Accepted

对应 Issue：#34 `Define cross-platform operation.lock implementation mechanism`

对应产品/实现设计：

- [`machine-registry-sqlite.md`](machine-registry-sqlite.md)
- [`official-implementation-architecture.md`](official-implementation-architecture.md)

本文件固定 Skiloom 官方 Node.js 实现如何兑现已经接受的 `~/.skiloom/operation.lock` 产品语义。它是官方实现机制，不把 Rust helper 升格为公开产品协议，也不改变 Machine Registry、Target Generation 或 DB-first 状态模型。

## 1. 决定摘要

v0 使用一个极小、预编译、standalone Rust executable：

```text
skiloom-lock
```

它是 **mandatory System Capability Helper**，只负责：

```text
打开 Node 明确提供的 operation.lock 路径
→ non-blocking 尝试 OS 级独占文件锁
→ 成功后向父进程确认
→ 在父进程 pipe 存活期间持锁
→ EOF / 正常关闭 / helper 退出时释放锁
```

Node.js / TypeScript 继续拥有全部 control-plane 逻辑：是否需要锁、锁路径、Registry/Store/Target 生命周期、状态接受、错误呈现和恢复策略都不下沉到 helper。

## 2. 为什么是 mandatory helper

Skiloom v0 已经要求：

- 锁必须由操作系统持有；
- 不能以 lock file 是否存在判断锁状态；
- 进程崩溃后锁必须随 OS handle/file description 关闭而释放；
- 无法取得锁时 fail fast；
- 不允许 stale timeout、PID 猜测或删除 lock file 作为解锁机制。

Node.js 22/24 官方标准库没有提供满足该契约的统一跨平台文件锁 API，因此 v0 不用用户态 lockfile 算法模拟这一能力。

`skiloom-lock` 使用 Rust 标准库 `std::fs::File::try_lock()`。helper 源码的最低 Rust 能力线为 1.89；最终用户不安装 Rust，CI/release pipeline 负责预编译。

实现意图：

```text
Unix-like local filesystem
  -> Rust std file lock implementation
  -> OS advisory exclusive lock

Windows local filesystem
  -> Rust std file lock implementation
  -> Windows kernel-backed exclusive file lock
```

Skiloom 不依赖 lock file 的 inode/path existence 自己实现互斥语义。

## 3. 锁文件生命周期

官方实现固定路径仍为：

```text
~/.skiloom/operation.lock
```

文件可以长期存在。残留文件本身既不是“已锁定”，也不是“stale lock”。

禁止：

```text
if exists => locked
mtime timeout => stale
PID dead => delete file
unlink lock file => unlock
mkdir-as-lock
rename-as-lock
```

取得和释放互斥状态只能通过当前打开 handle/file description 上的 OS lock 完成。

Node MAY 把 PID / command / started-at 一类仅供诊断的文本写进 `operation.lock`，但这些字段没有任何锁权威；v0 正确性测试不能依赖它们。

## 4. Helper 进程协议

### 4.1 启动

Node 使用 direct `spawn`，不得经过 shell，也不得使用 `detached` / daemon / `unref` 模式。

Node 显式传入：

```text
protocol version = 1
absolute lock path = ~/.skiloom/operation.lock 的已解析绝对路径
```

helper 不自行发现 HOME、Skiloom Home、Registry 或 cwd 状态。

v0 bridge 的逻辑调用面固定为：

```text
skiloom-lock --protocol 1 --path <absolute-lock-path>
```

具体 platform npm package 中 binary 的物理安装路径属于 release engineering，不是公开 CLI。

### 4.2 stdout handshake

stdout 只承载一行机器协议。成功取得锁时：

```text
SKILOOM-LOCK-V1 ACQUIRED\n
```

只有 Node 完整读到该行以后，状态型操作才可以进入受保护区。

锁争用时：

```text
SKILOOM-LOCK-V1 CONTENDED\n
```

随后 helper 退出；Node 映射为产品错误：

```text
OperationLocked
```

helper 无法提供当前平台/文件系统所需能力时：

```text
SKILOOM-LOCK-V1 UNSUPPORTED\n
```

Node 映射为：

```text
UnsupportedPlatformCapability
```

其他启动/打开/系统错误不伪装成 contention；诊断写 stderr，Node 以实现/系统能力错误处理。

stdout 不输出人类日志、PID、路径说明或进度文本。

### 4.3 持锁与释放

成功 handshake 后，helper：

1. 保持 lock file handle/file description 打开；
2. 保持 OS exclusive lock；
3. 阻塞读取 stdin；
4. stdin EOF 时正常结束持锁阶段；
5. 释放/关闭文件并退出。

正常 Node 生命周期：

```text
Node closes helper stdin
→ helper observes EOF
→ helper exits
→ OS lock released
```

Node 异常退出时，父进程 pipe 被关闭；helper 收到 EOF 并退出，因此不需要 stale cleanup。

helper 不启动后台孙进程，不把 lock handle 传给另一个长期进程。

## 5. Lock loss

成功收到 `ACQUIRED` 后，Node 必须持续把 helper 存活视为“锁仍被持有”的必要条件。

如果 Node 尚未主动关闭 stdin，而 helper 提前退出、pipe 异常关闭或协议断裂：

```text
OperationLockLost
```

当前状态型操作必须停止继续产生新的受保护 side effect；不得在同一次操作中静默重新 acquire 然后继续。

原因：helper 离开与再次取得锁之间存在空窗，另一个 Skiloom 进程可能已经进入。

与 DB-first 模型组合：

- SQLite 新状态提交前失锁：停止操作；未提交 transaction 不成为新权威；
- SQLite 已提交但 Target 尚未完成时失锁：数据库新状态仍是权威，后续新的受锁 `sync` 严格执行 Machine Registry -> Target；
- 不因为失锁把 live Target 残留状态反向采纳进数据库。

`OperationLockLost` 是运行期一致性故障，不等同于一开始的 `OperationLocked`。

## 6. Helper 权限边界

`skiloom-lock` 只允许：

```text
打开显式 lock path
取得/持有/释放 OS lock
读取父进程 stdin lifetime channel
写最小 stdout protocol
写 stderr diagnostics
```

不得：

- 打开或修改 `registry.sqlite3`；
- 枚举或修改 Package Store；
- 枚举、写入或删除 Target；
- 发起网络请求；
- 查找 credentials；
- prompt 用户；
- 判断 source authorization；
- 执行 resolver；
- 管理 staging/pending rows；
- 根据 PID / mtime 删除所谓 stale lock。

因此 helper 是系统调用能力桥，不是另一个 Skiloom runtime。

## 7. Skiloom Home 文件系统支持边界

v0 的 `~/.skiloom/` 定义为 **machine-local Skiloom Home**。官方保证范围是本机文件系统上的：

```text
registry.sqlite3
operation.lock
store/
backups/
```

NFS、SMB 或其他网络/分布式挂载上的文件锁语义可能随平台、挂载参数与服务器实现变化；v0 不建立 distributed lease、heartbeat、lock server 或跨机器共享 Registry 协议。

因此网络挂载的 Skiloom Home 不属于 v0 官方支持范围。若实现能够可靠检测当前文件系统不满足所需 lock capability，应返回 `UnsupportedPlatformCapability`；无法可靠检测时仍不形成支持承诺。

Target 本身是否位于其他文件系统是另一个 materialization/preflight 问题，不因此把 Machine Registry 的全局锁升级为分布式锁。

## 8. npm 分发

最终用户入口不变：

```text
npm install -g skiloom
# 或
npx skiloom ...
```

CI 为支持的平台预编译 `skiloom-lock`。主 npm package 使用 platform-filtered helper package 作为发行实现细节；允许通过 `optionalDependencies` 表达多平台 package 选择，但 **产品能力并非 optional**。

运行时规则：

- 匹配平台 helper 存在且可执行：正常使用；
- helper 因 npm `--omit=optional`、损坏安装或 unsupported platform 缺失：需要状态锁的操作返回明确 `UnsupportedPlatformCapability` / 安装完整性错误；
- 不 fallback 到 mkdir/PID/mtime lock；
- 不现场运行 Cargo/Rust compiler；
- 不从任意 URL 在 runtime 下载 executable。

v0 release readiness 固定首发支持矩阵如下；这些 package 只是主 `skiloom` package 的发行实现细节，不是新的用户入口：

| Target | npm package | npm platform metadata | executable |
| --- | --- | --- | --- |
| Linux x64 glibc | `skiloom-lock-linux-x64-gnu` | `os=linux`, `cpu=x64`, `libc=glibc` | `bin/skiloom-lock` |
| macOS x64 | `skiloom-lock-darwin-x64` | `os=darwin`, `cpu=x64` | `bin/skiloom-lock` |
| macOS arm64 | `skiloom-lock-darwin-arm64` | `os=darwin`, `cpu=arm64` | `bin/skiloom-lock` |
| Windows x64 | `skiloom-lock-win32-x64` | `os=win32`, `cpu=x64` | `bin/skiloom-lock.exe` |

四个 helper package 与主 `skiloom` package 使用同一版本号并由同一 release tag 构建。主 package 通过 `optionalDependencies` 同时声明四个精确版本，让 npm 根据 `os` / `cpu` / `libc` 只安装匹配项；“optional”只描述 npm 的平台选择机制，不改变 `operation.lock` 在产品层的 mandatory 语义。

v0 首发矩阵暂不承诺 Linux arm64、Linux musl、Windows arm64 或其他 OS/CPU/libc 组合。运行在矩阵之外、使用 `--omit=optional`、或安装损坏导致匹配 helper 缺失时，状态型操作继续 fail closed。后续扩大矩阵必须增加对应预编译 package、真实 runner smoke 和 release artifact 验证，不能只放宽运行时判断。

## 9. 测试要求

N01 至少覆盖：

1. 第一个 helper 成功取得锁；
2. 第二个 helper 对同一路径 non-blocking 返回 contention；
3. 第一个 helper 正常 EOF 后第二个可以取得锁；
4. 持锁 helper 被强制终止后 OS 释放锁，新的 helper 可以取得；
5. Node 父进程结束导致 lifetime pipe EOF，helper 随后退出并释放；
6. helper 在 Node 未主动释放前异常退出，Node 产生 `OperationLockLost`；
7. residual `operation.lock` 文件存在但无人持 OS lock 时仍可正常取得；
8. 不支持/缺失 helper 时不使用用户态 fallback；
9. Linux/macOS/Windows release CI 都运行真实 contention smoke test；
10. stateful integration test 证明整个受保护操作期间 helper 一直存活。

这些是 system/integration tests，不要求把 lock 逻辑塞进产品 behavior fixture。

## 10. 不做

v0 不做：

- lock queue / wait-with-timeout scheduler；
- stale PID reclamation；
- lockfile deletion protocol；
- Node native addon；
- 通用 platform syscall helper；
- lock daemon；
- network filesystem distributed lock；
- Redis/etcd/SQLite advisory lease；
- 为 `skiloom-lock` 引入与职责无关的 Store/Registry logic。

## 11. 一句话契约

```text
operation.lock 的权威 = OS-held exclusive file lock

Node = 决定何时需要锁并拥有所有状态语义
skiloom-lock = 只把跨平台 OS lock capability 提供给 Node

lock file existence / PID / mtime = 永远不是互斥权威
```
