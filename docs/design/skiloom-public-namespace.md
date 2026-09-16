# Skiloom Public Namespace v0

状态：Partially Superseded

当前说明：`Skiloom / skiloom` 产品名、CLI/package token、`skiloom-package.toml`、`skiloom-repo.toml` 与 `SKILOOM-PACKAGE-V1` 继续有效；旧项目级 `.agents/.skiloom` 状态文件与 `Skiloom Core` 命名不再是当前产品权威。当前规则见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

对应历史 Issue：#14 `Choose a collision-free product and CLI name`

外部命名核查：[`../research/skiloom-name-collision-2026-09.md`](../research/skiloom-name-collision-2026-09.md)

本文件固定 Skiloom v0 在正式 Spec 中使用的公开产品、CLI 与协议/config namespace。它不开始 CLI/runtime 实现，只消除旧工作名 `AKM / akm` 对规范文本与未来实现的污染。

## 1. Canonical public identity

固定：

```text
Product / protocol family: Skiloom
Public lowercase token:    skiloom
CLI executable:            skiloom
GitHub repository target:  Akira-TL/skiloom
```

公开文档不再建立新的 `AKM`、`ASKM` 或其他 acronym。需要简称时直接使用 `Skiloom` / `skiloom`。

当前产品直接称 `Skiloom`，不再建立独立的 `Skiloom Core` 产品/兼容层名称。

## 2. Project namespace

项目中的 executor-visible Skill 位置保持外部生态约定：

```text
.agents/skills/<activation-name>
```

Skiloom 私有 project state 固定迁移到：

```text
.agents/.skiloom/
├── skiloom.toml
├── skiloom.lock
├── activation.lock
└── dependencies.lock
```

职责不因 rename 改变：

```text
skiloom.toml
= Project Intent + explicit activation renames

skiloom.lock
= Confirmed Resolution

activation.lock
= reference-manager machine-local activation ownership/materialization state

dependencies.lock
= Host Observation / reference-manager machine-local observations
```

Core conformance 仍只把 `skiloom.toml` / `skiloom.lock` 的 portable semantic roles纳入规范；machine-local sidecar 的物理格式是否属于 Core 继续按 ADR 0012 的边界处理。

## 3. Package / repository metadata filenames

Package Root optional Manifest：

```text
skiloom-package.toml
```

Repository root optional Discovery Control：

```text
skiloom-repo.toml
```

现有语义不变：

- `skiloom-package.toml` optional；合法 `SKILL.md` 仍是一等 Package；
- `skiloom-repo.toml` optional；只过滤 repository Package Root discovery；
- 两者都不建立第二套 Package name/version/source authority。

`DEPENDENCIES.md` 与 `SKILL.md` 不改名，因为它们的角色不是旧产品 namespace 的内部文件名。

## 4. Snapshot format domain tag

旧 working-draft identifier：

```text
AKM-PACKAGE-V1
```

在正式公开 Skiloom Core v0 前弃用。正式 Package Snapshot Format 1 identifier 固定为：

```text
SKILOOM-PACKAGE-V1
```

canonical stream header 固定：

```text
ASCII bytes: "SKILOOM-PACKAGE-V1\0"
```

除 domain tag bytes 外，已接受的 Snapshot boundary、entry ordering、path/file rules、framing 与 SHA-256 算法不改变。

### 4.1 为什么不保留旧 digest

项目当前仍处于 protocol design，尚无公开 Skiloom Core release、正式 conformance suite 或 runtime implementation需要读取已经发布的 `AKM-PACKAGE-V1` artifacts。因此这次 rename 是**pre-standard namespace correction**，不是 released protocol migration。

结果：

- `AKM-PACKAGE-V1` 与 `SKILOOM-PACKAGE-V1` 对同一 file tree 会产生不同 content digest；
- old working-draft digest / Lock 不具有 v0 compatibility guarantee；
- reference implementation v0 MUST NOT 同时写两种 magic；
- 正式 Core v0 只认 `SKILOOM-PACKAGE-V1`；
- 如果未来公开 release 后再改变 framing/domain tag，必须定义新的显式 format version 与 migration policy。

不使用 `SKILOOM-PACKAGE-V2`，因为旧 `AKM-PACKAGE-V1` 从未成为公开 Skiloom format 1；公开 Skiloom 的第一个 format generation就是 `SKILOOM-PACKAGE-V1`。

## 5. Schema / lock version numbers

品牌 rename 本身不改变 TOML data model，因此：

```text
Package Manifest schema = 1
Repository Discovery schema = 1
Project Manifest schema = 1
Project Lock lock-version = 1
activation/dependency local lock generations = existing reference generations
```

可以继续使用当前 generation number。Filename / namespace 变化不是同一 public namespace 内的 schema evolution，因为旧 namespace 从未正式发布。

## 6. Distribution/package identifiers

Reference implementation未来发布时：

```text
preferred distribution/package name = skiloom
preferred executable                = skiloom
preferred source/module token       = skiloom
```

Core protocol 仍不绑定任何实现语言或 package ecosystem；但 reference implementation 已由 ADR 0017 选择 Node.js + TypeScript，并以 npm package `skiloom` 作为主要发行入口。此前核查 exact `skiloom` npm 名称时未发现已存在 package；真正首次发布前仍必须再次核查并取得对应 namespace。

其他独立实现或未来额外 ecosystem distribution 可以使用 ecosystem-specific scoped/qualified package name，但 canonical executable 与 protocol/config namespace仍保持 `skiloom`，除非另有正式 namespace ADR。

## 7. GitHub repository rename policy

Canonical repository target：

```text
Akira-TL/skiloom
```

迁移顺序：

1. 接受本 namespace decision；
2. 原子迁移 active protocol/domain docs 的 `AKM / akm` namespace references；
3. 验证 repository 内没有 active source-of-truth 指向旧 config/digest namespace；
4. rename GitHub repository `Akira-TL/akira-skill-manager` -> `Akira-TL/skiloom`；
5. 更新当前 checkout `origin` 到新 canonical URL；
6. GitHub 提供的旧 repository redirect可以作为 transition convenience，但新文档/配置/链接不再依赖旧名称。

旧 GitHub repository 名称不作为 protocol alias，也不建立长期 mirror repository。

## 8. Historical documents

历史材料可以保留旧名以说明发生过什么，例如：

- naming collision research；
- ADR 中描述“早期 AKM working draft”的背景；
- competitor comparison中对旧仓库/旧命令的引用。

但以下 active source-of-truth 在 migration commit 后不得继续使用旧 public namespace：

```text
CONTEXT.md canonical terms
Accepted design contracts
current examples
current config paths / filenames
current Package Snapshot magic
future formal Spec / schemas / fixtures
```

因此 migration不是机械全局 `AKM -> Skiloom` 替换；必须区分 historical prose 与 active normative references。

## 9. No compatibility alias in v0

正式 v0 不定义：

```text
akm executable alias
.agents/.akm fallback
akm.toml / akm.lock dual-reader
akm-package.toml fallback
akm-repo.toml fallback
AKM-PACKAGE-V1 dual digest
```

原因是没有已发布用户基础需要兼容；现在保留 alias只会把已确认的命名碰撞永久带入 public protocol。

如果迁移本仓库内部的旧草稿/测试 fixture需要一次性 conversion script，那属于 repository migration tooling，不成为 v0 Core capability。

## 10. v0 public namespace summary

```text
Skiloom
CLI: skiloom
GitHub: Akira-TL/skiloom

Project:
  .agents/.skiloom/skiloom.toml
  .agents/.skiloom/skiloom.lock
  .agents/.skiloom/activation.lock
  .agents/.skiloom/dependencies.lock

Package:
  SKILL.md
  skiloom-package.toml      # optional
  DEPENDENCIES.md           # optional

Repository:
  skiloom-repo.toml         # optional

Snapshot format:
  SKILOOM-PACKAGE-V1
```
