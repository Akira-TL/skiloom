# Agent Skill Catalog 来源追踪与可用性调研（2026-09）

状态：Research Complete

对应 Issue：#24 `Research SkillHub catalogs and source traceability`

本调研记录截至 2026-09-16 可确认的 Agent Skill Catalog / Marketplace 能力，回答三个问题：

1. 哪些平台适合给 Skiloom 做搜索、排序和展示；
2. Catalog entry 能否稳定映射回 Skiloom 当前可验证的 GitHub source candidate；
3. 哪些平台已经拥有自己的版本、下载包或签名，因此一旦直接安装就会成为新的来源权威。

本调研不决定 Skiloom v0 默认接入哪个 Catalog，也不改变当前 `github-release` / `git` 两种来源模型。

## 1. Skiloom 当前判断基线

Skiloom 当前来源权威仍然是 GitHub repository source：

```text
Catalog
  -> 只能帮助发现候选
  -> 必须归一成 GitHub owner/repo[/package hint]
  -> Skiloom 自己重新读取 GitHub source metadata
  -> 解析 exact tag / commit
  -> 运行自己的 discovery / snapshot / digest / resolver
```

因此 Catalog 自己提供的：

- 安装量；
- stars；
- 分类；
- AI 评分；
- 安全扫描；
- Catalog 自己的 hash；
- Catalog 自己的 version/tag；
- Catalog 自己生成或托管的 zip；

都可以成为**发现和展示信号**，但不能自动替代 Skiloom 的 GitHub source provenance、Package Content Digest 或依赖解析。

如果一个 Catalog 只能给出自己的 registry slug/version/package，而不能可靠回到 GitHub repository source，那么直接从它安装就不是“Catalog 集成”，而是新增一种 Registry source profile。

## 2. SkillsMP

网站：

- https://skillsmp.com/
- https://skillsmp.com/docs/api

### 2.1 定位

SkillsMP 明确把自己描述为公开 GitHub `SKILL.md` 的索引。首页同时明确：SkillsMP 不认证这些 Skill 的质量或安全，也不直接替用户安装，建议打开 GitHub source 检查。

这是目前调研对象里与 Skiloom“Catalog 只做发现”边界最吻合的一类。

### 2.2 API 与限流

REST 搜索接口：

```text
GET /api/v1/skills/search
```

当前文档公开的过滤能力包括：

- keyword；
- category；
- occupation；
- detected content language；
- stars / recent 排序。

限流：

- 匿名：50 requests/day，10 requests/min；
- API key：500 requests/day，30 requests/min。

### 2.3 实际返回字段抽样

2026-09-16 对公开 API 做匿名抽样，结果包含：

```text
id
name
author
description
contentLanguage
githubUrl
skillUrl
stars
updatedAt
```

其中 `githubUrl` 直接指向类似：

```text
https://github.com/<owner>/<repo>/tree/<ref>/<skill-subdir>
```

这比只给 repository URL 更适合 Skiloom，因为它同时提供 repo 与 Skill 子目录线索。

### 2.4 来源追踪结论

SkillsMP entry 可以作为很好的 GitHub source candidate **提名**：

1. 从 `githubUrl` 提取 owner/repo 与路径 hint；
2. 不信任 URL 中的 mutable branch/ref 作为 exact identity；
3. Skiloom 仍按自己的 `github-release` / `git` 规则重新获取 candidate；
4. Skill 路径只作为 discovery hint，最终 Package Root 仍由 Skiloom discovery 校验。

`stars`、语言、分类和 SkillsMP 内部 id 都只作为 Catalog 展示元数据。

### 2.5 适配评价

**很适合 v0 discovery provider。**

主要限制是匿名 API 日配额较低，产品化接入需要 API key、缓存或其他调用策略。

## 3. skills.sh

网站：

- https://skills.sh/
- https://skills.sh/docs
- https://skills.sh/docs/api

### 3.1 定位

skills.sh 是 Vercel Labs `skills` CLI 对应的发现目录和 leaderboard。它以 CLI 安装遥测形成安装量/热度排名，同时提供安全审计聚合。

其 API Skill 基础字段包括：

```text
id
slug
name
source
installs
sourceType
installUrl
url
isDuplicate
```

其中 GitHub entry 通常表现为：

```text
sourceType = "github"
source = "owner/repo"
installUrl = "https://github.com/owner/repo"
```

同时还支持：

```text
sourceType = "well-known"
```

这已经超出 Skiloom 当前 GitHub-only source profile。

### 3.2 API 与认证

当前 API 文档列出：

```text
GET /api/v1/skills
GET /api/v1/skills/search
GET /api/v1/skills/curated
GET /api/v1/skills/{source}/{skill}
GET /api/v1/skills/audit/{source}/{skill}
```

文档当前要求大部分 API 通过 Vercel OIDC token 认证，并给出 authenticated 600 requests/min 的配额。安全 audit endpoint 的实际公开程度与第三方实测资料存在版本差异，因此 Skiloom 不应把“匿名必定可用”写死在产品契约里，应以接入时实测和官方最新文档为准。

### 3.3 Catalog 自己的内容与 hash

Skill detail API 可以返回：

```text
hash
files[]
```

`hash` 被文档定义为用于缓存/变化检测的 Skill 文件内容 SHA-256；`files` 是 skills.sh 保存的内容 snapshot。

这些数据**不能替代** Skiloom 的 `SKILOOM-PACKAGE-V1` Package Content Digest，也不应让 Skiloom从 skills.sh snapshot 直接安装，因为那会把 Catalog snapshot 变成内容来源。

### 3.4 安全信号

skills.sh 可以聚合多家 audit provider，例如：

- Gen Agent Trust Hub；
- Socket；
- Snyk；
- Runlayer；
- ZeroLeaks。

返回状态、摘要、扫描时间和可选 risk level。

这些很适合展示为 advisory security signals，但 skills.sh 自己也明确声明不能保证每个 Skill 的质量或安全。

### 3.5 来源追踪结论

对：

```text
sourceType = github
```

的 entry，Skiloom 可以把 `source = owner/repo` 与 skill slug/name 当发现线索，然后重新到 GitHub 做自己的 source/discovery/resolution。

对：

```text
sourceType = well-known
```

的 entry，v0 不能直接安装；需要未来新的 source profile 才能成为安装来源。

### 3.6 适配评价

**很适合 discovery + popularity/security metadata provider，但接入认证比 SkillsMP 重。**

必须明确忽略其 snapshot hash / files 作为 Skiloom content authority。

## 4. SkillHub.club

网站：

- https://www.skillhub.club/
- https://www.skillhub.club/docs/api
- https://www.skillhub.club/evaluation-methodology

### 4.1 定位

SkillHub.club 同时做：

- 语义搜索；
- 分类和推荐；
- AI 质量评分；
- security status；
- CLI 安装；
- Skill 发布和版本管理；
- “artifact-bound security review” 后的安装产物。

首页写明内容来源于 GitHub，但它已经不只是一个纯索引站。

### 4.2 API 与认证

Skills API 当前要求 API key：

```text
Authorization: Bearer <key>
```

公开文档列出：

```text
POST /api/v1/skills/search
GET  /api/v1/skills/catalog
```

搜索支持 hybrid / embedding / fulltext；Catalog 可按 score / stars / recent / composite 排序。

文档当前给出的限制为：

- standard key：60 requests/min；
- IP：100 requests/min。

未带 key 对 Catalog API 的实际请求返回 401。

### 4.3 评分含义

SkillHub.club 的评价方法明确说明：AI review 输入主要是 skill name、author、repository URL 和收集到的 `SKILL.md` 文本；不会因为给了 repository URL 就自动检查完整 repository。

评分维度包括 clarity、practicality、output quality、maintainability、innovation、security。官方同时明确：

- 评分不是 runtime test；
- 总分不是实际成功率；
- security review 与独立 security scan 是两种不同证据；
- 缺失/unknown security status 表示没有证据；
- favorable status 也不是未来版本安全保证。

因此这些只能作为 Catalog advisory metadata。

### 4.4 来源权威风险

SkillHub.club 允许发布、管理版本，并通过自己的 CLI 以 SkillHub slug 安装经过平台审核的 artifact。只要 Skiloom开始直接消费它的：

```text
SkillHub slug
SkillHub version
SkillHub reviewed artifact
```

就已经把 SkillHub.club 变成独立的版本/内容来源。

因此 v0 只有在某个 entry **明确提供并能解析成 GitHub source candidate** 时才可以把它用于 Skiloom 安装流程；否则只能展示、搜索、比较，不能“一键安装”。

### 4.5 适配评价

**适合高级 discovery / quality / security 信号，但不能把它的安装 artifact 当作当前 Skiloom source。**

API key 也是默认公共搜索体验需要考虑的接入成本。

## 5. 腾讯 SkillHub（skillhub.cn）

资料：

- https://github.com/Tencent/skillhub
- https://github.com/Tencent/skillhub/blob/main/docs/README.md
- API base：`https://api.skillhub.cn`

### 5.1 定位

腾讯 SkillHub 不只是 GitHub 索引，它明确支持：

- 全球 Skill 同步；
- 本土创作者/企业直接发布；
- 自己的版本历史；
- 文件读取和版本 diff；
- zip 下载；
- TRACE 质量评测；
- 内容签名和验签；
- 私有/组织 Skill；
- sandbox/runtime。

这是一套完整 Registry / distribution authority。

### 5.2 API 可用性

公开 API 文档允许匿名读取公开 Skill，典型入口：

```text
GET /api/skills
GET /api/v1/skills/{slug}
GET /api/v1/skills/{slug}/versions
GET /api/v1/skills/{slug}/files
GET /api/v1/download?slug=...
```

文档没有给一个简单的公共固定 QPS 保证；大规模、高并发、批量同步或正式商业接入建议提前联系平台确认配额和稳定性。

### 5.3 实际返回字段抽样

2026-09-16 对公开搜索 API 抽样，entry 可包含：

```text
slug
name
namespace
version
source
upstream_url
upstream_owner_login
downloads
installs
stars
score
verified
...
```

抽样结果中真实出现：

```text
source = "clawhub"
upstream_url = "https://clawhub.ai/<owner>/<skill>"
```

也就是说，“有 upstream”不等于“能回到 GitHub”。

### 5.4 来源权威结论

腾讯 SkillHub 自己维护 version、下载包、签名和发布状态。直接使用：

```text
slug + version + SkillHub zip/signature
```

安装，属于新的 Registry source model，不是现有 GitHub source 的透明 Catalog。

只有当某个 entry 的 upstream 信息能明确归一成：

```text
GitHub owner/repo[/skill path]
```

时，Skiloom 才能把它当作 Catalog nomination，随后重新回 GitHub验证。

对于 `clawhub`、本土上传、企业发布等非 GitHub upstream，v0 不能直接安装。

### 5.5 适配评价

**Catalog 能力很丰富，但天然更接近未来 Registry provider，而不是 v0 最简单的 discovery-only provider。**

它的评分、下载量、verified/signature 等仍可作为展示信号；不能替代 Skiloom 当前 GitHub provenance。

## 6. 其他 SkillHub / Registry 实现

调研还发现 iFlytek/Astron SkillHub 等自托管 Registry。其特点类似：

- namespace/slug 自有坐标；
- Registry 自有 SemVer/version/tags；
- Registry 自己存 package/download；
- 支持 private namespace、RBAC、签名、审核；
- 兼容 ClawHub 或提供自己的 CLI。

这类产品对未来“企业私有 Skill Registry source profile”很有参考价值，但不应该被 Skiloom v0 伪装成普通 Catalog。若以后支持，应明确新增 Registry source，而不是把 Registry package偷偷映射为 GitHub Package。

来源示例：

- https://github.com/iflytek/skillhub

## 7. 横向比较

| Catalog | GitHub 回链 | 自有版本/包 | 质量/安全信号 | API 接入成本 | 对 Skiloom v0 的安全用法 |
| --- | --- | --- | --- | --- | --- |
| SkillsMP | 强；直接 `githubUrl` 到 repo/path | 否，主要索引 | stars、分类、语言；明确不认证安全 | 低；匿名可用但日配额低 | **发现候选后回 GitHub验证** |
| skills.sh | GitHub entry 有 `source=owner/repo` / `installUrl`；另有 well-known | 有自己的内容 snapshot/hash，但目录定位仍可回 GitHub | installs、duplicate、第三方 audits | 中；大部分 API 当前要求 Vercel OIDC | **只对 `sourceType=github` 回 GitHub验证；忽略 snapshot hash 作为 identity** |
| SkillHub.club | 页面声明内容来自 GitHub，但 API 文档未把 GitHub provenance 作为稳定搜索字段契约 | 是；发布、版本、reviewed artifact | AI score、security status、排名 | 中高；Skills API 要 key | **只有能解析出 GitHub source 的 entry 可进入安装候选；否则只展示** |
| 腾讯 SkillHub | 有 upstream 字段，但 upstream 可能是 ClawHub 等非 GitHub | **是，完整 Registry** | TRACE、verified、签名、下载/安装/评分 | 中；公开读取方便，大规模需沟通 | **GitHub upstream entry 可提名；其余需要未来 Registry source profile** |

## 8. Skiloom 后续设计必须保持的边界

#25 可以直接基于这些事实决定 Catalog integration，但至少不能违反以下事实边界：

1. **Catalog metadata != source authority。** 排名、评分、安全扫描、安装量都不能自动授权一个来源。
2. **Catalog hash != Package Content Digest。** 外部目录的内容 hash 不能替代 `SKILOOM-PACKAGE-V1`。
3. **Catalog version != GitHub Release version。** Registry 自己的 `1.2.0` 不能自动解释为 GitHub Release `1.2.0`。
4. **Catalog download != current v0 install source。** 直接下载 SkillsMP/skills.sh/SkillHub 的 snapshot/zip 会引入新的内容来源。
5. **只有可验证 GitHub provenance 的 entry 才能无新增 source profile 地进入 v0 安装流程。**
6. **安全/质量信号应该保留 provider provenance。** UI 可以显示“SkillsMP stars”“skills.sh/Snyk audit”“SkillHub TRACE”，不能混成 Skiloom 自己认证的统一真值。
7. **同一 Skill 可能被多个 Catalog 重复索引。** 去重应优先以归一后的 GitHub repository + Skiloom discovery 后的 Package identity 处理，而不是 Catalog slug。
8. **Catalog 不可用不应阻止已知 GitHub coordinate 的正常安装、更新、同步或修复。** Catalog 只能是发现层。

## 9. #25 可以直接决定的事项

基于本调研，#25 不需要再研究各平台基础能力，只需决定：

- v0 首批内建哪一个或哪几个 discovery provider；
- Catalog 统一结果最小字段；
- `githubUrl` / `source=owner/repo` 等如何转成 Skiloom source nomination；
- quality/security signal 如何带 provider provenance 展示；
- API key / quota / unavailable 时的降级；
- 是否允许多个 Catalog 聚合和去重；
- 如何明确阻止 Catalog snapshot/version/download 穿透成 source authority。
