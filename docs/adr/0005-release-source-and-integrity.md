# ADR 0005：Release Source 与完整性边界

- 状态：Accepted
- 日期：2026-09-14
- 当前说明：Release SemVer、actual tag -> exact commit、内容完整性与 retarget 规则继续有效；文中 `Lock` / `skiloom.lock` 仅是 pre-shift 持久化表述，现行精确来源事实保存在 Machine Registry 的当前已接受状态中，并在显式导出时传播。

## 背景

Skiloom 已确定 GitHub 是 v0 的直接 source model，并且任何合法 `SKILL.md` 都可以成为 Skill Package。此前设计仍保留可选 per-Skill Skiloom Release Asset，这会让同一个 GitHub Release 同时存在 repository source 与额外 Package Asset 两套内容来源，增加优先级、对应关系和完整性规则。

同时 GitHub Release tag 本身不天然提供 Skiloom 所需的版本范围语义；Skiloom 的 dependency resolver 需要稳定的 repository-level version space。

## 决定

### Release version

Skiloom Release resolver v0 只接受 Semantic Versioning（SemVer）GitHub Release：

```text
1.4.0
v1.4.0
```

可选前导 `v` 被规范化掉。若同一 repository 同时存在规范化后相同的多个 Release，例如 `1.4.0` 与 `v1.4.0`，返回 `AmbiguousReleaseVersion`。

非 SemVer tag 不进入 Release resolver；需要该 tag/branch/commit 时显式使用 Git source。

### Release payload

Skiloom v0 不定义 per-Skill Release Asset。

Release 只负责：

```text
SemVer version -> actual GitHub tag -> exact commit
```

Skiloom 随后取得该 exact commit 对应 repository source snapshot，并使用与 Git source 完全相同的 `skiloom-repo.toml` + `SKILL.md` discovery 管线。

### 完整性

长期可重建身份使用：

```text
exact commit
+ repository-relative Package Root
+ Package content digest
```

GitHub 自动生成 source archive 的压缩 bytes 只作为传输载体，不作为长期 Package identity。下载时仍必须做安全 materialization 和必要的临时完整性检查。

### Immutable Release

GitHub Release 的 immutable 状态是 provenance/trust signal，不是 v0 安装准入条件。Lock 记录获取时的 immutable 状态，但无论 true/false 都必须记录 exact commit 与 Package content digest。

### Release retargeting

如果 Lock 已记录：

```text
v1.4.0 -> commit AAA
```

而当前同名 tag/Release 解析为 `BBB`，普通 `sync` 返回 `ReleaseRetargeted`，不得自动漂移。只有显式 update/重新解析操作才能接受新的 source snapshot。

## 结果

- Release 与 Git source 在 exact commit 以后共用同一 discovery / dependency / Store 管线；
- 普通 Skill repository 无需为 Skiloom 构建任何额外 Release 包；
- Skiloom 不需要定义 Asset/package-index 对齐规则；
- repository Release version 与 Package version 不再重复声明；
- Lock 的 source provenance 与 Package content integrity 分层明确；
- future Registry 或未来性能优化若需要专用 artifact，可以作为新的 source/transport capability 单独设计，不影响 GitHub v0 协议。
