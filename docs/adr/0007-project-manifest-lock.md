# ADR 0007：Project Manifest 与 Lock 三层模型

- 状态：Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：本 ADR 的 Project Manifest / Project Lock / `.agents/.skiloom` / frozen 模型已经退役。当前直接安装要求、本机精确状态、Target 与 sync/update 语义以 `docs/design/skiloom-v0-product-contract.md` 为准；本文只保留历史设计记录。

## 背景

早期 `skiloom.toml` 为 Git source 使用 `"*"` version placeholder + 独立 `[sources]` table；`skiloom.lock` 又在 Package Record 中重复 source kind、version、commit，并保存 Manifest/Dependency Check File digest 与 software requirements。随着 repository source、Package Snapshot 和本机 dependency state 的职责已经分离，这些重复字段不再必要。

## 决定

Project state 的解析模型仍分三层，但文件统一放在 `.agents/.skiloom/`：

```text
.agents/.skiloom/skiloom.toml
→ top-level requirement intent + explicit activation renames

.agents/.skiloom/skiloom.lock
→ normalized requirements + exact repository source + exact Package Snapshot graph

.agents/.skiloom/dependencies.lock
→ current host dependency observations
```

项目 Skill 激活位置与 activation state 后续由 ADR 0008 收敛：executor-visible Skill 直接位于 `.agents/skills/`，`.agents/.skiloom/activation.lock` 单独记录本机激活状态。

具体规则：

- `.agents/.skiloom/skiloom.toml [skills]` 的字符串值表示 GitHub Release version requirement；Git source 使用 `{ git = "<ref>" }` inline table；用户批准的 Skill rename 记录在同文件 `[renames]`；
- source binding 始终是 repository-scoped，同一 resolution 的一个 `owner/repo` 只能绑定一个 exact snapshot；不同 Git ref 或 Release/Git 混装返回 `RepositorySourceConflict`；
- `.agents/.skiloom/skiloom.lock` 只包含 `[[requirement]]`、`[[repository]]`、`[[package]]` 三类 Record；
- source provenance 只写在 Repository Record；Package Record 不重复 source kind/version/commit；
- dependency edge 只写 `owner/repo/package`，不重复 exact version/commit；
- Project Lock 不保存 `manifest-digest`、`dependencies-doc-digest` 或 `[[software]]`；Package `content-digest` 已覆盖 immutable payload；
- `frozen` 比较解析后的 Requirement Set，不 hash `.agents/.skiloom/skiloom.toml` 原始 bytes；
- 后续 ADR 0011 进一步固定 Project Intent / Confirmed Resolution 分离：已有匹配 Lock 的普通 `sync` 只恢复 exact Lock，不再重新求解或隐式改写；只有 initial resolution / 显式 update 在明确接受后才能产生新的 Confirmed Resolution；
- Lock writer 使用 UTF-8、LF、无注释，并按 coordinate canonical 排序。

## 结果

Project Manifest 只描述用户意图，Repository Record 只描述 exact source，Package Record 只描述 exact content 与 dependency graph。本机环境状态留在 `.agents/.skiloom/dependencies.lock`；activation ownership/materialization state 由 ADR 0008 定义的 `.agents/.skiloom/activation.lock` 单独管理。
