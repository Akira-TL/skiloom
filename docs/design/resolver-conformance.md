# Skiloom Core Resolver / Lock Conformance v0

状态：Partially Superseded

当前说明：Cargo-style requirement、SemVer 候选顺序、确定性回溯、cycle 与结构化解析失败等具体算法规则继续有效；Project Intent / Lock / Confirmed Resolution / Class R / conformance 相关内容已退役。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

对应历史 Issue：#7 `Define version constraints and the dependency solver`

外部语义调研：[`../research/semver-requirement-grammar-2026-09.md`](../research/semver-requirement-grammar-2026-09.md)

## 1. Resolver 输入与输出边界

Class R 的规范输入是：

```text
canonical Project Intent
+ fixed GitHub source metadata / exact Git snapshots
+ Class P Package discovery / Manifest semantics
```

规范输出是二者之一：

```text
complete candidate resolution
或
structured resolution failure
```

相同 Core version、相同规范输入必须得到相同 repository source bindings、Package graph 与 error category。

Cache、网络重试、并行 fetch、CLI 命令名、candidate 展示 UI、Store materialization、activation 与 Host Observation 不属于 Class R selection semantics。

## 2. Release Version Requirement v1

### 2.1 绑定对象

Skiloom Release Version Requirement v1 采用 **Cargo Version Requirement semantics profile**：

- SemVer version 本身按 Semantic Versioning 2.0.0；
- requirement 使用 Cargo documented 的 default/caret/tilde/wildcard/comparison/comma-intersection 语义；
- `||` union、npm hyphen ranges 与 whitespace-as-AND 不属于 v1；
- software/runtime `[software]` version grammar 不使用本协议，由 Host Observation Extension 自己拥有。

规范参考：

- <https://semver.org/spec/v2.0.0.html>
- <https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html>
- <https://docs.rs/semver/latest/semver/struct.VersionReq.html>

实现不得把某个 Cargo/Rust library 的机器整数上限当成协议限制；SemVer numeric identifier 的协议语义按 SemVer 2.0.0。

### 2.2 词法形式

一个 requirement 是：

```text
*                                     # unconstrained stable release set
或
comparator ("," comparator)*
```

逗号两侧允许 ASCII whitespace。多个 comparator 取交集；缺少逗号不能把 whitespace 解释成 AND。

`comparator` operator：

```text
<empty>   # Cargo default == caret
^
~
=
>
>=
<
<=
```

operator 与 partial version 之间允许 ASCII whitespace。

partial version 使用 Cargo Version Requirement 的 major / optional minor / optional patch 表示；prerelease / build metadata 只有在该 syntax 合法时才出现。Wildcard 使用 Cargo documented forms，例如：

```text
*
1.*
1.2.*
```

v1 不接受：

```text
>=1.0 <2.0       # missing comma
^1 || ^2         # OR unsupported
1.2 - 1.9        # hyphen range unsupported
1.x              # npm x-range spelling unsupported；使用 1.*
```

### 2.3 常见展开语义

Cargo-compatible examples：

```text
1.2.3   == ^1.2.3 == >=1.2.3, <2.0.0
1.2     == ^1.2   == >=1.2.0, <2.0.0
1       == ^1     == >=1.0.0, <2.0.0

^0.2.3            == >=0.2.3, <0.3.0
^0.0.3            == >=0.0.3, <0.0.4

~1.2.3            == >=1.2.3, <1.3.0
~1.2              == >=1.2.0, <1.3.0
~1                == >=1.0.0, <2.0.0

1.*               == >=1.0.0, <2.0.0
1.2.*             == >=1.2.0, <1.3.0
```

`=1.2.3` 表示 exact release version requirement；裸 `1.2.3` **不是 exact**，而是 caret-compatible requirement。

项目文档与生成器 SHOULD 显式写 `^1.4` / `=1.4.3`，避免读者误解裸版本。

### 2.4 Prerelease

v1 使用 Cargo prerelease matching semantics：

- 普通 requirement 默认排除 prerelease；
- 要匹配 prerelease，requirement 必须显式包含相同 `major.minor.patch` release tuple 的 prerelease comparator；
- 显式 prerelease requirement 可以接受该 tuple 上更高的 prerelease；
- 当 requirement 的普通 compatibility range允许时，也可以从 prerelease 前进到 compatible stable release；
- 要只锁一个 prerelease，使用 `=<full-prerelease-version>`。

例如：

```text
^1.0.0-alpha
```

可以显式 opt in `1.0.0` tuple 的更高 prerelease，并最终允许 compatible stable release；但不会因此自动 opt in `1.1.0-beta` 这类另一个 release tuple 的 prerelease。

### 2.5 Build metadata

SemVer build metadata不参与 precedence。Cargo requirement semantics 允许 requirement 中出现 build metadata但匹配时忽略它；Skiloom v1 相同。

因此 requirement 不能用 build metadata 在两个同 precedence Release 之间做选择。候选 tie 由第 5 节 fail closed。

## 3. Requirement canonicalization

Project Lock 的 top-level `[[requirement]].version` 写 **canonical Release Version Requirement**，而不是 Project Manifest 原始字符串。

Canonicalization v1：

1. parse requirement；
2. default operator 规范为显式 `^`；
3. operator 与 version 之间不写 whitespace；
4. numeric components 使用最短十进制表示；
5. build metadata 从 canonical requirement 中移除，因为它不参与 matching；
6. comparator 内 prerelease identifier 保持 case-sensitive exact bytes；
7. duplicate comparators 去重；
8. comparator 按其 canonical UTF-8 bytes 升序；
9. comparator 之间使用 `, `；
10. unconstrained requirement canonical 为 `*`。

因此以下内容有相同 canonical requirement：

```text
1.4
^1.4
 ^1.4
```

以及：

```text
>=1.4, <2
<2 , >=1.4
```

但 v1 **不要求做任意逻辑表达式的定理级等价化**。例如 `^1.4` 与手写 `>=1.4.0, <2.0.0` 即使在许多 candidate set 上等价，也可以保留不同 canonical comparator structure。Core 只保证 parser-defined canonical equality，不要求求解集合代数证明。

Project Intent / Lock Requirement Set comparison使用该 canonical representation，所以 TOML 空白、注释、table ordering 或 requirement comparator ordering 不会造成假 mismatch。

## 4. Repository-scoped constraints

Release version属于 repository，不属于单个 Skill Package。

所有作用于同一个 `owner/repo` 的 Release requirements 都进入同一个 constraint set：

```text
owner/repo/foo -> ^1.4
owner/repo/bar -> >=1.6, <2

repository constraint set
= ^1.4 AND >=1.6 AND <2
```

实现不需要生成一条新的“交集字符串”；candidate Release 只需要同时满足该 repository 的每一个 parsed requirement。

每个 constraint 必须保留 machine-readable origin：

```text
project requirement coordinate
或
source Package coordinate + dependency target coordinate
```

origin 用于 deterministic conflict facts，不进入 Package identity。

## 5. Candidate Release ordering

对于某个 unresolved Release-bound repository：

1. [`source-trust-conformance.md`](source-trust-conformance.md) 提供 canonical repository identity 与 published (`draft=false`) GitHub Release records；
2. GitHub `prerelease` / latest / timestamp / API order 不参与 eligibility；只保留 actual tag 可规范化为 SemVer 的 Release；
3. 可选前导 `v` 从 version normalization 中移除，但 actual tag 保留为 provenance；
4. 只保留同时满足当前全部 repository constraints 的 version；
5. 按 SemVer **precedence** 从高到低形成 candidate groups。

### 5.1 Same normalized version

若同一 repository 中两个 Release 规范化为完全相同 SemVer version，例如：

```text
1.4.0
v1.4.0
```

现有规则保持：返回 `AmbiguousReleaseVersion`。

### 5.2 Equal precedence

若两个不同 SemVer version 只因 build metadata 不同而具有相同 precedence，它们不能靠 requirement 或 SemVer ordering 唯一选择。

Resolver 不使用 tag name、发布时间、API 返回顺序或字典序创造额外 version priority。

当 search 到达一个包含多个可行 candidate 的同-precedence group 时，返回：

```text
AmbiguousReleasePrecedence
```

高于该 group 的 complete solution 若已经成功，则不会访问更低 group，因此无关的旧 ambiguity 不阻塞 resolution。

## 6. Explicit Git binding

Project Intent 的 explicit Git binding 是 repository-scoped source decision。

若 repository 已被 Project Intent 显式绑定到 Git：

- requested ref 在 initial resolution / explicit update 中解析为 exact commit；
- 同 repository 所有 Package 从该 exact commit discovery；
- Manifest 中指向同 repository 的 Release requirement仍必须是合法 requirement syntax，但**不参与 source/version selection**；
- Resolver MUST NOT 因该 transitive range 自动切回 GitHub Release；
- 跨 repository dependency 若没有其自己的 Project Intent Git binding，仍按 Release source 处理。

如果 Project Intent 自身对同 repository 同时要求 Release 与 Git，或要求不同 Git refs，返回既有：

```text
RepositorySourceConflict
```

Skiloom Package 不自报独立 version，因此 Core 无法、也不得伪造“Git commit 满足某个 Release range”的检查。

## 7. Deterministic complete-solution search

Version-dependent Package Manifest 会使“每个 repository 贪心拿最高 Release”错过可行解，因此 Class R 必须允许 backtracking；但结果不能依赖实现内部 hash-map 顺序或 solver heuristic。

v0 固定以下 canonical search order。

### 7.1 State

Resolver state 至少逻辑包含：

```text
required top-level/package targets
repository source bindings
Release constraint sets + origins
assigned exact Git snapshots
assigned candidate Release versions/snapshots
expanded Package coordinates for current assignments
resolved dependency edges
```

### 7.2 Initialization

1. Project Requirements 按 canonical coordinate UTF-8 bytes 升序处理；
2. 先检测 repository source conflicts；
3. explicit Git refs 按 repository coordinate 升序解析为 exact commit；
4. Release Project Requirements 加入对应 repository constraint set；
5. package-specific target 加入 required Package set；repository-wide target 加入该 snapshot 的全部 discovered Package set。

### 7.3 Propagation

对当前已经 assigned exact snapshot 的 repository：

1. 待展开 Package coordinate 按 UTF-8 bytes 升序；
2. 使用 Class P discovery / Manifest semantics读取 Package；
3. 每条 `[dependencies]` edge 按 target coordinate UTF-8 bytes 升序加入 graph；
4. target Package 加入 required Package set；
5. 如果 target repository 是 explicit Git binding，只增加 Package target，Release range 不参与 selection；
6. 否则把 parsed Release requirement + origin 加入 target repository constraint set；
7. 如果新 constraint 不再满足已经 assigned 的 Release candidate，该 branch 失败并 backtrack；
8. 重复直到没有新的 Package/constraint/edge。

### 7.4 Next repository

Propagation 达到 fixed point 后：

- 如果所有 required repository 都有 exact binding，得到 complete candidate resolution；
- 否则从所有 unresolved Release-bound repositories 中选择 canonical repository coordinate UTF-8 bytes **最小**的一个作为下一 decision repository。

### 7.5 Candidate trial

对 decision repository：

1. 生成第 5 节 candidate groups；
2. 从最高 precedence group 开始；
3. group 唯一 candidate：assign snapshot，执行 propagation/recurse；
4. branch 失败：回滚该 branch 产生的 assignment/constraints/packages/edges，尝试下一更低 precedence group；
5. group 含多个 equal-precedence candidates且 search 到达该 group：`AmbiguousReleasePrecedence`；
6. 第一个 complete solution 即 v0 deterministic solution。

所有 set/map 的遍历必须按本节明确的 canonical coordinate ordering；不得让网络返回顺序、filesystem order 或语言容器迭代顺序影响 branch order。

### 7.6 Previous Lock 不参与 candidate preference

在 explicit resolution-changing operation 中，旧 Confirmed Resolution：

- 只作为 candidate diff / acceptance 的 baseline；
- MUST NOT 作为“prefer locked version”的隐藏 solver heuristic；
- MUST NOT 改变 canonical candidate ordering。

因此给定相同 Project Intent 与相同 source metadata，initial resolution 与 full explicit re-resolution得到同一个 candidate。

未来若提供 selective update，未更新部分必须通过**显式 exact constraints / operation input**固定，而不能通过 implementation-specific lock preference 偷偷影响 solver。

## 8. Dependency cycles

v0 **允许 Skill dependency graph 存在 cycle**。

例如：

```text
A -> B -> C -> A
```

不是 resolution error。原因：Skiloom Skill Package 没有 build/link phase，安装闭包只需要把每个 exact Package materialize 一次；cycle 本身不要求两个版本同时占用同一个 Package identity，也不构成 source conflict。

Resolver：

- MUST 保留 cycle 中全部 exact dependency edges；
- MUST 通过 visited/expanded Package identity 防止递归无限展开；
- MUST NOT 因实现采用 topological traversal 方便而拒绝合法 cycle；
- `why`、remove/reachability 等 reference-manager 操作需要使用 visited set/SCC-safe traversal，但不属于 Class R selection algorithm。

真正的错误仍是 cycle 内产生的 repository source/version constraint 无法满足，而不是 graph topology 本身。

## 9. Backtrackable 与 fatal failure

Candidate-specific incompatibility可以使当前 candidate branch 失败并尝试更低 Release，例如：

- 当前 candidate 不包含 required Package；
- 当前 candidate 的 Core Manifest 不能形成合法 Package graph；
- 当前 candidate 引入的 Release constraints最终无解；
- 当前 candidate 与已经选择的 repository version constraints冲突。

Source/provenance/integrity 的 fail-closed violation 不得被当作“换个旧版本就好了”的普通 solver branch failure；其 fatal 分类由 #9 Source / Trust 固定，例如 source retarget/integrity ambiguity。

## 10. Structured resolution failures

Human-readable error wording不属于 Core，但 machine-readable category / conflict facts属于 Class R conformance。

### `InvalidReleaseRequirement`

至少包含：

```text
requirement string
origin coordinate
```

### `UnsatisfiableReleaseRequirements`

当某个 decision repository 没有任何 version 满足当前 constraint set，至少包含：

```text
repository coordinate
requirements[]:
  canonical requirement
  origin kind
  origin coordinate
```

`requirements[]` 按 `(canonical requirement, origin coordinate)` UTF-8 bytes 排序。

### `AmbiguousReleaseVersion`

至少包含 repository coordinate、normalized version、冲突 actual tags（UTF-8 bytes 排序）。

### `AmbiguousReleasePrecedence`

至少包含 repository coordinate、相同 precedence 的 canonical SemVer versions 与 actual tags（UTF-8 bytes 排序）。

### `UnresolvableDependencyGraph`

当 decision repository存在 candidate，但所有更高到更低的 candidate branches 都无法形成 complete solution，至少包含：

```text
repository coordinate
candidate versions in attempted precedence order
root failure code + subject coordinate for each attempted candidate
```

实现 MAY 提供更完整因果树，但上述 root facts 必须稳定，使 fixture 不依赖自然语言诊断。

Package/source-specific错误继续使用对应 Core error category；不再使用 `DependencyCycle`，因为 cycle 合法。

## 11. Candidate acceptance 与 Lock

求解器只产生 candidate，不直接把它升级为 Confirmed Resolution。

candidate 必须完整包含：

```text
exact repository source bindings
selected Release versions + actual tags + exact commits
exact Git commits
selected Package roots/content digests
exact manifest-declared dependency edges
```

若已有 Confirmed Resolution，candidate diff 至少覆盖 repository version/tag/commit、Package graph 与 content identity 变化。

只有 ADR 0011 定义的 explicit acceptance / explicit automation policy 接受后，才写新 Project Lock。未接受时原 Lock 与 activation保持不变。

## 12. Conformance fixtures

Class R v0 fixture suite至少覆盖：

1. caret、tilde、wildcard、comparison、comma intersection；
2. invalid `||` / hyphen / whitespace-as-AND；
3. prerelease opt-in 与 exact prerelease；
4. build metadata ignored in requirement matching；
5. `v` tag normalization duplicate；
6. equal-precedence build metadata ambiguity；
7. multiple same-repository constraints；
8. explicit Git binding suppresses same-repository Release selection；
9. cross-repository dependency closure；
10. highest candidate branch成功；
11. highest candidate branch失败后 deterministic backtrack到下一 candidate；
12. version-dependent dependency引入新 constraint；
13. dependency cycle合法并保留全部 edges；
14. source conflict；
15. unsatisfiable constraints with canonical origins；
16. previous Lock 不改变 explicit re-resolution candidate；
17. matching Lock replay 完全不运行 resolver。

fixtures 必须使用固定 source metadata/exact snapshot test data，不能把 GitHub 当前线上状态当 conformance oracle。

## 13. 一句话契约

```text
Class R = Cargo-style conjunctive SemVer requirements
        + repository-scoped source binding
        + canonical highest-first backtracking search
        + cycle-safe graph expansion
        + lock-independent explicit re-resolution
        + structured deterministic conflict facts.
```
