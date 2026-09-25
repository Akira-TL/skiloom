# Skiloom 官方实现架构 v0

状态：Accepted

对应：[`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)

对应 ADR：[`0017-node-official-implementation-with-native-helpers.md`](../adr/0017-node-official-implementation-with-native-helpers.md)、[`0025-operation-lock-rust-helper.md`](../adr/0025-operation-lock-rust-helper.md)

本文件固定 **Skiloom 官方实现** 的技术栈、代码组织和 native helper 边界。它服从 Skiloom 官方产品规范，不承担第三方实现兼容等级或认证职责。

## 1. 首要目标

官方实现优先优化：

1. 用户通过 npm 低摩擦安装和试用；
2. `npm install -g skiloom` / `npx skiloom` 可以直接进入产品；
3. 协议语义与 CLI/runtime side effects 分离；
4. 普通开发不要求 Rust/C/C++ toolchain；
5. 对确实需要高性能或底层能力的热点，允许使用预编译 native helper；
6. native helper 不能形成第二套协议 authority。

因此 v0 不采用“Rust 主程序 + npm wrapper”，也不要求纯 JavaScript 实现所有算法。总体形态是：

```text
npm / Node.js / TypeScript control plane
        +
mandatory prebuilt system capability helper
        +
optional prebuilt native compute helpers
```

## 2. Node.js / TypeScript 基线

官方实现固定：

```text
runtime:            Node.js >= 22
primary dev line:   Node.js 24 LTS
language:           TypeScript
TypeScript mode:    strict
module system:      ESM
package manager:    npm
lockfile:           package-lock.json
public npm package: skiloom
public executable:  skiloom
```

Node 22 与 24 当前都属于受支持 LTS line；开发与 release CI 以 Node 24 LTS 为主，并至少验证最低支持线 Node 22。

生产发布使用编译后的 JavaScript；最终用户不需要安装 TypeScript compiler。

初始构建 SHOULD 使用 TypeScript compiler 直接生成 `dist/`，不因“CLI 项目通常会 bundle”而提前引入 bundler。未来若 bundling 对启动速度、package size 或 supply-chain surface 有实测收益，可作为 release engineering 变化引入，只要不改变公开行为。

## 3. 单一公开 npm package

v0 默认只发布一个用户需要理解的 package：

```text
skiloom
```

内部 Module 不因为代码边界而自动变成多个 npm package。特别是 v0 不提前发布：

```text
@skiloom/domain
@skiloom/runtime
@skiloom/source-github
```

避免过早承担多 package versioning、export map、发布顺序与 public library compatibility。

当确实出现第二个独立发布物（例如 platform-specific native binary package）时，repository MAY 启用 npm workspaces。Workspace 只是 repository/release tooling，不改变 Skiloom 产品行为。

## 4. 代码结构

目标结构：

```text
skiloom/
├── package.json
├── package-lock.json
├── tsconfig.json
├── src/
│   ├── domain/
│   │   ├── package/
│   │   ├── snapshot/
│   │   ├── requirement/
│   │   ├── resolver/
│   │   ├── target/
│   │   ├── export/
│   │   └── errors/
│   ├── source/
│   │   └── github/
│   ├── runtime/
│   │   ├── registry/
│   │   ├── source-cache/
│   │   ├── store/
│   │   ├── projection/
│   │   └── filesystem/
│   ├── native/
│   │   └── ... explicit helper bridges only when needed
│   └── cli/
│       └── ... thin command surface
├── behavior-fixtures/
│   ├── package/
│   ├── resolver/
│   ├── target/
│   └── export-import/
├── test/
├── native/
│   └── ... native source trees only when a real helper exists
└── docs/
```

目录表达 ownership，不要求每个子目录都对应 class/package。优先形成 deep Module，而不是一文件一 abstraction。

## 5. 依赖方向

官方实现的逻辑依赖方向固定为：

```text
CLI
 ↓
runtime orchestration
 ├──────────────→ GitHub source adapter
 ↓
domain interface
 ↓
product-rule implementation
```

`src/domain/` 是主要产品规则实现面。它不能直接拥有：

```text
process.argv / process.exit
interactive prompt
console-oriented UX
GitHub credential discovery
live HTTP request creation
cache/store absolute path policy
foreign project file deletion
host package installation
```

Source/runtime/CLI 把明确输入交给 domain，并消费 domain result/error。

## 6. Node 标准库优先

用户安装依赖面 SHOULD 保持小。

可直接使用 Node 标准能力的地方不额外增加 runtime dependency，例如：

```text
HTTP                 -> built-in fetch
SHA-256              -> node:crypto
filesystem/path      -> node:fs / node:path
native subprocess    -> node:child_process
basic CLI arg parsing -> built-in capability when sufficient
```

第三方依赖只用于标准库明显不应该自行实现的协议，例如 TOML/YAML parser，或经过评估确实能明显降低复杂度的能力。

Skiloom Release Requirement 不能直接把 npm `semver` grammar 当产品规则 oracle，因为官方产品规范已经固定自己的 Cargo-style requirement profile。

## 7. Native helper 的角色

Native helper 分成两类：

1. **System Capability Helper**：Node 标准能力缺失、但产品正确性要求的底层系统能力。v0 已确定 `skiloom-lock` 是 mandatory helper；
2. **Compute Helper**：resolver、Git object、snapshot/digest、export payload 等经 benchmark 证明值得下沉的计算热点，默认 optional。

Native helper 可以使用 Rust、C、C++ 或其他可生成可移植 standalone executable 的实现语言。`skiloom-lock` 已固定使用 Rust；其他 helper 仍按具体问题选择。

适合 compute native 化的候选包括但不限于：

```text
大规模 deterministic dependency search
Git object / pack processing
超大 repository snapshot enumeration / hashing
高吞吐 archive/tree processing
```

是否 native 化必须由复杂度、性能或底层能力需求驱动；不能只因为“Rust/C++ 更快”就复制一套实现。

### 7.1 Native helper 不是 plugin/provider framework

v0 不建立通用：

```text
NativeProvider
AlgorithmPlugin
BackendRegistry
```

每个真实 native helper 在出现时建立一个最窄的内部 seam。没有第二个 implementation/真实变化点时，不预造抽象层。

### 7.2 Control plane 始终属于 Node

Native helper MUST NOT 独立拥有：

- GitHub/network access；
- credentials/secrets discovery；
- user prompts/authorization；
- 本机状态库 write policy；
- Target destructive mutation；
- Package Store ownership policy；
- CLI rendering/exit policy。

Node runtime 负责取得/验证外部事实，并向 helper 提供明确 deterministic input。Helper 返回 deterministic result/error；Node 决定如何呈现、接受或执行 side effect。GitHub credential discovery 也属于这个 Node control plane：v0 只按 ADR 0029 从 `GH_TOKEN`、其次 `GITHUB_TOKEN` 读取 process environment；不增加 `--token`、持久 credential store、`gh auth` 读取或 native-helper credential access。

Helper MAY 读取 Node 明确提供的 immutable input/file/stream，并 MAY 写到 Node 明确分配的 temporary/output target；它不得自行遍历任意 project/home/network 状态来补充隐式输入。

### 7.3 产品行为权威

Native code 可以实现解析、摘要等产品算法，但它不是产品规则 authority。

Authority 顺序是：

```text
Skiloom 官方产品规范
        ↓
官方行为测试数据
        ↓
TypeScript or native implementation
```

如果 TypeScript path 与 native path 对同一固定输入给出不同结果，这是 implementation bug，不是“两个 backend 都合法”。

一个算法若只有 native implementation，也必须通过对应官方行为测试；不要求为了形式上的 fallback 再维护一份完整 TypeScript duplicate implementation。

## 8. Native process seam

Standalone executable 是 v0 native helper 的首选形态，而不是 Node native addon。

理由：

- Rust/C/C++ 都能复用相同进程 seam；
- 不把 helper 绑定到 Node/V8 addon ABI；
- 用户机器无需 compiler/toolchain；
- helper crash/timeout 可以由 Node process boundary 隔离和报告；
- 发布物可以独立做平台签名/校验。

Node SHOULD 使用 direct spawn（不经过 shell）启动 helper，并显式控制 argv、cwd、environment、timeout/cancellation 与 stdin/stdout/stderr。

Helper IPC 必须 versioned。首个真实 helper `skiloom-lock` 已由专门设计固定其 `SKILOOM-LOCK-V1` 最小 handshake 与 stdin lifetime channel；后续 helper 仍各自只固定满足职责所需的最小 request/response schema，不建立通用 RPC framing。

Node-API/native addon MAY 在未来针对明确性能问题采用，但不是 v0 默认 native seam。

## 9. npm 分发 native binary

Native helper 不应在用户执行 `npm install` 时现场编译。

首选分发方式：

1. CI/release pipeline 为支持的平台预编译 standalone binary；
2. platform package 使用 npm `os` / `cpu`，Linux 必要时使用 `libc` metadata；
3. 主 `skiloom` package 可以通过 `optionalDependencies` 表达 mutually-exclusive 的 platform helper packages；这个 npm 字段只解决平台选择，不代表 mandatory system capability 在产品上可选；
4. Node runtime 检测已安装的匹配 helper；mandatory helper 缺失时明确失败，optional compute helper 缺失时在有 TS baseline 的情况下回退；
5. `npm install -g skiloom` / `npx skiloom` 仍是用户唯一需要理解的入口。

具体 platform package 名称是 release engineering 名称，不属于公开产品格式。在正式创建 npm scope/package 前必须重新验证 registry availability。

因为 npm 允许用户用 `--omit=optional` 跳过 optional dependencies，所以 **optional native accelerator 的缺失不能让一个原本有 TypeScript implementation 的产品能力变得错误**。

`skiloom-lock` 是已显式批准的 mandatory capability 例外：匹配平台 binary 缺失、被 `--omit=optional` 跳过或当前平台未受支持时，需要状态锁的操作必须返回明确 `UnsupportedPlatformCapability` / 安装完整性错误，不能静默退化成 mkdir/PID/mtime lock。支持平台矩阵在 release readiness 中固定。

## 10. GitHub source implementation

v0 将 Git repository transport 与 GitHub platform metadata transport 分开（ADR 0032）。Git repository 的 ref/tag、exact commit、tree/blob facts 优先由 system `git` 获取；GitHub REST 只保留 GitHub-specific metadata，例如 published Release visibility、immutable signal 与仍明确需要 API 的 repository metadata。

默认 GitHub repository remote 顺序为 SSH first、public HTTPS fallback。system Git/OpenSSH 可以使用用户已有的 `~/.ssh/config`、ssh-agent 与 SSH key；Skiloom 不读取、复制或持久化这些 credential。Git subprocess 必须 direct-spawn、non-interactive，不 checkout 或执行 repository code。

GitHub API credential discovery 继续按 ADR 0029：`GH_TOKEN > GITHUB_TOKEN > anonymous`，但该 token 只进入 API metadata transport，不代表 Git/SSH credential。

GitHub source 的产品语义仍是：

```text
GitHub-specific metadata (when required) + Git ref/tag facts
  -> exact commit
  -> exact repository snapshot facts
```

transport kind 不进入 accepted source identity。无论 snapshot bytes 经 source cache、system Git 或过渡期 REST acquisition 获得，都必须重新经过 repository discovery、Package snapshot 与 digest 验证；不能改变官方产品规范已经固定的 source-kind、coordinate、commit、discovery/digest 语义。

## 11. Testing architecture

最高测试 seam 是官方产品规范已经固定的：

```text
versioned behavior fixture
  -> implementation under test
  -> expected product result/error
```

官方实现 tests 分三层：

1. **官方行为测试数据**：验证 Package、Resolver、Target、恢复与导入导出的产品结果，不依赖 live GitHub；
2. **Module tests**：验证 source/runtime/native adapter 自己的实现细节和错误映射；
3. **Thin end-to-end CLI tests**：验证 npm executable 能够把输入交给 runtime 并正确渲染/退出，不重复测试 resolver 内部算法。

如果某个算法同时有 TypeScript 与 native implementation，同一行为测试数据 MUST 对两条 implementation path 运行。

Native helper 自身 MAY 使用其语言生态的 unit/property tests，但这些不能代替 repository-level 官方行为测试。

## 12. 发布与平台原则

官方实现的主要传播渠道是 npm，而不是 GitHub binary download。

目标用户体验：

```text
npm install -g skiloom
# 或
npx skiloom ...
```

预编译 native helper只是 npm dependency graph内部的实现细节。`skiloom-lock` 是状态型操作所需的 mandatory helper；其他 compute helper 仍按真实性能证据选择。用户不应该为了使用 Skiloom而安装 Rust、C/C++ compiler、CMake 或 platform SDK。

Node.js v0 support floor 为 22；开发/release 主线使用 Node 24 LTS。未来提高 Node support floor 属于官方实现 release policy；只有当它同时改变公开产品格式或产品行为时，才需要修改相应产品规范。

## 13. Non-Goals

本 architecture v0 不定义：

- 第三方实现语言或兼容等级；
- public `@skiloom/domain` library API；
- 通用 native plugin/provider framework；
- 用户现场编译 native helper；
- runtime 自动下载任意未通过 npm/release provenance管理的 executable；
- 将 native helper作为 Package/Skill可执行 extension机制；
- 通过 native helper 绕过 Skiloom 的宿主副作用授权边界；
- 为没有性能证据的算法同时维护 TS/native duplicate implementation。

## 14. 一句话架构

```text
Skiloom 官方实现
= npm-distributed Node.js/TypeScript control plane
+ small deep domain interfaces
+ GitHub/runtime side-effect adapters
+ 官方行为测试数据
+ mandatory prebuilt `skiloom-lock` system helper
+ optional prebuilt native compute helpers behind narrow versioned seams.
```
