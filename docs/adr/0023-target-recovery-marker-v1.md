# ADR 0023：`.skiloom-state` v1 公开恢复格式

- 状态：Accepted
- 日期：2026-09-16

## 背景

Skiloom 已经确定：Machine Registry 是日常完整精确状态权威，Package Store 是不可变内容权威，Target filesystem 只是当前投影，而 `.skiloom-state` 只负责 Target Identity、Generation 与数据库丢失时的恢复线索。此前只定义了 Marker 的语义边界，没有固定公开文件格式。

如果 Marker 继续只停留在抽象描述，恢复、0.7.x 实现、导出/导入与 CLI doctor 都必须自行猜字段。反过来，如果 Marker 承载完整 transitive graph、exact source set 或 materialization 细节，它又会重新变成已经退役的项目 Lock。

## 决定

1. Target Recovery Marker 固定为 Target 根部 UTF-8 TOML 文件 `.skiloom-state`，v1 格式标识为 `SKILOOM-STATE-V1`。
2. v1 顶层保存 canonical lowercase UUID v4 `target-id` 与非负 `generation`。UUID 只作为 opaque random identity，不编码项目、仓库、主机或路径含义。
3. `[[requirements]]` 保存全部 Direct Install Requirements，同时支持 Package `<owner>/<repo>/<package>` 与 repository-wide `<owner>/<repo>`；`github-release` 保存可选 canonical `version`，`git` 保存必填 requested `ref`。
4. `[[projection-overrides]]` 只保存非默认 activation name。symlink/junction/copy 物理实现与 Dependency Routing Overlay 展开内容不持久化；恢复后由当前平台能力和重新解析出的依赖图确定性重建。
5. `[[detached]]` 保存 logical Package 与 detach 时 baseline provenance：source kind、exact commit、Package Root、Package Content Digest，以及 Release 的 version/tag 或 Git 的 requested ref。Marker 不保存、摘要或采纳 Detached Override 当前用户字节。
6. v1 明确不保存完整 transitive graph、exact transitive source/version、Store/cache/Target 绝对路径、Host preset/scope、Catalog 信号、来源授权历史、凭据、foreign/forgotten Skill 清单或 materialization choice。
7. v1 使用严格 schema：未知字段、重复条目、非法 coordinate/version/UUID/commit/digest、Release/Git 字段混用等返回 `InvalidTargetState`。未知 `format` 返回 `UnsupportedTargetStateVersion`；旧程序不得猜测解析或自动降级重写。
8. 官方 writer 生成 canonical stable TOML；数组按 canonical coordinate 稳定排序。`.skiloom-state` 是 machine-managed state file，不承诺保留用户注释、空白和原始顺序。
9. 写入顺序继续服从 DB-first：SQLite 先提交 generation N 成为权威，Target materialize/reconcile 后最后写 Marker generation N。Marker 落后数据库时只能 Machine Registry -> Target 单向 sync；Marker 超前数据库 fail closed。
10. Marker 缺失/损坏但 Registry 完整时，只有在 Target projection 可验证与当前 accepted state 完全一致后才允许修复 Marker。Registry 与 Marker 同时不可用时，不扫描 Target 猜 Package identity、Direct Install Requirements 或 managed ownership。
11. 数据库丢失时，合法 Marker 只用于重新解析 recovery candidate；完整 source set 重新确认。这不是 exact replay，也不承诺恢复到丢失数据库前相同的 transitive version/commit。

完整字段、校验和示例见 [`../design/target-recovery-marker-v1.md`](../design/target-recovery-marker-v1.md)。

## 结果

- `.skiloom-state` 成为真正可实现、可测试、可版本化的公开恢复格式；
- Marker 保持足够小，不重新承担 Machine Registry / Lock 的职责；
- repository-wide requirement、rename 与 Detached Override 可以在数据库丢失后保留用户意图和所有权边界；
- 未来无法向后兼容的新 Marker 语义必须通过新 `SKILOOM-STATE-V*` 版本显式演进，而不是让旧程序静默忽略字段。
