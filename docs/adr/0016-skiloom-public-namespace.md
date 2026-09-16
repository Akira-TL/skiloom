# ADR 0016：采用 Skiloom 公开产品与协议 Namespace

- 状态：Partially Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：`Skiloom / skiloom` 品牌、CLI/package token、`skiloom-package.toml`、`skiloom-repo.toml` 与 `SKILOOM-PACKAGE-V1` 继续有效；旧 `.agents/.skiloom/skiloom.toml`、`skiloom.lock`、`activation.lock` 等项目状态 namespace 已退役。现行规则见 `docs/design/skiloom-v0-product-contract.md`。

## 背景

旧工作名 `AKM / akm` 与当前 Agent tooling 中多个项目及 CLI 直接碰撞，`ASKM` 也已有同领域使用。协议设计已经进入准备 formal Spec 的阶段，继续让临时名字出现在 config filenames、project state path 与 Package Snapshot domain tag 中，会把碰撞永久写进公开标准。

本轮对 `Skiloom / skiloom` 做了 GitHub 与常见 package-registry 工程碰撞核查，没有发现当前同名软件 repository 或 exact PyPI/npm/crates.io package；它满足当前项目的 collision-free engineering name bar。

## 决定

公开 identity 固定为：

```text
Product / protocol: Skiloom
lowercase token:    skiloom
CLI:                skiloom
GitHub target:      Akira-TL/skiloom
```

协议/config namespace 固定迁移为：

```text
.agents/.skiloom/
  skiloom.toml
  skiloom.lock
  activation.lock
  dependencies.lock

skiloom-package.toml
skiloom-repo.toml
```

`.agents/skills/`、`SKILL.md` 与 `DEPENDENCIES.md` 不因品牌 rename 改名。

Package Snapshot public format identifier从未发布的 working-draft `AKM-PACKAGE-V1` 改为：

```text
SKILOOM-PACKAGE-V1
```

以及 canonical header：

```text
SKILOOM-PACKAGE-V1\0
```

Snapshot framing和其他已接受算法不改变。因为旧 identifier 从未成为公开 release，本次是 pre-standard namespace correction，不定义 `akm` compatibility alias、dual-reader 或 dual-digest；正式 v0 只认 Skiloom namespace。

Reference implementation未来首选 distribution/package token也是 `skiloom`，但具体 language registry不是 Core protocol的一部分，实际发布前重新核查/取得对应 namespace。

GitHub repository在 active source-of-truth docs完成 namespace migration后，从 `Akira-TL/akira-skill-manager` rename到 `Akira-TL/skiloom`，并更新本地 `origin`。GitHub旧 URL redirect只作为迁移便利，不成为 protocol alias。

## 结果

- 正式 Spec 不再携带已知碰撞的 `AKM / akm` public identity；
- Project/package/repository metadata 只保留一套 `skiloom` namespace；
- 未发布草稿 digest可以被明确作废，而不是为不存在的兼容用户永久维护旧 magic；
- historical research/ADR background仍可保留旧名称用于说明历史，但 current normative examples和source-of-truth必须迁移；
- formal Spec 可以在完成 namespace migration后使用稳定的 public identifiers。

详细映射与迁移边界见 [`../design/skiloom-public-namespace.md`](../design/skiloom-public-namespace.md)。
