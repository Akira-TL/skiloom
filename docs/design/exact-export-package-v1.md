# Skiloom 精确导出包 v1

状态：Accepted

对应 Issue：#33 `Define exact export package v1 public format`

本文件定义 Skiloom v0 的公开单文件精确导出格式：`*.skiloom-export`、`SKILOOM-EXPORT-V1` container framing、`skiloom-export.toml` schema，以及用户所有内容的 `SKILOOM-USER-PAYLOAD-V1` 摘要域。

本格式只把 #21 已接受的导出/导入产品语义编码成稳定公开格式，不把导出物变成 Machine Registry、Target Recovery Marker 或历史状态数据库。

## 1. 目标与边界

精确导出包用于显式传播一个状态一致 Target 的可恢复 Skill 环境。

v1 有两种 mode：

- `dependencies`：封装当前全部 Skiloom-managed Package 的精确状态与实际 Package 内容；Detached Override 的用户修改字节和其他未受管 Skill 不进入 payload；
- `full`：在 `dependencies` 基础上，再封装 Detached Override 的当前用户字节，以及 Target 中其他可识别的未受管/manual Skill 当前内容。

两种 mode 都必须：

- 是单文件；
- 包含 `skiloom-export.toml`；
- 支持完全离线 import；
- 保留 managed Package 的 exact source provenance、Package Root、Package Content Digest 与 dependency edges；
- 不携带可复用旧 `target-id` / generation；
- 不携带原 Target、Store、Registry、cache、log 的机器本地物理路径；
- 不携带 credentials、authorization history 或 Catalog cache；
- 只允许从 reconciled / consistent Target 生成。

`.skiloom-state` 不作为 payload 嵌入，也不作为新 Target 的身份来源。

## 2. 文件名与 format identifier

推荐扩展名：

```text
*.skiloom-export
```

外层 container magic 固定为 ASCII bytes：

```text
SKILOOM-EXPORT-V1\0
```

对应 manifest 顶层字段：

```toml
format = "SKILOOM-EXPORT-V1"
mode = "dependencies" # 或 "full"
```

外层 magic 与 manifest `format` 必须同时匹配；任一不匹配都不能猜测解析。

## 3. Container framing

v1 是一个未压缩、顺序读取的二进制 framing。它不依赖 ZIP/TAR 的权限、时间戳、目录 entry 或平台 metadata 语义。

字节布局：

```text
header:
  magic:             exact ASCII "SKILOOM-EXPORT-V1\0"
  manifest-length:   uint64 little-endian
  manifest-bytes:    exact UTF-8 skiloom-export.toml bytes

then zero or more file frames until physical EOF:
  payload-id-length: uint64 little-endian
  payload-id-bytes:  exact UTF-8 bytes
  path-length:       uint64 little-endian
  path-bytes:        exact relative path UTF-8 bytes
  executable:        0x00 | 0x01
  file-size:         uint64 little-endian
  file-bytes:        exact file bytes
```

约束：

- `uint64 little-endian` 固定 8 bytes；v1 不允许 varint 或其他整数编码；
- manifest 后如果恰好到 EOF，表示没有 file frame；若只剩不足 8 bytes 的残片则为截断；
- frame 只表示 regular file，不表示 directory；目录由 path 自动推导；
- 一个 `(payload-id, relative-path)` 组合只能出现一次；
- 每个 manifest 声明的 payload 必须具有与其摘要对应的完整 frame 集；
- manifest 未声明的 payload/frame 属于非法额外内容；
- v1 不做 container-level compression；未来压缩若进入产品，必须通过新 container version 或明确兼容 framing 演进，不能改变 V1 解释。

实现可以设置资源上限以抵御恶意 length，但不能改变合法 V1 的 canonical encoding。

## 4. Payload ID

Payload ID 是 container 内部稳定引用，不使用随机数。

managed Package payload：

```text
package:<package-content-digest>
```

例如：

```text
package:sha256:0123...
```

user-owned payload：

```text
user:<user-payload-digest>
```

例如：

```text
user:sha256:abcd...
```

相同 Package Content Digest 在一个 export 中只封装一份 managed payload，可被多个 Package/provenance record 引用。user payload 同理按 `SKILOOM-USER-PAYLOAD-V1` digest 去重。

## 5. `skiloom-export.toml` 顶层

v1 顶层只有：

```toml
format = "SKILOOM-EXPORT-V1"
mode = "dependencies"
```

`mode` 只允许：

```text
dependencies
full
```

manifest 不包含创建时间、hostname、username、随机 export id 或本机绝对路径等非语义字段。

## 6. Direct Install Requirements

使用 `[[requirements]]`，与 `.skiloom-state` v1 的 Direct Install Requirement 语义一致。

Release Package requirement：

```toml
[[requirements]]
kind = "package"
coordinate = "owner/repo/package"
source = "github-release"
version = "^1.4.0" # 可省略
```

Release repository-wide requirement：

```toml
[[requirements]]
kind = "repository"
coordinate = "owner/repo"
source = "github-release"
```

Git requirement：

```toml
[[requirements]]
kind = "repository"
coordinate = "owner/repo"
source = "git"
ref = "main"
```

规则：

- `kind = "package"` 时 coordinate 必须是 Package Coordinate；
- `kind = "repository"` 时 coordinate 必须是 Repository Coordinate；
- `github-release` 只允许可选 `version`，禁止 `ref`；
- `git` 必须有非空 `ref`，禁止 `version`；
- requirement 保存用户原始持续约束，而不是 exact resolved commit。

## 7. Exact source records

每个参与当前精确图的 repository 有且只有一个 `[[sources]]` record。

GitHub Release：

```toml
[[sources]]
repository = "owner/repo"
kind = "github-release"
version = "1.4.2"
tag = "v1.4.2"
commit = "0123456789abcdef0123456789abcdef01234567"
immutable = true # 可省略；只有当导出时存在该观测时记录
```

Git：

```toml
[[sources]]
repository = "owner/repo"
kind = "git"
commit = "0123456789abcdef0123456789abcdef01234567"
```

规则：

- repository 使用 canonical lowercase owner/repo；
- `github-release` 的 `version` 是 normalized SemVer，`tag` 是 actual tag，`commit` 是 exact commit；
- `git` 只记录 exact commit；用户请求 ref 已在 Direct Install Requirement 中；
- `immutable` 是可选 advisory provenance signal，存在时为 boolean，不参与内容身份；
- source record 用于 offline import 后重新展示/确认完整来源集合，不能授权自己。

## 8. Managed Package records

每个当前 Skiloom-managed exact Package 使用 `[[packages]]`：

```toml
[[packages]]
coordinate = "owner/repo/package"
package-root = "skills/package"
content-digest = "sha256:..."
payload = "package:sha256:..."
```

规则：

- `coordinate` 唯一；
- repository provenance 由 coordinate 的 owner/repo 对应 `[[sources]]`；
- `package-root` 是 exact repository-relative Package Root；
- `content-digest` 必须是 `SKILOOM-PACKAGE-V1` digest；
- `payload` 必须精确等于 `package:<content-digest>`；
- import 必须从 payload frames 重建 Package Snapshot，并重新计算 `SKILOOM-PACKAGE-V1`；结果必须等于 `content-digest`。

Container 自己不定义第二套 managed content identity。

## 9. Dependency edges

完整 exact graph 使用 `[[dependencies]]`：

```toml
[[dependencies]]
from = "owner/repo/package-a"
to = "other/repo/package-b"
```

规则：

- `from` / `to` 都必须引用 `[[packages]]` 中存在的 Package Coordinate；
- 相同 edge 不得重复；
- import 不重新解析这些 exact dependency edges 来选择其他版本；
- manifest 中 exact graph 与 payload 是恢复目标。

## 10. Projection records

当前 managed graph 的投影名使用 `[[projections]]`：

```toml
[[projections]]
package = "owner/repo/package"
activation-name = "custom-name"
```

v1 writer 为每个 `[[packages]]` 写一个 projection record，包括默认 activation name；这样 import 不需要从当前宿主或 Package name 猜测导出时的实际 projection mapping。

规则：

- `package` 必须唯一且引用现有 `[[packages]]`；
- `activation-name` 必须符合当前 Skill/Target 命名要求；
- 同一 Target 的 activation name 不得冲突；
- symlink/junction/copy 等物理 materialization strategy 不进入 export；
- Dependency Routing Overlay 不进入 export；它由 exact dependency edges + projection names 确定性重建；
- managed transformed copy 的生成后字节不额外封装。

## 11. `dependencies` mode 与 Detached Override

`mode = "dependencies"` 只恢复 managed dependency environment。

如果源 Target 存在 Detached Override：

- exact baseline managed Package 仍作为普通 `[[packages]]` + managed payload 封装；
- Detached Override 当前用户修改字节不封装；
- `[[detached]]` 不写入 dependencies export；
- exporter 必须向用户产生可见提示，说明这些 user-owned bytes 未进入产物；
- import 后该 Package 恢复为普通 managed projection。

这不是丢失 exact managed dependency state；它是 `dependencies` 与 `full` mode 的明确所有权边界。

## 12. `SKILOOM-USER-PAYLOAD-V1`

`full` mode 中 Detached Override 当前字节和其他 user-owned/unmanaged Skill 使用独立 digest domain：

```text
SKILOOM-USER-PAYLOAD-V1
```

合法 user payload 是一个 portable regular-file tree。目录本身不参与 digest；只由文件相对路径推导。

每个文件先计算：

```text
file-digest = SHA-256(exact file bytes)
file-size   = exact byte length
```

文件按 relative path raw UTF-8 bytes 升序排序。Canonical digest stream：

```text
header:
  ASCII bytes: "SKILOOM-USER-PAYLOAD-V1\0"
  entry-count: uint64 big-endian

for each file entry:
  entry-kind:   0x01
  path-length:  uint64 big-endian
  path-bytes:   exact relative path UTF-8 bytes
  executable:   0x00 | 0x01
  file-size:    uint64 big-endian
  file-digest:  32 raw SHA-256 bytes
```

最终：

```text
user-payload-digest = SHA-256(canonical stream)
```

文本形式：

```text
sha256:<64 lowercase hex>
```

`SKILOOM-USER-PAYLOAD-V1` 与 `SKILOOM-PACKAGE-V1` 使用不同 domain header；即使两棵树碰巧相同，也不能把 user payload digest 当 Package Content Digest。

user-owned local tree 的 executable flag：

- 在具有 POSIX executable mode 的文件系统上，只要任一 executable bit 被观察为设置，就记为 `true`；否则为 `false`；
- 在不提供 POSIX executable mode 语义的平台上，v1 exporter 记为 `false`；
- import 到支持 executable mode 的平台时，对记录为 `true` 的文件恢复 executable 语义；普通 rw 权限、mtime、owner/group 不传播。

## 13. User-owned payload path admission

managed Package payload 继续服从 `SKILOOM-PACKAGE-V1` Package Snapshot path/file-type 规则。

user payload 也必须满足 portable tree 边界：

- UTF-8 relative path；
- `/` 作为逻辑分隔符；
- 禁止绝对路径、空 component、`.`、`..`；
- 禁止 NUL 和既定不可移植路径；
- 禁止 Unicode casefold collision；
- 只允许 regular files 和由路径推导的 directories；
- symlink、junction/reparse link、device、FIFO/pipe、socket 等特殊 entry 直接使该 full export 失败；
- exporter 不跟随特殊 entry，也不静默忽略。

这样 import 的任何 frame 都不能逃出它所属的 payload root。

## 14. Detached Override records（full only）

`mode = "full"` 时，每个 Detached Override 使用 `[[detached]]`：

```toml
[[detached]]
package = "owner/repo/package"
activation-name = "package"
payload = "user:sha256:..."
content-digest = "sha256:..."
baseline-source = "github-release"
baseline-version = "1.2.0"
baseline-tag = "v1.2.0"
baseline-commit = "0123456789abcdef0123456789abcdef01234567"
baseline-package-root = "skills/package"
baseline-content-digest = "sha256:..."
```

Git baseline 不写 `baseline-version` / `baseline-tag`。

规则：

- `package` 引用 logical managed Package slot；
- `activation-name` 是该 user-owned override 在源 Target 的投影名；
- `content-digest` 是当前用户字节的 `SKILOOM-USER-PAYLOAD-V1` digest；
- `payload` 必须等于 `user:<content-digest>`；
- baseline provenance 只说明 detach 当时来自哪个 exact managed Package，不证明当前用户内容仍等于 baseline；
- import 后 logical Package binding 继续存在，但 payload bytes 仍归用户所有，Skiloom 不获得自动 overwrite/merge/delete 权限。

## 15. 其他未受管 Skill records（full only）

Target 中其他可识别、未受 Skiloom 管理的 Skill 使用 `[[user-skills]]`：

```toml
[[user-skills]]
activation-name = "local-skill"
skill-name = "local-skill"
payload = "user:sha256:..."
content-digest = "sha256:..."
```

规则：

- `content-digest` 是 `SKILOOM-USER-PAYLOAD-V1` digest；
- `payload` 必须等于 `user:<content-digest>`；
- import 后仍为 foreign/user-owned Skill，不自动转成 managed Package；
- 若该 Skill 自己声明某个当前不存在的依赖，export 只产生可见 warning，不联网下载、不补齐、不把声明提升成 resolver constraint。

## 16. Manifest 禁止内容

`skiloom-export.toml` 不得包含或恢复：

- 原 Target 的绝对路径；
- 旧 `target-id`；
- 旧 Target Generation；
- `.skiloom-state` 原文件内容；
- `~/.skiloom/store` / Registry / cache / log 的物理路径；
- `operation.lock`；
- credentials、tokens、credential identifiers；
- Catalog cache / provider session；
- hostname、username、created-at、random export id。

来源 provenance、exact Package identity、dependency graph 与投影语义可以传播；机器身份不能传播。

## 17. 严格解析与错误

v1 manifest 是严格 schema。以下至少都属于 `InvalidExportPackage`：

- 外层 magic 与 manifest `format` 不一致；
- 未知字段；
- 非法 `mode`；
- duplicate requirement/source/package/dependency/projection/detached/user-skill；
- 非法 coordinate、SemVer、commit、digest、Package Root 或 activation name；
- source kind 与字段组合不合法；
- dependency 引用不存在 Package；
- projection 引用不存在 Package或 activation name 冲突；
- payload ID 不符合其 digest domain；
- manifest 声明 payload 但缺少 frame；
- frame 引用未声明 payload；
- `(payload-id, path)` 重复；
- 非法/越界 relative path；
- symlink/special entry 被 exporter 检出；
- frame 截断、length 越界或 EOF 不完整；
- managed Package 重算 `SKILOOM-PACKAGE-V1` 不匹配；
- user-owned tree 重算 `SKILOOM-USER-PAYLOAD-V1` 不匹配；
- `dependencies` mode 出现 `[[detached]]` 或 `[[user-skills]]`。

如果外层 magic 或 manifest 声明的是一个可识别但当前不支持的新 `SKILOOM-EXPORT-V*`，返回：

```text
UnsupportedExportVersion
```

当前程序不得把未知未来版本猜成 V1，也不得自动降写为 V1。

## 18. Canonical writer

官方 V1 writer 必须产生稳定字节，不能依赖 Map/SQLite iteration order。

manifest：

- UTF-8，无 BOM；
- LF 换行；
- 不写 comments；
- 顶层先写 `format`，再写 `mode`；
- array-of-tables 顺序固定为：`requirements`、`sources`、`packages`、`dependencies`、`projections`、`detached`、`user-skills`；
- `requirements` 按 `kind`、`coordinate`、`source`、`version/ref` 的 UTF-8 byte sequence 稳定排序；
- `sources` 按 `repository`；
- `packages` 按 `coordinate`；
- `dependencies` 按 `from` 后 `to`；
- `projections` 按 `package`；
- `detached` 按 `package`；
- `user-skills` 按 `activation-name` 后 `skill-name`；
- table 内字段按本规范示例中的字段顺序输出；
- TOML string 使用确定性的 basic-string escaping，不保留输入文件的 comments/formatting。

file frames：

```text
payload-id raw UTF-8 ascending
→ relative-path raw UTF-8 ascending
```

同一逻辑环境、同一 export mode、同样 payload bytes 必须得到相同的官方 V1 输出字节。用户可额外对整个 `.skiloom-export` 文件计算普通 SHA-256 作为外部文件指纹，但该外部 hash 不是 Skiloom Package identity。

## 19. Import 语义

Import 顺序必须保持 #21 的产品边界：

1. 解析并严格校验 container + manifest；
2. 验证全部 managed/user payload digest；
3. 展示完整 recorded source set；import file 本身不是来源授权；
4. 用户或显式 non-interactive policy 接受来源；
5. 用户选择目标 Target；
6. 新导入环境创建新的 `target-id`，不继承 export 来源机器身份；
7. 空 Target 精确恢复 managed graph/projection；full mode 另外恢复 detached/user-owned payload ownership；
8. 合并导入到已有 Target 时先明确提醒；同名或同路径冲突 fail closed，不自动覆盖或改名；
9. 远端不可访问不阻止已验证的离线 import；若联网观察到 Release retarget，只警告，不替换包内 exact payload。

Import 不重新解析 version 选择，不用当前远端最新版本代替 manifest 中记录结果。

## 20. 与其他状态层的关系

```text
registry.sqlite3
= 当前机器日常 accepted exact state authority

.skiloom-state
= Target Identity + recovery hints

*.skiloom-export
= 用户显式生成的可传播 exact environment
```

Export 不是 Registry backup，也不是 Marker copy；三者生命周期和权限边界保持独立。
