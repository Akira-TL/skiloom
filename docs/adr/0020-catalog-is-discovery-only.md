# ADR 0020：Catalog 只作为发现层，默认使用 SkillsMP

- 状态：Accepted
- 日期：2026-09-16

## 背景

#24 调研确认，当前 Agent Skill Catalog 分成两类：一类主要索引 GitHub Skill，一类已经拥有自己的版本、下载包、签名或 Registry 坐标。如果 Skiloom 直接消费后者的 version/hash/zip，就会绕过现有 `github-release` / `git` 来源模型并偷偷引入新的来源权威。

Skiloom v0 需要 Catalog 帮用户搜索 Skill，但不需要让 Catalog 参与版本解析、内容身份或精确恢复。

## 决定

1. v0 默认内建 Catalog Provider 为 SkillsMP。
2. v0 不默认自动聚合多个 Catalog；未来可增加 provider，但必须遵守同一发现层边界。
3. Catalog entry 只有在能够明确归一成 GitHub `owner/repo`，并可选提供 Skill path hint 时，才能进入 v0 安装候选。
4. Catalog 提供的 branch/ref、version、hash、snapshot、zip/download 不成为 Skiloom exact identity、Package Content Digest 或安装内容来源。
5. Skiloom 必须重新访问 GitHub并运行自己的 source resolution、discovery、snapshot、digest、resolver 与来源确认流程。
6. 无 GitHub provenance 的条目可以展示，但 v0 不直接安装；未来若需要支持 Registry，应新增独立 source profile。
7. stars、installs、评分、安全扫描等都保留 provider provenance，只用于搜索/展示，不影响 Resolver、来源接受、内容身份或精确恢复。
8. Catalog 故障、限流、认证失败或 API 变化不能阻止已知 GitHub coordinate 的 install/update/sync/repair。
9. 多 provider 未来的去重只在归一到同一 GitHub repository，并经 Skiloom discovery 确认同一 Package identity 后发生；不按 Catalog slug/name 猜测。
10. v0 不建立第三方 Catalog Provider SDK 或 plugin marketplace。

完整契约见 [`../design/catalog-integration.md`](../design/catalog-integration.md)。

## 结果

Catalog 成为可替换的发现入口，而不是 Skiloom 的第三种来源。即使默认 SkillsMP 不可用，Skiloom 的 GitHub coordinate 安装、更新、同步、修复和精确导入/导出都不受影响。
