# ADR 0006：Canonical Package Snapshot 与 Content Digest

- 状态：Accepted
- 日期：2026-09-14
- 当前说明：`SKILOOM-PACKAGE-V1`、snapshot 边界与 digest 规则继续有效；文中 `Lock` / `skiloom.lock` 仅是 pre-shift 持久化表述，现行 source provenance 与 Package identity 由 Machine Registry 的当前精确状态关联，并在显式导出时传播。

## 背景

Skiloom 的 Release source 与 Git source 都最终解析到 exact repository snapshot。Package Store 需要一个与 transport、临时 checkout 和宿主文件系统 metadata 无关的内容身份，使同一 Skill Package 从不同 source path materialize 时得到同一个 digest，并允许跨项目、跨来源复用 Store 内容。

同时 ADR 0004 已允许不同名称的 nested Skill Roots，因此必须明确祖先 Package snapshot 是否包含已经被 discovery 成独立 Package 的 nested Skill Root。

## 决定

### Snapshot 边界

一个 Package snapshot 以 selected Skill Root 为起点，并从其中裁掉所有已经进入最终 discovery set 的 nested Skill Roots。被 `skiloom-repo.toml` 排除的 nested `SKILL.md` 不属于独立 Package，因此仍作为祖先 Package 的普通内容保留。

### 文件与路径

v0 snapshot 只允许 regular files；symlink、hardlink、FIFO、device node、socket 和其他特殊文件全部拒绝。

每个路径必须是合法 UTF-8 relative path，协议 separator 为 `/`，不得包含 NUL、absolute path、`.` 或 `..` component。Unicode default case folding 后冲突的两个路径拒绝，以避免在 case-insensitive filesystem 上产生不可可靠 materialize 的 Package。

v0 不执行 Unicode normalization，也不重写文件内容。

### Content semantics

影响 Package content identity 的只有：

```text
relative path
executable bool
exact file bytes
```

时间戳、owner/group、inode、普通 read/write permission 差异以及 archive/checkout metadata 不参与 identity。

### Canonical digest

文件按 relative path 的原始 UTF-8 bytes 升序排序；目录 entry 不单独参与 digest。每个文件先计算 exact bytes 的 SHA-256。

Canonical stream 使用 `SKILOOM-PACKAGE-V1` 固定 framing：

```text
ASCII "SKILOOM-PACKAGE-V1\0"
uint64-be entry-count

for each sorted regular-file entry:
  0x01
  uint64-be path-byte-length
  path UTF-8 bytes
  0x00 | 0x01 executable
  uint64-be file-size
  32 raw SHA-256 bytes
```

最终：

```text
content-digest = SHA-256(canonical stream)
```

Lock 使用：

```text
sha256:<64 lowercase hex chars>
```

### Store identity

Package Store 直接使用 `content-digest` 作为 key。不同 repository、Release、commit 或 package-root，只要最终 canonical Package snapshot 完全相同，就复用同一个 Store entry。Source provenance 继续保存在 `skiloom.lock`，不进入 Store key。

## 结果

- Release archive/tar/zip bytes 不是 Package identity；
- Release source 与 Git source 对同一 Package 内容得到相同 digest；
- nested 独立 Skill 的变化不会污染祖先 Package digest；
- v0 Package snapshot 在受支持平台之间具有明确 portability 边界；
- Store 可以安全做 content-addressed 去重；
- symlink 支持、其他文件类型或 digest framing 变化必须通过新的 snapshot format version 引入，不能悄悄改变 `SKILOOM-PACKAGE-V1`。
