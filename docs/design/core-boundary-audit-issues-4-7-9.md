# Skiloom Core 边界审查：Package Manifest、Resolver、Source / Trust

状态：Historical Review

当前说明：本文记录已退役的 Core/conformance 分类审查过程，只保留为历史设计材料。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md) 与 ADR 0018。

## 1. 审查规则

每个候选规则按四类归属：

- **Core**：不同实现若处理不同，会改变 Package discovery、Skill dependency graph、source resolution、Confirmed Resolution、Package Content Digest 或 activation ownership 的可观察结果；
- **Extension**：可以标准化，但不是 Full Core P/R/A conformance 的必要条件；
- **Reference-only**：当前 Skiloom reference manager 可以固定，但独立 Core implementation 不需要复制；
- **Open**：仍需 #4 / #7 / #9 继续做协议决定。

分类不改变既有 Accepted reference-manager 行为。它只回答“独立实现为了声明 Skiloom Core conformance，必须复制到什么程度”。

---

## 2. #4 Package Manifest

### 2.1 继续属于 Core 的内容

以下内容应保留为 Class P / Class R 可测试语义：

| 规则 | 归属 | 理由 |
| --- | --- | --- |
| Manifest 可选；合法 `SKILL.md` 不需要 Manifest | Core | Package admission 基线 |
| Manifest 存在时有显式 schema，未知 Core schema fail closed | Core | 防止漏解释 graph-affecting 语义 |
| `[dependencies]` edge 精确为 `owner/repo/package` | Core | 直接决定 Skill dependency graph |
| dependency value 使用 #7 固定的 Release requirement grammar | Core | 直接决定 repository resolution |
| Manifest 不声明 Package name/version/source/provenance | Core | 防止产生第二套 identity/version/source authority |
| Manifest dependency 不允许 Git/path/URL source override | Core | 防止 transitive Package 改写 source model |
| required-only dependency；v0 无 optional/peer/features/platform-conditioned graph | Core v0 | 避免实现产生不同 graph |
| arbitrary install/build/postinstall/provider commands 禁止 | Core safety boundary | 防止 metadata 获得 host write capability |
| Manifest source bytes属于 Package Snapshot，解析语义不依赖 TOML 排版 | Core | 影响 Package Content Digest 与 graph reproducibility |

### 2.2 `[software]` 必须从 Core dependency graph 重新归类

现有 Accepted external-software 设计不需要回退：reference manager 仍可以在同一个 optional Package Manifest 中读取 `[software]`，执行便宜只读 probe，并把 observation 写入 `.agents/.skiloom/dependencies.lock`。

但 ADR 0012 之后，以下边界必须明确：

```text
[dependencies]
= Core Skill dependency semantics
= Class P/R 可观察 graph 输入

[software]
= Host Observation Extension metadata
= 不进入 Skill dependency graph
= 不进入 Confirmed Resolution
= 不是 Full Core P/R/A 的必要能力
```

因此当前 #4 Proposal 中两点需要修改：

1. **`UnsupportedSoftwareProbe` 不得使一个 otherwise-valid Package 失去 Core Package conformance。**
   - 不支持 Host Observation Extension 的 Class P/R/A implementation 仍必须能够处理该 Package 的 Core semantics；
   - 支持该 extension 但不支持某个 probe capability 时，应报告 extension capability 不可用/无法观察，而不是把 Package 降格成“无效 Core Package”；
   - reference manager 可以选择更严格的产品策略，但不能把该策略写成 Full Core admission rule。
2. **`[software]` requirement grammar 不应由 #7 Skill Release resolver 统一拥有。**
   - #7 的 grammar 只服务 repository Release SemVer selection；
   - host runtime/version 的表示能力属于 Host Observation Extension，自行定义 grammar 与 comparison capability；
   - 否则 Class R 会被迫实现一个与 Package resolution 无关的软件探测类型系统。

### 2.3 #4 仍待决

#4 在接受前还需要收敛：

- Manifest Schema 1 如何在 on-wire 层区分“Core 字段”与“Host Observation Extension 字段”；
- Host Observation Extension 的版本如何与 Manifest schema 演进关联；
- 不实现该 extension 的 Core consumer 对 `[software]` 是“结构识别但语义忽略”，还是通过独立 capability declaration 处理；
- extension 字段未知/不支持时的结构化结果，避免与 `InvalidOptionalManifest` 混为一谈。

建议保持当前物理 `[software]` 位置，避免重开 ADR 0010；只把其 conformance ownership 从 Core 移到 versioned Host Observation Extension。

---

## 3. #7 Version / Dependency Resolver

### 3.1 Class R 必须标准化的内容

#7 的目标不再是定义“CLI update 功能”，而是让两个 Class R implementation 在固定 source metadata fixture 上得到同一个 candidate resolution。

以下属于 Core：

| 规则 | 归属 | 说明 |
| --- | --- | --- |
| Release requirement grammar | Core | 必须有唯一 parser/comparison 语义 |
| 同 repository constraint intersection | Core | 决定 repository exact snapshot |
| candidate ordering / tie-break | Core | 否则两个实现可能选不同 Release |
| prerelease eligibility | Core | SemVer candidate set 的组成规则 |
| normalized duplicate Release handling | Core | 已接受 `v1.2.3` / `1.2.3` ambiguity 规则 |
| repository-scoped single exact source binding | Core | 已接受前提 |
| Git ref -> exact commit，仅 resolution-changing operation 重解析 | Core | 已接受前提 |
| explicit Git binding 与同-repository dependency range 的关系 | Core | 必须有唯一 source/result |
| dependency cycle validity与结构化错误类别 | Core | graph 是否可形成必须一致 |
| unsatisfiable conflict 的 machine-readable provenance | Core | conformance / tooling 需要定位冲突 constraints |
| Project Intent / Confirmed Resolution / lock-preserving replay | Core | ADR 0011 已接受 |
| candidate 未接受前不得改变 Confirmed Resolution | Core | ADR 0011 已接受 |

### 3.2 不属于 Class R 的内容

现有 `04-resolver-and-install-plan.md` 同时承载 resolver、fetch/cache、Store、activation、dependency observation 与 CLI convenience。ADR 0012 后应明确：

- Git Source Cache clone/fetch/mirror 策略：**Reference-only**；
- Package Store 物理写入/复用优化：Package/reference implementation concern，不是 Resolver selection semantics；
- symlink/junction/copy activation：**Class A / Reference profile**，不属于 R；
- common software probes：**Host Observation Extension**；
- `doctor`、`why`、`remove` 的命令面：**Product UX**；
- `offline` 作为 CLI flag：**Product UX**。若未来定义“Lock + fixture 可离线验证”的 portable replay capability，应另行规范，不从 CLI flag 反推 Core；
- human-readable conflict sentence、候选展示 UI：**Product UX**。Core 只需要稳定 machine-readable conflict facts。

### 3.3 #7 仍待决

真正阻塞 Class R 的问题现在只剩少量但必须字节级/算法级精确的决策：

1. Release requirement grammar 采用哪套既有 SemVer range 语法，是否允许 shorthand；
2. range normalization / semantic equality 如何定义；
3. 多 constraint intersection 的规范算法或等价结果定义；
4. prerelease 何时进入 candidate set；
5. 多个满足版本时的唯一 ordering（通常需要明确最高/最低、stable/prerelease 优先级以及等版本 ambiguity 行为）；
6. explicit update 是否允许 previous Lock 影响 candidate preference；如果允许，必须完全确定，不得依赖某个 solver heuristic；
7. unsatisfiable conflict record 至少携带哪些 originating dependency edges / top-level requirements；
8. cycle 是否一律非法已在当前工作草案中提出，但尚需 #7 正式接受并固定 canonical cycle reporting facts。

#7 完成标准应改成：**给定 canonical Project Intent + fixed GitHub source metadata/discovery fixtures，任意 Class R implementation 产生同一个 repository binding、Package graph、error category 与 canonical Lock semantics。**

---

## 4. #9 Source / Index / Trust

### 4.1 Core trust 的 v0 范围

#9 不应扩张成通用 supply-chain / marketplace trust framework。Skiloom Core v0 需要的是“resolution 过程中什么 source 可以进入、其 exact provenance 是什么、之后是否发生了不可接受的漂移”。

以下属于 Core：

| 规则 | 归属 | 说明 |
| --- | --- | --- |
| GitHub `owner/repo[/package]` source coordinate grammar | Core GitHub source profile | 输入 identity |
| Release / explicit Git source-kind 不静默互相 fallback | Core | 防止 source policy 漂移 |
| transitive Manifest 不得声明 Git/path/URL source override | Core | 防止 Package 自行扩张 source model |
| repository-scoped exact source binding | Core | provenance 一致性 |
| Release actual tag + exact commit / Git exact commit 进入 Lock | Core | exact provenance |
| Package Content Digest 与 provenance 分离 | Core | integrity 与 origin 各自可审计 |
| Release/tag retarget detection | Core | 已确认 source 不静默漂移 |
| candidate 新增/改变 repository source 必须在 Confirmed Resolution 替换前被授权 | Core trust boundary | 防止 transitive source-set 静默扩张 |
| replay 只能使用已确认 Lock source set | Core | 普通 sync 不重新发现新 source |

### 4.2 “transitive dependency 可以命名新 repository”与“不能静默扩张 approved sources”并不矛盾

现有 Core dependency coordinate 是：

```text
owner/repo/package
```

因此一个合法 dependency closure 可以引入新的 GitHub repository。禁止这一点会等价于要求项目提前手写完整 transitive allowlist，与当前 Manifest dependency model 冲突，也没有必要。

真正需要的 trust rule 应是：

```text
Dependency metadata MAY nominate another GitHub repository.

But a repository that is not already in the current Confirmed Resolution
MUST NOT become confirmed merely because a transitive Manifest named it.

The complete candidate repository/source set MUST be covered by the
explicit acceptance decision that creates/replaces the Confirmed Resolution.
```

因此：

- initial resolution：在第一次 Lock 成为 Confirmed Resolution 前，acceptance 覆盖完整 repository/source set；
- explicit update：任何新增 repository、source-kind 变化、Release/tag/commit 变化都属于 candidate diff；
- ordinary replay/sync：只使用 Lock 中已经确认的 source set；
- non-interactive acceptance policy：必须显式定义它授权哪些 repository/source-set 变化，不能把“命令能运行”本身视为授权。

这个边界利用 ADR 0011 已接受的 candidate/acceptance 模型完成 source authorization，不需要 v0 再引入 Registry allowlist 服务。

### 4.3 不属于 Core v0 trust 的内容

以下应明确留在 future extension / product policy：

- publisher reputation / stars / download counts；
- marketplace curation / recommendation / ranking；
- package index 作为强制解析前置；
- organization verification；
- maintainer account trust score；
- signing PKI / Sigstore / transparency log；
- malware scanning / sandbox / behavioral analysis；
- enterprise policy engine；
- 通用 provider abstraction。

这些未来都可以叠加在 Core exact provenance 之上，但不能改变相同 Core inputs 的 Package identity、digest 或 Confirmed Resolution 语义。

### 4.4 #9 最终结论

上述 open items 已由 [`source-trust-conformance.md`](source-trust-conformance.md) / ADR 0015 收敛：owner/repo lowercase canonicalization；rename/transfer fail-closed explicit transition；published Release + actual tag/exact commit authority；complete Candidate Repository Set acceptance；ambiguous access failure使用 non-disclosing source error；v0 无 mandatory index，content-serving Registry 必须是 future source profile。

---

## 5. 审查后的依赖关系

Core 边界把三个 Issue 的职责重新压缩为：

```text
#4 Package Manifest
  owns Core dependency declaration shape
  + Host Observation extension attachment point

#7 Resolver
  owns deterministic Release requirement + graph/source selection semantics

#9 Source / Trust
  owns GitHub coordinate/source authorization + exact provenance/integrity boundary
```

互相不得反向侵入：

- #4 不拥有 source override / GitHub trust policy；
- #7 不拥有 host software version grammar/probe capability；
- #9 不拥有 Registry marketplace、publisher reputation 或 Package dependency schema；
- 三者都不得重新打开已接受的 Package Snapshot、Intent/Confirmed Resolution 或 flat activation 决定。

## 6. 下一步顺序

建议按以下顺序继续：

1. **#4**：先把 `[software]` 从 Core dependency semantics 改成 Host Observation Extension attachment，并解决 extension version/capability 行为；
2. **#7**：只针对 Release requirement grammar、prerelease、candidate ordering、intersection/conflict fixtures做官方规范/实现研究后定案；
3. **#9**：在 #7 的 source candidate 语义稳定后，固定 GitHub coordinate canonicalization 与 candidate source-set authorization；
4. 最后为 Class P/R/A 设计 conformance fixtures；此时仍不需要实现 CLI/runtime。
