# ADR 0024: Exact Export Package v1

状态：Accepted

对应 Issue：#33 `Define exact export package v1 public format`

## 背景

#21 已经确定 Skiloom 的精确导出/导入产品语义：依赖导出与完整导出、managed Package 实际内容、Detached Override/user-owned 内容的所有权边界、完全离线 import、来源重新确认、新 Target Identity、合并导入冲突规则，以及禁止传播机器本地身份。

剩余问题是把这些语义编码成稳定、可测试、可长期演进的公开单文件格式，而不是让实现阶段随意选择 ZIP/TAR、临时 JSON 或另一份 Machine Registry dump。

## 决定

1. **v1 单文件扩展名为 `*.skiloom-export`，外层 format identifier 为 `SKILOOM-EXPORT-V1`。** 文件以 ASCII `SKILOOM-EXPORT-V1\0` magic 开始。
2. **v1 使用自定义未压缩顺序 framing。** header 后写 `uint64 little-endian` manifest length + UTF-8 `skiloom-export.toml`，随后到 EOF 为 regular-file frames；frame 显式编码 payload id、relative path、executable flag、file size 与 exact bytes。v1 不依赖 ZIP/TAR metadata 语义，也不定义 compression。
3. **`skiloom-export.toml` 是严格 TOML schema。** 顶层 `format` 与 `mode` 必填，`mode` 只允许 `dependencies` / `full`。manifest 关系化保存 Direct Install Requirements、exact source records、managed Package records、dependency edges、projection mapping，以及 full mode 才有的 Detached Override / user-owned Skill records。
4. **managed Package 内容身份仍只有 `SKILOOM-PACKAGE-V1`。** export container 不发明第二种 managed digest。managed payload id 固定为 `package:<content-digest>`，相同 Package Content Digest 在一个 export 中只封装一份 payload。
5. **user-owned 内容使用独立 `SKILOOM-USER-PAYLOAD-V1` 摘要域。** 它采用 portable regular-file tree、raw UTF-8 path order、executable bool、file size 与 file SHA-256 的 canonical stream，但 header 固定为 `SKILOOM-USER-PAYLOAD-V1\0`，不得与 Package Content Digest 混用。user payload id 固定为 `user:<digest>`。
6. **`dependencies` mode 不封装 Detached Override 当前用户字节。** 它封装其 logical baseline managed Package；import 后恢复普通 managed projection，并对被省略的 user-owned override 产生可见提示。
7. **`full` mode 额外封装 Detached Override 当前字节和其他可识别未受管 Skill。** 这些内容 import 后继续 user-owned/foreign；Skiloom 不因此取得 overwrite/merge/delete 权限。
8. **projection 记录逻辑 activation name，不记录物理 materialization。** symlink/junction/copy 不传播；Dependency Routing Overlay 不单独封装，由 exact dependency edges + projection names 确定性重建；managed transformed copy 的生成字节也不额外封装。
9. **Export 不传播机器身份。** 禁止旧 `target-id` / generation、原 Target 绝对路径、Store/Registry/cache/log 路径、`.skiloom-state` 原文件、credentials、operation lock、Catalog session 等机器本地状态。
10. **V1 fail closed。** 未知字段、非法组合、重复记录、非法路径、未声明 frame、缺失 payload、摘要不匹配、截断 framing 等返回 `InvalidExportPackage`；未来可识别但不支持的版本返回 `UnsupportedExportVersion`。
11. **官方 writer 必须 deterministic。** TOML field/table order、UTF-8/LF serialization、array sorting 与 payload frame ordering固定；不写 timestamp/hostname/random export id。相同逻辑环境、mode 和 payload bytes 产生相同 V1 字节。
12. **Import 先验证，再授权，再应用。** 完整 payload digest 验证通过后，recorded source set 仍必须重新进入用户或显式 policy acceptance；远端不可访问不阻止离线 import，远端漂移也不能替换 export 内 exact bytes。

完整 byte framing、manifest schema、排序规则和示例见 [`../design/exact-export-package-v1.md`](../design/exact-export-package-v1.md)。

## 结果

- v0 精确导出成为真正公开、可实现、可 fixture 测试的单文件协议；
- managed Package identity、user-owned payload identity、Machine Registry authority 与 Target Recovery Marker 保持四条清晰边界；
- import 不需要依赖远端 GitHub，也不需要把 archive metadata 当产品语义；
- 未来 compression 或新 payload capability 可以通过新 export version 演进，而不改变 `SKILOOM-EXPORT-V1` 的解释。
