# ADR 0015：GitHub Source Identity 与 Trust Boundary

- 状态：Partially Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：GitHub coordinate、Release/Git source kind、exact commit、published Release、redirect/retarget 与完整来源确认等产品规则继续有效；Project Intent、Lock、Confirmed Resolution 与 Core conformance 措辞不再是当前权威。现行规则见 `docs/design/skiloom-v0-product-contract.md`。

## 背景

Skiloom v0 已接受 GitHub repository-scoped source、Release/Git 两种 source kind、exact commit provenance、Package Content Digest，以及 Project Intent / Confirmed Resolution 分离。#9 需要把 GitHub coordinate、repository rename/transfer、Release candidate metadata 与 candidate source-set acceptance 的边界固定下来。

## 决定

1. GitHub Repository Coordinate 继续使用 `owner/repo`，Package Coordinate 使用 `owner/repo/package`；owner/repo 在 Core semantic comparison 与 canonical Lock 中统一为 ASCII lowercase。Case-only 差异不是 source transition。
2. Initial resolution / explicit re-resolution 遇到真正的 repository rename、transfer 或 redirect 到另一 canonical coordinate 时返回 `RepositoryCoordinateChanged`。v0 不自动建立 alias，也不自动改写 Intent、Manifest 或 Lock。
3. Release candidate 只接受 published records；`draft=true` 必须排除。SemVer eligibility/order 只由 actual tag 与 Resolver 规则决定；GitHub presentation flags 与时间顺序不参与。
4. Actual Release tag 必须最终解析为 exact commit；`target_commitish` 不作为 exact source identity。
5. GitHub immutable Release 继续只是 provenance signal，不是 installation requirement。Exact commit 与 Package Content Digest 始终是必需事实。
6. Manifest dependency 可以把新的 GitHub repository 引入 candidate graph，但只有完整 Candidate Repository Set 被 acceptance decision 覆盖后，新的 source set 才能成为 Confirmed Resolution。普通 replay 只使用已确认的 Lock source set。
7. Non-interactive acceptance 必须接收完整 previous/candidate repository set、source-set delta 与新增 repository 的 deterministic origin path，并对 complete candidate 作 accept/reject。
8. v0 不要求 package index 或 Registry。Discovery catalog 只能帮助得到明确 GitHub coordinate；若未来 Registry 自己成为 identity/version/payload authority，它必须是新的 source profile。
9. v0 不新增 numeric repository identity 字段。当前规范只依赖明确 GitHub coordinate、exact commit 与 Package Content Digest。

## 结果

GitHub coordinate casing 得到唯一 canonical identity；rename/transfer 不会靠 redirect 静默改变 source；不同调用权限不会因为 draft visibility 改变 published Release candidate set；transitive repository 只能被提名，不能在没有 complete candidate acceptance 的情况下进入 Confirmed Resolution。

完整 normative contract 见 [`../design/source-trust-conformance.md`](../design/source-trust-conformance.md)。
