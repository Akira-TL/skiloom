# Catalog 集成契约 v0

状态：Accepted

对应 Issue：#25 `Define Catalog integration contract outside source authority`

对应调研：[`../research/catalog-source-traceability-2026-09.md`](../research/catalog-source-traceability-2026-09.md)

## 1. 定位

Skiloom v0 的 Catalog 只负责帮助用户发现和比较 Skill，不属于安装来源、版本来源、内容来源或安全授权来源。

固定数据流：

```text
Catalog Provider
  -> 搜索/浏览结果
  -> GitHub source nomination
  -> Skiloom 自己重新验证 GitHub source
  -> discovery / snapshot / digest / resolver
  -> 用户或策略接受
  -> Store / Target
```

Catalog 不可绕过 Skiloom 已接受的 `github-release` / `git` source pipeline。

## 2. v0 默认 Provider

v0 默认内建 discovery provider 为 **SkillsMP**。

原因是其结果直接提供具体 GitHub URL，最接近纯 GitHub discovery index；Skiloom 可以把它当作候选提名，而不消费它自己的安装 artifact。

v0 不默认自动聚合多个 Catalog。未来可以增加例如 skills.sh 的 provider，但必须继续遵守本契约，不得因为新增 provider 改变 Source / Resolver / Store 语义。

## 3. 统一 Catalog Candidate

Skiloom 内部统一候选最小语义为：

```text
provider
provider-entry-id
name
description?
display-url?
github-repository?       # canonicalizable owner/repo
github-package-path-hint?
signals[]
```

其中：

- `provider`：例如 `skillsmp`、未来的 `skills-sh`；
- `provider-entry-id`：只用于回到该 Catalog 的条目，不是 Package identity；
- `name` / `description`：搜索展示信息；
- `display-url`：Catalog 或原始页面链接；
- `github-repository`：只有在 provider 信息能明确归一成 GitHub `owner/repo` 时存在；
- `github-package-path-hint`：Catalog 给出的 Skill 子目录线索，只作为 discovery hint；
- `signals[]`：带 provider provenance 的热度、评分、安全扫描、语言、分类等展示信号。

Catalog 自己的 version、hash、snapshot、zip/download URL 不进入统一安装候选，也不进入 Machine Registry 的精确安装状态。

## 4. 从 Catalog 到 GitHub 来源提名

只有能够明确得到：

```text
GitHub owner/repo
+ optional Skill path hint
```

的 Catalog entry 才能进入 v0 安装候选。

Catalog URL 中的 branch/ref 不是 exact identity。Skiloom 必须重新按自己的 GitHub source 规则处理：

1. canonicalize GitHub repository coordinate；
2. 读取 GitHub source metadata；
3. 根据用户安装请求选择 `github-release` 或 `git`；
4. 解析 exact tag/commit；
5. 运行 Skiloom 自己的 repository discovery；
6. 用 path hint 帮助定位，但最终 Package Root 必须由 Skiloom 验证；
7. 计算 `SKILOOM-PACKAGE-V1` digest；
8. 进入正常 Resolver、来源确认和 Target 安装流程。

如果 Catalog entry 只有 Catalog slug/version/package，或 upstream 是 ClawHub、well-known、Registry artifact 等非 GitHub来源，v0 可以展示，但不能直接安装。

## 5. 展示信号

Catalog 可以提供：

- stars / installs / downloads；
- 分类、语言、更新时间；
- provider 自己的评分；
- 第三方安全扫描结果；
- duplicate / verified 等 provider 标记。

这些信号必须保留来源，例如：

```text
SkillsMP: GitHub stars 12.3k
skills.sh / Snyk: Low Risk
Tencent SkillHub: TRACE A
```

Skiloom 不把这些合并成“Skiloom 安全评分”，也不因为 favorable signal 跳过来源确认、内容摘要或解析验证。

Catalog signal 只能影响搜索/浏览排序和展示，不能影响：

- Resolver candidate ordering；
- version selection；
- source authorization；
- Package Content Digest；
- Exact Installation Resolution；
- export/import exact reproduction。

## 6. 去重与未来多 Provider

v0 不自动聚合多个 Catalog。

未来若同时启用多个 provider，去重不能依赖 Catalog slug、名称或描述。只有在条目已经归一到同一个 GitHub repository，并经 Skiloom discovery 确认为同一个 Package Root/Package identity 后，才可以在 UI 中合并为一个发现候选。

多个 provider 的信号仍分别保留 provenance，不合并成无来源的统一评分。

## 7. 失败与降级

Catalog 是可选发现层。

因此：

- Catalog timeout、认证失败、限流或 API schema 变化，只能使该 provider 的搜索暂时不可用；
- 一个 provider 不可用时，若未来配置了其他 provider，可以继续使用其他 provider；
- 明确 GitHub coordinate 的 install/update/sync/repair 完全不依赖 Catalog；
- Catalog 结果和缓存不进入 Exact Installation Resolution；
- Catalog 不可用不能破坏已有 Target 的日常管理。

SkillsMP 匿名/API key 配额差异属于 provider access policy，不改变上述产品语义。

## 8. Provider 边界

v0 Catalog Provider 只需要完成：

```text
search(query/filter)
  -> Catalog Candidate[]
```

以及把 provider 原始字段归一成第 3 节的候选模型。

Provider 不拥有：

- GitHub credentials 或 Source Adapter 的 source decision；
- Resolver；
- Store；
- Target；
- 来源接受；
- Catalog artifact 下载并安装；
- 本机精确状态写入。

v0 不建立 Catalog plugin marketplace 或第三方 provider SDK。未来增加 provider 时先作为 Skiloom 官方适配器实现；只有出现真实的外部扩展需求后再单独设计 SDK。

## 9. 一句话边界

```text
Catalog 帮用户找到 Skill；Skiloom 仍然只相信自己重新验证得到的来源与内容事实。
```
