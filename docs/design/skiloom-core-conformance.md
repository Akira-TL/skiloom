# Skiloom Core 标准化与 Conformance 边界

状态：Superseded

当前说明：跨第三方实现的 Core / P-R-A / Full Core Manager / conformance 体系已由 ADR 0018 明确退役。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。本文仅保留为历史设计记录。

对应历史 Issue：#15 `Define Skiloom Core standardization and conformance boundary`

## 1. 目的

Skiloom Core 不是某个 CLI 的功能清单，而是一组可以由独立实现重复得到相同结果的 Agent Skill Package 协议。

Core 只标准化会影响跨实现互操作、可复现性、内容身份或安全 ownership 的**可观察语义**。CLI 命令名、交互流程、缓存路径、文件系统优化与宿主软件探测实现不因为参考实现采用某种做法就自动进入 Core。

本规范中的 `MUST`、`MUST NOT`、`SHOULD`、`SHOULD NOT`、`MAY` 等大写规范词按 BCP 14（RFC 2119 + RFC 8174）解释，并且只在全大写时具有该规范含义。

规范依赖：

- BCP 14 / RFC 2119 / RFC 8174：<https://www.rfc-editor.org/info/bcp14/>
- Agent Skills Specification：<https://agentskills.io/specification>
- Semantic Versioning 2.0.0：<https://semver.org/spec/v2.0.0.html>

## 2. Core 的判定标准

一个规则只有在满足至少一项时才应进入 Skiloom Core：

1. 两个独立实现若采用不同规则，会得到不同 Package discovery、dependency graph、source resolution、Lock、Package Content Digest 或 activation ownership 结果；
2. 该规则决定一个项目能否安全重放已经确认的 resolution；
3. 该规则阻止 Package 内容获得未声明的宿主写权限或阻止包管理器接管 foreign activation；
4. 该规则是其他 Core 规则可测试、可演进所必需的版本化语法或数据模型。

反之，仅影响性能、磁盘布局、交互体验、日志、缓存命中率或某个平台上的 materialization 优化时，默认不属于 Core。

## 3. Skiloom Core MUST

### 3.1 Skill Package admission 与 identity

Core implementation：

- MUST 把符合 Agent Skills Specification 的合法 `SKILL.md` Skill Root 视为 first-class Skill Package；
- MUST NOT 要求作者额外提供 Skiloom Package Manifest 才能形成 Package；
- MUST 保持 `Package Root == Skill Root`；
- MUST 保持 `one Skill == one Package`；
- MUST 使用 `SKILL.md.name` 作为 Package Name 的唯一来源；
- MUST NOT 通过第二份 manifest/index 字段重新声明 Package name；
- MUST NOT 把一个 Package 扩展成 multi-Skill bundle。

Agent Skills Specification 已要求 `name` 与父目录名称一致；Skiloom discovery MUST 以该外部规范为合法性前提，而不是维护一套分叉的 Skill name 规则。

### 3.2 Repository snapshot discovery

对同一个 exact repository snapshot，Core Package implementation：

- MUST 得到确定性的唯一 Discovery Set；
- MUST 在没有 Repository Discovery Control 时以 snapshot 中全部版本化 `SKILL.md` 为候选；
- 若存在 Repository Discovery Control，MUST 只把它用于过滤 Package Root discovery；
- MUST NOT 允许 Repository Discovery Control 创建没有合法 `SKILL.md` 的 Package，或重定义 name/version/dependency/source；
- MUST 允许不同名称的 nested Skill Roots；
- MUST 在最终 Discovery Set 中 Package Name 不唯一时 fail closed；
- MUST 使 Release source 与 Git source 在指向同一个 exact repository snapshot 时得到相同 discovery 结果。

Repository Discovery Control 的公开文件名已由 ADR 0016 固定为 `skiloom-repo.toml`；其**语义角色与确定性行为**属于 Core。未来若再改变公开 filename/namespace，必须通过显式 protocol migration，而不是静默改名。

### 3.3 Optional Package Manifest 的 Core 边界

Core MUST 保证：

- Package Manifest 始终可选；
- 没有 Manifest 的 Package 仍是合法 leaf Package；
- Manifest 若存在且包含会影响 dependency graph 的 Core 字段，当前实现 MUST 完整理解其 schema，否则 fail closed；
- Manifest MUST NOT 复制 Package name、Package version、source provenance 或 project-local activation rename；
- Manifest MUST NOT 获得 arbitrary install/build/postinstall command、hook 或 package-manager script 能力；
- Core dependency edge MUST 精确指向一个 Skill Package，而不是 repository-wide bundle。

Host software / environment observation metadata 不属于 Core dependency graph。若保留该能力，它 MUST 作为单独版本化的 Host Observation extension 定义，并且 MUST NOT 改变 Package admission、Package Content Digest 算法、source resolution 或 Skill dependency graph 的语义。

Package Manifest 的具体 Schema 由 #4 在此边界下收敛。

### 3.4 Canonical Package Snapshot 与 Content Identity

Core Package implementation：

- MUST 从 selected Skill Root 构造 canonical Package Snapshot；
- MUST 从祖先 snapshot 中裁掉已经进入最终 Discovery Set 的 nested Skill Roots；
- MUST 对 v0 snapshot 拒绝 symlink 与其他已禁止的特殊文件类型；
- MUST 使用已接受的 portable path 校验、raw UTF-8 ordering、source Git executable bit 与 exact file bytes；
- MUST 使用 `SKILOOM-PACKAGE-V1` 当前已接受的 canonical binary framing；任何后续 framing/domain-tag 变化都必须使用显式的新 format version；
- MUST 让相同 Package Snapshot 在不同 source/repository/transport 下得到相同 `content-digest`；
- MUST NOT 把 Git commit、GitHub archive digest、临时 checkout metadata 或 source provenance 混入 Package Content Digest。

ADR 0016 已把 pre-standard working-draft domain tag 收敛为公开 `SKILOOM-PACKAGE-V1`。从正式 v0 开始，不得在同一个 format identifier 下改变 digest bytes；未来变更必须定义新的显式 snapshot format version。

### 3.5 Source 与 repository-scoped resolution

Skiloom Core v0 的 mandatory source profile 是 GitHub repository source profile。Core Resolver：

- MUST 把 source binding 作用于 `owner/repo`，而不是单个 Package；
- MUST 保证同一个 project resolution 内一个 repository 只对应一个 exact source snapshot；
- MUST NOT 在同一 resolution 中对同 repository 静默混用 Release/Git 或多个 Git refs；
- 对 Release source，MUST 使用 repository-level SemVer version space，并在选择后记录 actual tag + exact commit；
- MUST NOT 要求 per-Skill Release Asset；
- 对 Git source，MUST 把 requested ref 解析为 exact commit；
- MUST NOT 在 Release 不满足时静默 fallback 到 Git source；
- MUST 在 exact repository snapshot 之后让 Release/Git 共用同一 discovery、snapshot 与 content identity 语义；
- MUST 把 source provenance 与 Package Content Identity 保持为不同协议事实。

未来 Registry、archive mirror 或其他 source model 可以成为新 source profile，但 MUST NOT 改写既有 GitHub Core profile 的含义。GitHub coordinate canonicalization、published Release candidate boundary、repository redirect/rename handling、candidate source-set authorization 与 access-error semantics 已由 [`source-trust-conformance.md`](source-trust-conformance.md) / ADR 0015 固定。

### 3.6 Project Intent 与 Confirmed Resolution

Core Resolver / Project Manager：

- MUST 区分 Project Intent 与 Confirmed Resolution；
- MUST 把 Project Intent 解释为允许的 top-level requirements，而不是当前 exact 安装结果；
- MUST 把 Project Lock 解释为已接受的 exact repository snapshots、Package identities 与 dependency graph，而不是 resolver cache；
- 在已有匹配 Lock 的 replay/sync 语义中，MUST 使用 Lock 的 exact result，MUST NOT 枚举新 Release、前进 Git ref 或重新求解 graph；
- Project Intent 与 Lock 的 canonical Requirement Set 不一致时，MUST fail closed，MUST NOT 部分求解后静默改写 Lock；
- initial resolution 或显式 resolution-changing operation MAY 生成 candidate，但 MUST 在明确接受之后才能替换 Confirmed Resolution；
- frozen replay MUST 要求已有匹配 Lock，并 MUST NOT 创建或修改 Lock。

Core 标准化的是这些操作语义，不要求实现公开名为 `sync`、`update`、`frozen` 的 CLI 子命令。

### 3.7 Resolution artifact

可互操作的 Project Lock 属于 Core：

- MUST 明确分开 top-level requirement、exact repository provenance 与 exact Package record；
- MUST 记录足以复现 source selection、Package Root、Package Content Digest 与 resolved Skill dependency edges 的信息；
- MUST NOT 把 machine-local activation materialization 或 host observation 写入 Confirmed Resolution；
- MUST 有版本化 schema 与确定性 canonical writer 规则；
- 两个相同 Core version 的 conforming Resolver 对同一规范化输入与同一 source metadata fixture MUST 生成语义等价的 Confirmed Resolution。

是否逐 byte 相同由相应 Lock format version 的 canonical serialization 规则决定；当前 v0 writer 已定义 byte-stable ordering，因此 v0 conformance fixture SHOULD 同时验证 canonical bytes。

### 3.8 Flat activation 与 ownership safety

Core Activation Manager：

- MUST 把 executor-visible Skill 激活到项目的扁平 `.agents/skills/<activation-name>` 命名空间；
- 默认 activation name MUST 等于 Package `SKILL.md.name`；
- MUST 在写入前对完整 activation set 做 name conflict preflight；
- MUST NOT 自动覆盖、删除或接管未被当前实现明确记录为 managed 的 foreign content；
- 同名冲突 MUST 由显式 rename 或 abort 解决，MUST NOT 自动生成 `foo-2` 等名字；
- rename MUST 保持 activation directory basename 与激活视图中的 `SKILL.md.name` 一致；
- rename MUST NOT 改变原始 Package Snapshot 或其 `content-digest`；
- managed activation 被未知修改或替换时，destructive reconciliation MUST fail closed；
- activation ownership/state MUST 与 Confirmed Resolution 分离。

Core 只规定上述可观察 activation 语义。POSIX 使用 symlink、Windows 使用 junction、copy fallback、临时目录切换方式以及 machine-local activation state 的物理文件布局是 reference implementation profile，除非未来单独标准化为 portable activation-state format。

### 3.9 Host side-effect boundary

Skiloom Core：

- MUST NOT 从 Package Manifest 执行 arbitrary host installer、package-manager command、build script、postinstall hook 或环境修改脚本；
- MUST NOT 把“依赖声明存在”解释成对安装、升级、登录、下载、配置或服务修改的授权；
- MUST 保证 Host Observation extension 的结果不会改变 Package identity 或 Confirmed Resolution；
- MAY 允许独立 Agent/工具读取自然语言 dependency instructions，但该行为不构成 Core Package Resolver 的可执行语义。

## 4. Skiloom Core MUST NOT

Core v0 明确禁止把以下能力收进核心模型：

- prompts、agents、commands、hooks、MCP、plugin 等其他 agent primitive Package 类型；
- multi-Skill Package / bundle 作为 Package identity；
- 强制 Registry、marketplace 或 package index 才能解析普通 GitHub Skill；
- Package 自报独立版本并与 repository Release version 形成第二套 version authority；
- Manifest 内的 Git/path/URL transitive source override；
- source-specific Package Content Digest；
- 把 source provenance、Package content、project resolution、activation ownership、host observations 混成一个状态对象；
- 自动覆盖 foreign `.agents/skills/*`；
- 以 host installer script 作为 dependency fulfillment 机制；
- 以具体 Agent harness adapter framework 作为 Package 协议的一部分。

## 5. Non-Goals

Skiloom Core v0 不试图标准化：

1. CLI 命令名、flag、prompt 文案、TUI/GUI 或交互确认 UX；
2. Git clone/fetch 策略、Git Source Cache 的绝对路径、cache eviction/LRU；
3. Package Store 的机器目录布局、是否全局共享、去重实现或 GC 算法；
4. symlink/junction/copy/reflink 等物理 materialization 优化，只要最终 activation 语义满足 Core；
5. 日志、telemetry、progress、并发下载、重试或网络层实现；
6. 通用软件包管理、系统依赖安装或环境修复；
7. publisher reputation、账号认证、组织验证、签名 PKI、恶意代码扫描或 sandbox；
8. Registry/marketplace 搜索排名、推荐、curation；
9. Agent runtime 如何选择/调用 Skill；
10. 非 Skill 的 agent context packaging。

其中第 7 项不表示 Skiloom 没有 trust model。Core trust 的 v0 范围是**可审计 provenance + exact source + content integrity + fail-closed retarget/drift**；更强的 publisher/authenticity policy 属于未来 trust extension/profile。

## 6. Conformance classes

Conformance class 用于让实现只声明自己真正支持且可以通过测试的协议面，避免“支持 Skiloom”成为不可验证的营销语句。

### 6.1 Class P — Package Model Consumer

Class P 是所有其他 Core classes 的基础。

实现 MUST：

- 对 exact repository snapshot 执行 Core discovery；
- 验证 Skill Package admission/cardinality；
- 解析当前 Core Package Manifest dependency semantics；
- 构造 canonical Package Snapshot；
- 计算并验证当前 format version 的 Package Content Digest；
- 对 conformance fixtures 产生规定的 Discovery Set、snapshot boundary 与 digest。

Class P 不要求联网、GitHub API、项目 Lock 或项目 activation。

### 6.2 Class R — Resolver / Lock Consumer-Producer

Class R 依赖 Class P。

实现 MUST：

- 实现当前 mandatory GitHub source profile；
- 实现 repository-scoped source binding；
- 实现 [`resolver-conformance.md`](resolver-conformance.md) 固定的 version requirement grammar、constraint intersection、candidate ordering、prerelease 与 conflict semantics；
- 实现 Project Intent / Confirmed Resolution 分离；
- 读取并验证 canonical Lock；
- 对允许产生新 resolution 的操作生成 deterministic candidate/Lock 结果；
- 对已有匹配 Lock 的 replay 保持 lock-preserving。

Class R conformance test MUST 能在固定 source metadata fixtures 下离线运行，避免把 GitHub 当前状态当测试 oracle。

### 6.3 Class A — Project Activation Manager

Class A 依赖 Class R。

实现 MUST：

- 按 Confirmed Resolution 构造完整 flat activation plan；
- 实现 conflict preflight、explicit rename、foreign-content protection 与 managed drift fail-closed；
- 保证 activation view 与 Package Content Identity 分离；
- 对相同 virtual filesystem fixture 产生相同 ownership decision 与错误分类。

Class A 不要求使用与 reference CLI 相同的 symlink/junction/copy 策略，也不要求共享 machine-local activation state 文件格式。

### 6.4 Full Core Manager

只有同时通过 Class P + Class R + Class A 当前同一 Core version conformance suite 的实现，才可以声明：

```text
Skiloom Core <version> conforming manager
```

仅实现其中一类时 MUST 声明具体 class，不能缩写成 Full Core conformance。

### 6.5 Host Observation Extension

Host Observation **不是 Full Core Manager conformance 的组成部分**。

若实现声明支持该 extension，则相应 extension spec MUST 单独定义：

- extension version/schema；
- software requirement grammar；
- canonical probe identifiers（若存在）；
- observation status semantics；
- unsupported capability 行为；
- machine-local state 与 writer ownership。

该 extension MUST NOT 获得改变 Core Package graph、Confirmed Resolution 或任意执行 host installer 的能力。

## 7. Reference implementation profile 与 Core 的关系

当前仓库中若干 Accepted ADR 继续约束 Skiloom reference manager，但并非其全部细节都自动升级为 Core 标准。

| 已接受行为 | Core 状态 |
| --- | --- |
| `SKILL.md`-first、one Skill = one Package | Core normative |
| Repository discovery semantics | Core normative |
| Canonical Package Snapshot / digest | Core normative |
| repository-scoped exact source binding | Core normative |
| Project Intent / Confirmed Resolution | Core normative |
| canonical Project Lock 语义 | Core normative |
| flat activation conflict/ownership/fail-closed | Core normative |
| Git Source Cache 具体路径 / bare mirror 策略 | reference implementation only |
| machine-global Store 物理目录布局 | reference implementation only |
| POSIX symlink / Windows junction preference | reference implementation profile |
| `activation.lock` 当前 machine-local schema | reference implementation profile |
| `dependencies.lock` 与 common software probes | Host Observation extension / reference profile |
| `doctor` / `why` / `remove` 等 CLI 命令面 | product UX, not Core |
| Store 不做 destructive automatic GC | reference manager v0 safety policy；非通用 Core requirement |

“非 Core”不表示旧决定失效；它只表示独立实现无需复制该物理策略也可以通过 Core conformance。

## 8. 标准化交付门槛

在仓库可以把 Skiloom Core 从“reference protocol / proposed standard”提升为正式公开 standard 之前，至少 MUST 具备：

1. 独立、versioned 的 normative Core specification；
2. 所有 Core artifacts 的 machine-readable schema 或同等精度的 formal grammar；
3. BCP 14 normative requirements；
4. Class P/R/A conformance fixture suite；
5. canonical Package Content Digest test vectors，包含 edge cases 与拒绝案例；
6. repository discovery、Manifest、version range、Lock、activation ownership 的 positive/negative fixtures；
7. extension/evolution policy，明确 unknown schema、new snapshot format 与 backward compatibility；
8. security/trust considerations；
9. 至少一个不复用 reference manager 内部实现的独立 consumer，能够对同一 fixture 重现 discovery / digest / resolution / Lock 结果。

在第 9 项没有成立前，项目 SHOULD 使用“Skiloom Core proposed standard”或“reference protocol”，MUST NOT 声称已经形成 industry standard interoperability。

## 9. 对后续 Issue 的约束

### #4 Package Manifest

#4 MUST 只把影响 Package dependency graph 且可跨实现复现的字段纳入 Core Manifest。Host software observation 字段需要从 Core Manifest 语义中拆成明确 extension，或由独立 extension schema/profile 承担；不能继续用“当前实现支持哪些 probe ID”决定 Core Package 是否可安装。

### #7 Resolver

#7 MUST 固定足以让 Class R fixture 得到唯一结果的 requirement grammar 与 selection semantics，包括 range grammar、constraint intersection、prerelease、candidate ordering、cycle/conflict reporting。CLI 的 `update --foo` 形式、交互选择 UI、缓存策略不属于 Core。

### #9 Source / Trust

#9 已按 [`source-trust-conformance.md`](source-trust-conformance.md) / ADR 0015 收敛：Core trust 只拥有 GitHub coordinate/source authorization、exact provenance、retarget/content-integrity boundary；registry reputation、publisher trust体系、marketplace policy 与 arbitrary provider abstraction 保持在 v0 Core 之外。Transitive dependency 可以提名新 repository，但只有完整 accepted Candidate Repository Set 才能进入 Confirmed Resolution。

## 10. 一句话边界

```text
Skiloom Core 标准化“同一个 Skill Package / Project Intent 应得到什么确定结果，以及哪些内容绝不能被包管理器静默改变”；
它不标准化“某个 CLI 具体怎样下载、缓存、链接、探测、展示或优化这些结果”。
```
