# Skiloom v0 开发实施计划

状态：Planning / blocked by architecture gate

对应 Issue：#30 `Plan Skiloom v0 implementation decomposition`

本文件把已经接受的 Skiloom v0 产品架构转换成可执行的开发顺序、模块 ownership、测试策略和暂定 implementation work packages。它不是新的产品规范；任何产品语义冲突都以 `docs/design/skiloom-v0-product-contract.md`、后续公开格式规范和 Accepted ADR 为准。

## 1. 开始写运行时代码前的 Gate A

当前仓库仍是纯设计仓。满足以下条件前，不创建 `src/`、`package.json` 或 executable implementation ticket：

1. #27 First-party Skill Suite / bootstrap 收口；
2. `.skiloom-state` v1 公开格式固定；
3. 单文件 export container + `skiloom-export.toml` v1 公开格式固定；
4. `~/.skiloom/operation.lock` 在 Node.js 官方实现中的跨平台可靠 OS lock 机制固定；
5. v0 CLI command surface、non-interactive acceptance policy surface 和核心交互边界固定；
6. Wayfinder #17 完成最终一致性审阅并关闭。

Gate A 的目的不是继续扩大产品设计，而是防止实现阶段偷偷替公开格式、锁机制或 CLI 行为做不可逆决定。

## 2. 官方实现基线

实施继续遵守已经接受的官方实现架构：

```text
runtime:            Node.js >= 22
primary CI/dev:     Node.js 24 LTS
language:           TypeScript strict
module system:      ESM
package manager:    npm
public package:      skiloom
public executable:   skiloom
```

v0 默认单 npm package。没有真实第二发布物前不启用 monorepo/workspaces。Native/binary helper 分成两类：

1. **System Capability Helper**：当 Node.js 本身不能可靠提供已经确定的产品所需系统能力时允许成为 mandatory helper，例如 Gate A 正在收口的跨平台 OS file lock。它必须极小、单一职责、预编译分发，并有明确 supported platform matrix；
2. **Compute Helper**：只有出现真实性能/内存/底层格式处理证据时才引入，默认属于 optional accelerator，不得因为“以后可能更快”预造二进制层。

初始工程采用 TypeScript compiler 直接构建 `dist/`。测试优先使用 Node 自带 test runner 对编译结果运行；如果某个开发工具必须引入第三方 dependency，它只能是 dev-time tooling，不能因此扩大运行时依赖面。

## 3. 模块 ownership

实施目录以 deep module 为目标，而不是一文件一抽象：

```text
src/
├── domain/
│   ├── coordinate/       # GitHub repository/package coordinate
│   ├── package/          # SKILL.md / package admission / manifests
│   ├── discovery/        # repository discovery
│   ├── snapshot/         # SKILOOM-PACKAGE-V1
│   ├── requirement/      # Cargo-style Release requirements
│   ├── resolver/         # deterministic whole-target solver
│   ├── graph/            # roots/reachability/origin paths
│   ├── target/           # pure projection/ownership plan
│   ├── state/            # accepted/candidate logical models
│   ├── export/           # exact export/import logical model
│   └── errors/           # structured product errors
├── source/
│   └── github/           # only GitHub source profile in v0
├── runtime/
│   ├── home/             # ~/.skiloom path policy
│   ├── lock/             # operation.lock implementation
│   ├── registry/         # SQLite schema/migrations/read-write
│   ├── source-cache/     # disposable source acquisition cache
│   ├── store/            # immutable content-addressed Store
│   ├── marker/           # .skiloom-state codec + reconciliation
│   ├── projection/       # symlink/junction/copy/transforms
│   ├── export/           # archive/container I/O
│   ├── catalog/          # SkillsMP discovery-only adapter
│   └── orchestration/    # install/update/sync/... use cases
└── cli/
    ├── commands/
    ├── render/
    ├── prompt/
    └── exit/
```

这比早期 `official-implementation-architecture.md` 的目录更细，但依赖方向不变：

```text
CLI
 ↓
runtime orchestration ─────→ explicit GitHub / Catalog adapters
 ↓
domain product rules
```

### 3.1 禁止的依赖反转

`domain` 不得 import：

- `node:fs` 的 live filesystem mutation；
- SQLite driver；
- live `fetch`；
- prompt/console；
- Skiloom Home 绝对路径；
- credential discovery。

`source/github` 不写 Registry/Target；`registry` 不访问 GitHub；`projection` 不做 resolver；`catalog` 不形成 source authority。

### 3.2 不使用通用框架

v0 不建立：

```text
ProviderRegistry
PluginContainer
GenericRepository<T>
ServiceLocator
DI container
```

模块需要外部能力时使用窄而明确的函数/对象参数。只有存在真实第二实现时才抽象公共接口。

## 4. 错误模型

从第一批代码开始，产品错误使用 discriminated structured value，而不是靠 message string 判断：

```text
{ code: "AmbiguousPackageDiscovery", ...facts }
{ code: "RepositoryCoordinateChanged", ...facts }
{ code: "OperationLocked", ...facts }
```

要求：

- `domain` 产生产品语义错误；
- adapter/runtime 把 HTTP/SQLite/filesystem 错误映射成产品或实现错误；
- CLI 最后决定 human wording 与 exit status；
- tests 比较 `code + required facts`，不锁死自然语言文案。

不创建巨大 `SkiloomError` class hierarchy；优先使用 TypeScript discriminated unions + small constructors/helpers。

## 5. 官方行为测试数据

### 5.1 测试层级

```text
behavior fixtures
  -> product-rule implementation
  -> expected result / structured error

module tests
  -> GitHub / SQLite / Store / filesystem adapter behavior

thin CLI e2e
  -> argv -> orchestration -> rendering/exit
```

行为测试数据不能依赖 live GitHub。

### 5.2 Fixture 目录

```text
behavior-fixtures/
├── package/
├── discovery/
├── snapshot/
├── requirement/
├── resolver/
├── target/
├── recovery/
└── export-import/
```

fixture 自己的表示只是 test data format，不是公开 Skiloom format。需要表达 Git mode、非法路径、重复 Release、redirect、private-source ambiguity 等事实时，应使用显式 fixture metadata，而不是依赖测试主机文件系统碰巧具有某种属性。

### 5.3 第一优先行为覆盖

实现网络和 SQLite 前必须先覆盖：

- zero-config `SKILL.md` Package；
- repository include/exclude、nested roots、duplicate name；
- Snapshot path/file-type/casefold/executable-bit/digest vectors；
- Release requirement parse/canonicalization/prerelease/build metadata；
- highest-first deterministic backtracking；
- cycle 与 unsatisfiable graph；
- repository-wide direct requirement；
- source-set delta/origin path；
- rename/foreign collision/detach/reachability pure target plan。

## 6. Native / Binary 实施轨道

Native code 不是独立产品层，而是 Node control plane 后面的窄执行单元。任何 helper 都必须服从：

```text
官方产品规范
→ behavior fixtures / system contract tests
→ Node orchestration
→ helper deterministic request
→ helper deterministic response
```

Helper 不得自行取得网络、凭据、用户授权、Registry 写权限或 Target destructive mutation 权限。

### 6.1 两类 helper

#### A. System Capability Helper

用于 Node 标准能力缺失、但产品语义已经要求的系统调用。v0 当前唯一明确候选是：

```text
operation.lock
POSIX: advisory exclusive file lock
Windows: equivalent kernel-backed exclusive file lock
```

如果 Gate A 证明 Node 24/22 无法直接可靠完成该能力，则建立一个最小 mandatory platform helper。它只执行：

```text
acquire lock
hold lock for parent process lifetime / explicit session
use a parent-owned pipe/stdin EOF (or equivalent explicit lifetime channel) so parent death forces helper exit
release on close/helper exit
return structured status
```

它不得顺便承担 Store、SQLite、Target 或 resolver 工作。

#### B. Compute Helper

以下是**候选热点**，不是默认必须 native 化：

1. **Resolver search**：大依赖图的 deterministic highest-first backtracking / constraint propagation；
2. **Repository tree / Git object processing**：pack/object/tree enumeration、exact commit tree extraction 等纯本地处理；
3. **Snapshot scan + digest**：大规模目录/virtual tree 的 portable-path validation、nested-root cut-out、canonical ordering、`SKILOOM-PACKAGE-V1` stream/hash；
4. **Export/import payload processing**：大文件树的 deterministic framing、streaming digest、pack/unpack；
5. 未来经 benchmark 证明的其他纯计算热点。

网络 acquisition、GitHub API、Catalog、用户确认、source authorization、SQLite transaction、Target ownership 和 destructive filesystem change 永远不因性能原因下沉到 compute helper。

### 6.2 Native 化触发 Gate

任何 Compute Helper ticket 创建前必须同时给出：

- 一个已经正确工作的 TypeScript baseline，**或**明确证明 TypeScript 无法合理实现的底层格式/系统能力；
- 可复现 benchmark fixture；
- 当前瓶颈是 CPU、内存峰值、吞吐或底层能力中的哪一种；
- 预期收益阈值；
- helper 失败时的 fallback / unsupported-platform 行为；
- 与现有 behavior fixture 的一致性测试方案。

禁止用“Rust/C++ 应该更快”作为 native 化理由。

Compute Helper 默认只有在至少出现以下一种情况时进入实现：

```text
CPU 时间成为实际用户操作主要瓶颈
或
Node 内存峰值对目标规模不可接受
或
Node 生态实现会迫使引入更大、更难审计的 runtime dependency
或
必须直接处理 Git pack/object、mmap、平台系统调用等底层能力
```

具体数值阈值由对应 benchmark ticket 固定，不在没有真实 workload 前伪造统一数字。

### 6.3 进程与 IPC

v0 native seam 默认仍是 standalone executable，不使用通用 addon/plugin registry。

每个 helper 独立定义最小 versioned protocol，例如：

```text
helper-name
protocol-version
request-kind
bounded deterministic input
→
result | structured helper error
```

默认使用 stdin/stdout 或显式临时文件/pipe；Node 使用 `spawn` 直接调用，不经过 shell。IPC 必须：

- 有版本号；
- 有输入大小/资源边界；
- stdout 只承载协议结果，诊断走 stderr；
- 支持 timeout/cancellation；
- 不接受隐式 HOME/cwd/network discovery；
- 路径输入必须由 Node 明确提供。

不要建立：

```text
NativeProvider
BackendRegistry
UniversalBinaryRPC
AlgorithmPlugin
```

每个 helper 只有出现时才创建一个对应 bridge。

### 6.4 语言与源码布局

Native helper 可以使用 Rust/C/C++，但一个 helper 只选择一种实现语言。默认优先考虑：

- Rust：复杂 parser/search/tree processing，优先内存安全和跨平台；
- C/C++：只有平台 API、成熟底层库或体积/ABI 需求明显更适合时采用。

这不是对产品公开的语言承诺；选择必须写在具体 helper ticket 中。

真实 helper 出现后才增加：

```text
native/<helper-name>/
src/native/<helper-name>.ts   # Node bridge
```

如果产生 platform-specific npm binary packages，再启用 npm workspaces；此前不为了未来 binary package 提前改仓库结构。

### 6.5 Binary 分发

所有 mandatory/optional helper 都必须由 CI 预编译；最终用户不现场编译。

预期模式：

```text
skiloom
  optionalDependencies / required platform dependency as explicitly decided
    ├── platform binary package (darwin-arm64)
    ├── platform binary package (darwin-x64)
    ├── platform binary package (linux-x64-gnu/...)
    └── platform binary package (win32-x64/...)
```

Compute accelerator 缺失时，如果 TypeScript baseline 存在，必须自动使用 TS path，行为完全相同。Mandatory System Capability Helper 缺失时必须返回明确的 `UnsupportedPlatformCapability` / 安装完整性错误，不能静默退化成不可靠锁。

### 6.6 Binary 测试

同一个产品算法存在 TS + native 两条路径时：

```text
同一 behavior fixture
→ TS implementation
→ native implementation
→ canonical result/error 必须相同
```

此外每个 helper 必须有：

- protocol version/invalid input tests；
- crash/timeout tests；
- truncated/corrupt response tests；
- platform packaging smoke tests；
- executable provenance / package-integrity 检查；
- 至少 Linux/macOS/Windows 对应支持矩阵测试。

System Capability Helper 则以系统语义为测试重点，例如双进程争锁、异常退出自动释放、parent/helper crash、路径权限错误。

### 6.7 Native work packages

先预留编号，不代表立即实现：

- **N01 Operation Lock Capability**：Gate A 决定是否需要最小 mandatory native/system helper；
- **N02 Resolver Benchmark + optional accelerator**：I06 完成且有真实 benchmark 后才可启动；
- **N03 Git Tree/Object Benchmark + optional helper**：I15 的纯 Node acquisition 路径出现明确瓶颈或底层复杂度后才可启动；
- **N04 Snapshot/Digest Benchmark + optional helper**：I04 在大型 fixture 上出现明确瓶颈后才可启动；
- **N05 Export Payload Benchmark + optional helper**：I18 完成 correctness baseline 后才可启动。

N02–N05 任何一项都可以永远不实施；这是正常结果，不影响 v0 correctness。

## 7. 里程碑

## M0 — Architecture Gate

**产物：** Gate A 全部关闭，#17 CLOSED。

**禁止：** runtime skeleton、npm publish、真实 CLI implementation。

---

## M1 — Repository Foundation + Domain Kernel

目标：建立最小 Node/TypeScript 工程，并让 Package/Requirement/Snapshot 在离线 fixture 上可执行。

暂定工作包：

### I01 Repository bootstrap

- `package.json` / `package-lock.json`；
- strict ESM `tsconfig.json`；
- `src/`, `test/`, `behavior-fixtures/`；
- scripts：`build`, `typecheck`, `test`, `test:behavior`, `check`；
- Node 22 + 24 CI；
- 不创建业务 stub class forest。

### I02 Structured errors + canonical coordinates

- canonical GitHub repository/package coordinate parser；
- lowercase owner/repo semantic identity；
- invalid coordinate fixtures；
- structured error primitives。

### I03 Package admission + public package/repository metadata parser

- `SKILL.md` required metadata extraction；
- Package Root/name relationship；
- `skiloom-package.toml` schema；
- `skiloom-repo.toml` discovery schema；
- strict unknown-field behavior。

### I04 Repository discovery + Package Snapshot + digest

- discovery include/exclude；
- nested Package cut-out；
- portable path checks；
- executable Git mode；
- `SKILOOM-PACKAGE-V1` digest test vectors。

### I05 Release Requirement parser

- accepted Cargo-style subset；
- canonicalization；
- prerelease semantics；
- build metadata handling；
- no npm-semver-as-oracle shortcut。

**M1 DoD：** 所有 package/discovery/snapshot/requirement fixture 离线通过；没有 GitHub/SQLite/Target live side effect。

---

## M2 — Deterministic Resolver

目标：给定固定 repository candidate facts，计算完整 Target candidate graph。

### I06 Resolver graph engine

- repository-scoped constraints；
- package + repository-wide direct roots；
- highest-first deterministic backtracking；
- deterministic coordinate ordering；
- cycle-safe expansion；
- duplicate/equal-precedence ambiguity；
- complete dependency edges。

### I07 Candidate comparison + source authorization facts

- old accepted state vs complete new state；
- source added/removed/kind/version/tag/commit/immutable delta；
- deterministic origin path；
- Release retarget high-risk classification；
- no old-state candidate preference。

**M2 DoD：** resolver 完全由离线 source fixtures 驱动；同输入重复运行结果字节/结构稳定；复杂 backtracking 和 cycle fixture 通过。

---

## M3 — Immutable Content + Machine State

目标：让已接受 exact graph 可以安全持久化，但暂不要求 live GitHub install 完成。

### I08 Package Store

- Skiloom Home path policy；
- temp write -> digest verify -> atomic publish；
- existing Store re-verification；
- corrupt entry detection；
- no destructive GC。

### I09 Machine Registry + migrations

- `registry.sqlite3` schema；
- foreign keys/WAL/FULL；
- direct requirements（package + repository-wide）；
- exact sources/packages/edges/projections/detached baseline；
- dependency observations；
- transaction replace-whole-target；
- `PRAGMA user_version` migrations + backup。

### I10 Global operation lock

- 使用 Gate A 已决定的跨平台 OS lock mechanism；
- fail-fast `OperationLocked`；
- crash releases OS lock；
- Linux/macOS/Windows tests。

**M3 DoD：** 一个 fixture candidate 可以写入 Registry、读回语义等价状态；Store 内容可重复验证；migration/lock tests 跨支持平台通过。

---

## M4 — Target Planner + Materialization

目标：从 accepted state 确定性构造 Target，并严格保护 foreign/user-owned bytes。

### I11 Pure Target planner

- activation names；
- rename/routing transforms；
- reachability/remove；
- foreign collision；
- detached ownership；
- stale marker decision；
- 不做 live filesystem mutation。

### I12 Projection runtime

- symlink / junction / managed copy；
- transformed copy generation；
- sibling staging；
- DB-first 后的 one-way materialization；
- marker write；
- partial/crash cleanup；
- managed drift verification。

### I13 Sync / repair / detach / rebind / forget / recovery

- exact DB -> Target sync；
- Store repair from exact provenance+digest input seam；
- detach ownership transfer；
- moved detached override broken/rebind；
- DB-loss recovery candidate formation from marker；
- stale same-target-id sync-or-fork behavior。

**M4 DoD：** 临时目录 filesystem integration tests 能模拟 missing/foreign/modified/stale/crash scenarios；任何 destructive action 都有 ownership proof。

---

## M5 — GitHub Source

目标：把 live GitHub source facts 接到已经通过 fixture 验证的 domain engine。

### I14 GitHub metadata/ref/release adapter

- repository coordinate / redirect detection；
- published Releases only；
- tag -> exact commit；
- Git requested ref -> exact commit；
- access ambiguity -> `SourceAccessUnavailable`；
- credentials 仅 runtime 使用。

### I15 Exact repository snapshot acquisition + source cache

- 不要求 system git；
- exact commit tree/materialization；
- preserve Git executable mode；
- disposable source cache；
- acquisition output 必须重新进入 discovery/snapshot/digest 验证。

**M5 DoD：** live integration test 可以从测试 GitHub fixture repository 取得 exact snapshot，但核心行为 tests 仍不依赖网络。

---

## M6 — Core Lifecycle Orchestration

目标：首次形成真正的 `coordinate -> accepted state -> Target` 用户路径。

### I16 Install / update / remove orchestration

固定 pipeline：

```text
request
-> acquire source facts
-> resolve complete candidate
-> compare current accepted state
-> acceptance decision
-> ensure Store
-> DB transaction becomes authority
-> materialize Target
-> marker sync
```

包括：

- first install；
- add root；
- repository-wide install；
- whole-target update；
- remove + reachability；
- Release retarget policy hook；
- no-op identical state。

**M6 DoD：** 使用非交互 test acceptance policy，可以在 temp HOME/temp Target 中完成 install/update/remove 全生命周期；故障后可以 sync 回 DB authority。

---

## M7 — Public Recovery / Reproduction Formats

依赖 Gate A 已固定公开格式。

### I17 `.skiloom-state` codec

- v1 parser/writer；
- target-id/generation；
- package/repository-wide direct requirements；
- sparse rename/transform/detach metadata；
- unknown schema/version behavior；
- atomic marker write。

### I18 Exact export/import

- dependency export；
- full export；
- container/framing；
- `skiloom-export.toml`；
- managed Package payload digest；
- user-owned payload digest domain；
- offline exact import；
- merge-import conflict handling；
- source reauthorization；
- no old target-id/generation/absolute path leakage。

**M7 DoD：** export fixture -> import on empty temp HOME -> semantically equivalent managed environment；full export additionally preserves user-owned bytes without acquiring ownership。

---

## M8 — Discovery UX + CLI + First-party Skills

### I19 Catalog + CLI + bootstrap integration

该阶段在真正拆 executable tickets 时应再细分，但依赖关系是：

1. SkillsMP search adapter只输出 discovery candidates；
2. CLI command parser/render/prompt/exit 使用 Gate A 已固定 surface；
3. non-interactive acceptance policy 只消费完整 candidate/delta，不绕过 product rules；
4. first-party `skiloom` / discover / manage / doctor / author Skills 走普通 Package/Target 安装；
5. bootstrap 不创建 privileged Store/Target path；
6. npm install 本身不静默修改用户 Skill Target。

**M8 DoD：** 用户可以从搜索或明确 GitHub coordinate 进入同一安装 pipeline；第一方 Skills 不具有普通第三方 Package 之外的隐藏安装特权。

---

## M9 — Release Readiness

在 v0 release 前完成：

- Linux/macOS/Windows CI matrix；
- Node 22 minimum + Node 24 mainline；
- `npm pack` smoke test；
- `npx` / global executable smoke test；
- fresh HOME install/update/sync/export/import e2e；
- corruption / interrupted materialization / lock contention tests；
- npm package 不携带测试秘密、临时数据库或本机绝对路径；
- release notes 列出支持平台和已知 host projection limitations。

## 8. 暂定依赖图

```text
Gate A / #17 CLOSED
        |
        v
       I01
        |
        +---- I02 ----+
        +---- I03 ----+---- I04
        +---- I05 ----+      |
                        \     v
                         +--> I06 --> I07

I02/I04 --------------------> I08
I02 + Gate lock decision ---> I09/I10
Gate lock decision ----------> N01 (only if native/system helper is required)
I06/I07 --------------------> I11
I08/I09/I10/I11 ------------> I12 --> I13
I02/I03/I04 ----------------> I14 --> I15
I07/I08/I09/I12/I14/I15 ----> I16
Gate marker schema + I13 ----> I17
Gate export schema + I16/I17 -> I18
I16/I18 + #27/CLI decisions -> I19
I19 -------------------------> M9 release readiness

I04 -------------------------> N04 benchmark gate
I06 -------------------------> N02 benchmark gate
I15 -------------------------> N03 benchmark gate
I18 -------------------------> N05 benchmark gate
```

N02/N03/N04/N05 不在主 correctness critical path；只有 benchmark gate 通过才进入对应里程碑。N01 如果被 Gate A 选为跨平台 lock 的 mandatory 实现，则成为 I10 的实现依赖。

允许的并行：

- I03 / I05 在 I01+I02 后并行；
- I08 / I09 在核心 state types 稳定后并行；
- I14 GitHub adapter 可与 I11 Target planner 并行；
- CLI rendering 不应阻塞 domain/runtime 开发，但不得在 Gate A 前固定公开命令语义。

## 9. Ticket 规模规则

真正创建 executable implementation tickets 时，每张票必须：

1. 一个明确可回滚目的；
2. 有输入/输出或可观察行为；
3. 有测试 DoD；
4. 不同时修改无关 domain + GitHub + CLI；
5. 不以“搭框架”“重构一下”为目的；
6. 不提前引入未来 Registry/provider/native abstraction；
7. 能在独立 commit 中完成并验证。

推荐 ticket 大小：一个 deep-module capability 或一个 vertical behavior slice，而不是“一整个 resolver”“实现全部 CLI”这种巨票。

## 10. 代码评审硬边界

每个实现 PR/commit 检查：

- 是否把 Catalog 数据当 source authority；
- 是否重新引入 Project Lock/frozen；
- 是否把 `.agents/skills` 硬编码为唯一 Target；
- 是否让 filesystem 反向覆盖 Machine Registry accepted state；
- 是否在未知/foreign path 上做 destructive mutation；
- 是否在 sync/repair 中偷偷 re-resolve；
- 是否把 npm semver、GitHub API 顺序、旧状态当 resolver hidden heuristic；
- 是否让 native helper/source adapter/CLI 自己拥有产品授权决定；
- 是否把 secret 写入 Registry/marker/export/log fixture。

## 11. v0 明确不做

实施阶段不要顺手加入：

- destructive Store GC；
- 第三方 provider/plugin SDK；
- Registry artifact source；
- 多版本同 Package side-by-side；
- automatic host software install；
- arbitrary Package install/build hooks；
- generic native backend registry；
- daemon/background service；
- 操作历史/event sourcing；
- 自动 repo rename/transfer migration；
- 自动 rename collision suffix；
- 第三方 conformance/certification 系统。

## 12. 实施启动条件

当 Gate A 满足后，开发不需要再重新讨论整体架构。第一批 executable tickets 应从：

```text
I01 Repository bootstrap
I02 Structured errors + coordinates
I03 Package/repository metadata parser
I05 Release Requirement parser
```

开始。

I04/I06 紧随其后，目标是在最早阶段获得一个完全离线、由 behavior fixtures 驱动的 Skiloom domain engine；只有这个基础稳定后，SQLite、Target、GitHub 和 CLI 才进入主路径。
