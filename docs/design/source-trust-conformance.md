# Skiloom Core GitHub Source / Trust Conformance v0

状态：Partially Superseded

当前说明：GitHub coordinate、Release/Git source kind、exact commit、published Release、redirect/retarget 与完整来源确认等具体产品规则继续有效；Project Intent / Lock / Confirmed Resolution / Class R / Full Core conformance 相关内容已退役。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

对应历史 Issue：#9 `Define package sources, indexes and trust policy`

外部事实核查：[`../research/github-source-identity-trust-2026-09.md`](../research/github-source-identity-trust-2026-09.md)

本文中的 **MUST / MUST NOT / SHOULD / MAY** 按 RFC 2119 / RFC 8174 的规范性含义理解。

## 1. v0 source profile

Skiloom Core v0 只有一个 mandatory distribution family：GitHub repository source。

它有两种明确 source kind：

```text
github-release

git
```

规则：

- Release source 通过 repository-level GitHub Release SemVer 选择 source snapshot；
- Git source 只在 Project Intent 显式请求时使用，并把 requested ref 解析到 exact commit；
- 两种 source kind MUST NOT 因一种不可用而静默 fallback 到另一种；
- 一个 project resolution 中，同一 repository 仍只允许一个 exact source snapshot；
- Package Manifest 的 transitive dependency 只能声明 GitHub Package Coordinate + Release Version Requirement，MUST NOT 声明 Git/path/URL source override；
- v0 没有 mandatory package index、Registry source、local/path source 或 generic provider abstraction。

Future Registry 如果成为 package content/version authority，必须作为新的 source profile 明确定义，不得被实现成 GitHub source 的透明别名。

## 2. GitHub Repository / Package Coordinate

### 2.1 结构

Repository Coordinate：

```text
<owner>/<repo>
```

Package Coordinate：

```text
<owner>/<repo>/<package>
```

`package` 仍是 `SKILL.md.name`，遵守 Agent Skill name grammar。

Core coordinate parser 至少要求：

- owner、repo、package 对应的 segment 非空；
- `/` 只作为 segment separator；
- repository coordinate 恰好两个 segment；
- package coordinate 恰好三个 segment；
- 不把 `.git` URL suffix、scheme、hostname、query、fragment 或 Git ref 混入 coordinate。

GitHub 对 owner/repo 本身是否存在、是否允许某个当前平台字符组合，由 GitHub source lookup 决定；Core 不复制一份可能随平台变化的完整 GitHub account/repository naming policy。

### 2.2 Case-insensitive semantic identity

GitHub REST repository path parameters `owner` / `repo` 不区分大小写。因此 v0 规定：

```text
canonical owner = ASCII lowercase(owner)
canonical repo  = ASCII lowercase(repo)
```

Package name 已由 Skill grammar 固定为 canonical Skill name。

所以：

```text
akira-tl/Matt-Skills/ask-matt
akira-tl/matt-skills/ask-matt
```

在 GitHub source identity 上是同一个 Package Coordinate。

所有 Core semantic comparison、repository grouping、constraint grouping、source binding、Lock coordinate、dependency edge 与 canonical ordering MUST 使用 canonical lowercase owner/repo。

实现 MAY 在 UI 中保留用户输入或 GitHub display casing，但 display casing MUST NOT 进入 Confirmed Resolution identity。

### 2.3 Case-only 变化不是 source transition

如果 source API 返回的 display casing 与输入不同，但 ASCII lowercase 后相同，这只是表示差异，不构成 repository rename/transfer，也不需要 acceptance。

## 3. Repository rename / transfer / redirect

GitHub 会为 rename/transfer 建立 redirect，但旧 namespace 后续可能被重新占用并破坏 redirect。因此 redirect 本身不是 Skiloom source identity。

### 3.1 Resolution-changing operation

在 initial resolution 或 explicit re-resolution 中：

- source adapter MUST 能识别 requested canonical `owner/repo` 是否被 GitHub redirect / rename / transfer 到另一个 canonical coordinate；
- 若 redirect destination 的 canonical coordinate 与 requested canonical coordinate 不同，MUST 返回：

```text
RepositoryCoordinateChanged
```

至少包含：

```text
requested-coordinate
resolved-coordinate     # 当 source 能安全观察到时
```

- Resolver MUST NOT 把该 redirect 静默视为同一个 canonical repository；
- Resolver MUST NOT 自动重写 Project Intent、Package Manifest dependency 或 Lock coordinate；
- v0 不建立 repository alias map，也不依赖 undocumented numeric repository-ID stability 来自动迁移。

要接受真正的 owner/repo transition，source coordinate 本身必须通过新的显式 project/package metadata 进入下一次 candidate resolution。

### 3.2 Confirmed Resolution replay

Lock 中 repository coordinate 是该 Confirmed Resolution 的历史 provenance，不因 GitHub 后续 rename/transfer 自动改写。

Replay MAY 使用：

- immutable Package Store；
- existing exact Git objects；
- transport redirect；
- mirror/cache；

去恢复 locked exact commit / Package Snapshot，但这些 acquisition choices MUST NOT 改变 Lock source identity。

无论 acquisition path 如何，replay 都必须验证 locked exact commit / Package Content Digest 的 Core invariants。一个 transport redirect 成功不等于允许产生新的 canonical source coordinate。

## 4. GitHub Release candidate records

### 4.1 只有 published Release 进入 candidate set

GitHub `List releases` 对具有 push access 的调用者可能额外返回 draft releases。为了让不同 credentials 的 Class R implementation 得到相同 candidate semantics：

```text
draft = true
```

的 Release MUST 被排除。

只有 published / `draft=false` Release record 才可进一步进入 SemVer candidate processing。

### 4.2 SemVer authority 是 actual tag

Release Version 来源继续是：

```text
actual GitHub Release tag
  -> optional leading v normalization
  -> SemVer
```

以下 GitHub presentation metadata MUST NOT 改写 Class R SemVer eligibility / ordering：

```text
prerelease boolean
make_latest / latest marker
release title
release notes
published_at / created_at ordering
release id
API list order
```

特别是 GitHub immutable release 仍允许修改 `prerelease` marker，因此 prerelease matching MUST 使用 [`resolver-conformance.md`](resolver-conformance.md) 已接受的 SemVer/Cargo requirement semantics，而不是 GitHub `prerelease` boolean。

### 4.3 Exact commit authority

`target_commitish` 在 Release tag 已存在时不会决定该 tag 的 identity。因此 source resolution MUST：

1. 保留 Release 的 actual tag string；
2. 解析/peel actual Git tag object；
3. 最终得到 exact commit；
4. 若该 tag 无法最终解析为 commit，则该 Release 不能形成 Skiloom repository source snapshot。

Core MUST NOT 使用 `target_commitish` 代替 actual tag -> exact commit resolution。

## 5. Immutable Release signal

现有 ADR 0005 保持：GitHub immutable Release 是 provenance/trust signal，不是 v0 installation admission requirement。

Release Repository Lock Record继续保存：

```text
canonical repository coordinate
source-kind = github-release
normalized SemVer version
actual tag
exact commit
immutable boolean observed at acceptance time
```

其中：

- `immutable=true` 表示接受 candidate 时 GitHub 声明 associated tag/assets 受 immutable release protection；
- `immutable=false` 仍可形成合法 Core resolution；
- 无论 immutable 值为何，exact commit 与 Package Content Digest都必须存在；
- immutable Release 自动生成的 GitHub release attestation MAY 被 extension/product policy 验证，但不是 P/R/A Full Core 的必要能力；
- GitHub auto-generated source archive bytes不是 Package identity，也不进入 Lock。

## 6. Explicit Git source

Project Intent 的 Git source继续是 repository-scoped explicit override：

```toml
[skills]
"owner/repo/package" = { git = "main" }
```

规范语义：

- input coordinate 先按第 2 节 canonicalize；
- requested ref 只属于 Project Requirement semantics；
- initial resolution / explicit update 将 ref 解析到 exact commit；
- Repository Lock Record只保存 canonical coordinate、`source-kind = "git"` 与 exact commit；
- matching Confirmed Resolution replay MUST NOT 重新前进 branch/ref；
- Manifest dependency无法自行把跨-repository Release source切换成 Git；
- 如果 Project Intent已显式 Git-bind 一个 repository，同 repository sibling dependency复用该 exact commit，既有 Release range不参与 source/version selection；
- Git source不可用时 MUST NOT 自动切回 GitHub Release。

Credential transport、SSH vs HTTPS、bare clone、Git Source Cache path/GC 都不是 Core source semantics。

## 7. Candidate Repository Set 与 source authorization

### 7.1 Candidate Repository Set

每个 complete candidate resolution都有一个完整 **Candidate Repository Set**：

```text
candidate repository records
= resolution 中每一个 canonical owner/repo 的 proposed exact source binding
```

每条 record 至少具有将写入 Lock 的 normative provenance facts。

Transitive Package Manifest MAY 通过 `owner/repo/package` dependency 把新的 GitHub repository引入 candidate graph；这只是 **nomination**，不是 authorization。

### 7.2 Source Authorization Delta

相对当前 Confirmed Resolution：

```text
initial resolution
  -> 所有 candidate repository records 都是新增授权事实

explicit re-resolution
  -> compare previous confirmed repository set with complete candidate set
```

至少必须识别：

```text
repository-added
repository-removed
source-kind-changed
release-version/tag/commit-changed
git-commit-changed
immutable-signal-changed   # advisory diff，不单独改变 identity
```

同一个 candidate 中 Package graph / content digest 的其他变化仍由 ADR 0011 的完整 candidate diff 负责。

### 7.3 Acceptance covers the complete source set

一个新的 candidate resolution只有在**完整 Candidate Repository Set**被 acceptance decision 覆盖后，才可以成为 Confirmed Resolution。

因此：

- transitive dependency仅因为 Manifest 写出了新 `owner/repo`，MUST NOT 自动扩大 Confirmed Resolution source set；
- ordinary sync/replay MUST NOT discover 或确认 Lock 外的新 repository；
- interactive product可用任何 UI，但必须让 acceptance有机会看到完整 source-set delta；
- candidate被拒绝时，旧 Lock/activation保持不变。

### 7.4 Non-interactive acceptance policy contract

Core不规定 enterprise allowlist DSL 或 UI，但 non-interactive policy至少必须是对**完整 candidate**的显式 decision point。

调用 policy 时 MUST 提供 machine-readable：

```text
previous confirmed repository set（没有则为空）
complete candidate repository set
source authorization delta
每个新增 repository 的 origin paths / top-level-or-transitive provenance
```

Policy 输出必须是：

```text
accept complete candidate
或
reject complete candidate
```

实现 MUST NOT 把“调用了 update/sync 命令”“resolver 找到了解”或“dependency metadata 写了这个 repository”本身解释成 authorization。

Policy可以由用户明确配置成宽松或严格；具体规则语言属于 product/extension，不属于 Core。

## 8. Dependency provenance for source authorization

为了让新增 transitive repository可以被审计，candidate resolver MUST 能对每个非 top-level repository给出至少一条 deterministic origin path：

```text
top-level Project Requirement
  -> Package dependency edge
  -> ...
  -> repository/package that introduced this repository
```

如果存在多条 path，Core source-authorization facts至少需要一条按 canonical coordinate ordering选出的 deterministic path；实现 MAY 附加全部 paths。

这些 candidate explanation facts不进入 Package Content Digest，也不需要写入 canonical Lock，因为 Lock 已保存 exact Package graph；接受后的 provenance path可从 Lock graph重建。

## 9. Source access / private repository / authentication

Skiloom Core允许 public 或 private GitHub repository，只要当前 implementation能够取得 required exact source data。

Credentials 不属于 Project Lock：

```text
PAT / OAuth token
GitHub App installation token
SSH key
credential helper
secret-store path
```

都属于 runtime/product secret management。

GitHub 会在 unauthorized private-resource access 等情况下返回 `404` 或 `403`。因此 repository-level lookup失败且无法区分“不存在”和“无权限”时，Core错误 MUST 使用不泄露错误断言的类别：

```text
SourceAccessUnavailable
```

至少包含：

```text
repository-coordinate
reason = "not-found-or-not-authorized"
```

实现 MAY 附加 transport status/diagnostic，但 MUST NOT 在 machine-readable Core verdict 中把普通 404断言为 repository definitely absent。

如果 repository metadata 已经成功访问，之后可以更精确地区分：

```text
UnavailableRelease
UnavailableGitRef
PackageNotFound
```

## 10. Retarget 与 integrity

### 10.1 Release retarget

若一个 operation观察到 Lock 中同一 canonical repository + actual Release tag当前解析到的 exact commit 与 locked commit 不同，必须返回：

```text
ReleaseRetargeted
```

并且：

- MUST NOT 自动修改 Lock；
- MUST NOT 把 retarget当普通 version upgrade；
- MUST NOT 通过尝试较低 Release candidate掩盖这个 provenance violation。

Lock/Store-only replay不需要为了恢复 exact confirmed content强制访问 GitHub；但任何实际执行 source/tag verification 的 operation一旦观察到 retarget，都必须 fail closed。

### 10.2 Package content integrity

Source provenance 与 Package content identity继续分离：

```text
repository/tag/commit
  -> where exact source came from

Package Content Digest
  -> what selected Package snapshot contains
```

从任何 transport/cache重新构建 locked Package 时，若 canonical digest与 Lock不一致，必须返回既有 content-integrity错误，不能因为 repository/tag看起来正确而接受。

## 11. Index / Registry boundary

### 11.1 v0 没有 required package index

Core v0 resolution从 explicit GitHub coordinates开始，不要求：

```text
central registry
package search index
publisher account
namespace ownership service
```

### 11.2 Discovery index 可以存在，但不是 source authority

外部 index / catalog MAY 帮助用户搜索并最终得到：

```text
canonical GitHub owner/repo[/package]
```

只要进入 Core resolver前已经变成明确 GitHub coordinate，它只是 discovery/UX layer。

Index metadata MUST NOT 在 GitHub source profile中静默覆盖：

```text
actual Release tag
exact commit
Package discovery
Package Content Digest
Manifest dependency graph
```

### 11.3 Content-serving Registry 是新 source profile

如果未来 Registry自己拥有：

- package identity；
- package-specific version lifecycle；
- payload bytes；
- publisher identity/signature；

它就不是“GitHub index hint”，而是新的 source authority，必须用新的 versioned source profile与 provenance schema设计。

## 12. 不属于 Core v0 trust

以下明确不是 #9 / Full Core 的 mandatory 能力：

```text
stars / download count / reputation ranking
publisher trust score
GitHub organization verification
marketplace curation
malware scanning
sandbox execution
Sigstore / generic PKI / transparency log requirement
GitHub release attestation mandatory verification
enterprise policy language
package recommendation
arbitrary provider adapters
credential provisioning/login flow
```

这些可以叠加在 Core exact provenance / integrity之上，但不能改变同一 Core input的 coordinate、candidate selection、Lock语义或 Package Content Digest。

## 13. Structured Core errors

Source / Trust 至少定义：

### `InvalidGitHubCoordinate`

coordinate无法满足第 2 节 structural parser。

### `RepositoryCoordinateChanged`

至少：

```text
requested-coordinate
resolved-coordinate?
```

### `SourceAccessUnavailable`

至少：

```text
repository-coordinate
reason
```

v0 Core reason至少支持：

```text
not-found-or-not-authorized
```

### `ReleaseTagNotCommit`

至少：

```text
repository-coordinate
actual-tag
```

### `ReleaseRetargeted`

至少：

```text
repository-coordinate
actual-tag
locked-commit
observed-commit
```

其余 `UnavailableRelease`、`UnavailableGitRef`、`RepositorySourceConflict`、content-digest integrity错误继续使用既有 Core categories。

## 14. Conformance fixtures

Class R Source / Trust fixtures至少必须覆盖：

1. owner/repo case variants canonicalize成同一个 coordinate；
2. canonical Lock owner/repo输出 lowercase；
3. case-only display差异不触发 source transition；
4. genuine repository redirect到另一个 canonical coordinate -> `RepositoryCoordinateChanged`；
5. draft Release被排除，即使 fixture caller具有 push visibility；
6. GitHub `prerelease=true/false` 不改变相同 SemVer tag的 requirement matching；
7. existing tag的 `target_commitish` 不参与 exact commit；
8. annotated tag最终 peel到 commit；
9. tag不能 peel到 commit -> `ReleaseTagNotCommit`；
10. immutable true/false都可形成合法 candidate，但 Lock保留 observed signal；
11. transitive dependency引入新 repository会进入 source authorization delta，accept前不能写 Lock；
12. ordinary replay不新增 Lock外 repository；
13. non-interactive policy收到完整 previous/candidate repository sets + delta；
14. repository-level ambiguous 404/403 -> `SourceAccessUnavailable/not-found-or-not-authorized`；
15. observed same tag different commit -> `ReleaseRetargeted`；
16. correct provenance但 Package Content Digest mismatch仍 fail closed；
17. external discovery index不能覆盖 GitHub exact provenance。

Fixtures使用固定 source metadata，不访问 live GitHub作为 oracle。

## 15. v0 一句话契约

```text
GitHub coordinate canonicalize by case,
but rename/transfer never silently changes source identity;
only published SemVer-tagged Releases or explicit Git refs select exact commits;
transitive repositories may be nominated but only the complete accepted candidate source set becomes confirmed;
Lock records exact provenance, while canonical Package Content Digest independently proves selected content.
```
