# Package Snapshot 与 Content Digest

状态：Accepted

当前说明：本文件的 Package Snapshot / `SKILOOM-PACKAGE-V1` / Store identity 细节继续是当前技术规范；pre-shift 的 `skiloom.lock` 持久化表述已被 Machine Registry 当前精确状态取代。

对应 Wayfinder：#13 `Define canonical Package content digest`

## 1. 目标

Skiloom 需要把一个已经 discovery 并选中的 Skill Root 转换成跨 source、跨机器可复现的 immutable Package snapshot。

同一 exact repository snapshot 中的同一 Package，无论来源是：

```text
GitHub Release -> exact commit
Git source     -> exact commit
```

只要最终 Package 内容语义相同，就必须得到相同 `content-digest`。

因此 digest 针对 **Package snapshot 内容**，不是 GitHub source archive、tar/zip 编码、临时 checkout、文件系统 inode 或本机 metadata。

## 2. Package Snapshot 边界

一个 Package snapshot 从 selected Package Root 开始。

假设 discovery 后存在：

```text
skills/foo/SKILL.md                 name: foo
skills/foo/scripts/run.sh
skills/foo/examples/bar/SKILL.md    name: bar
skills/foo/examples/bar/helper.py
```

且 `foo`、`bar` 都属于最终 discovery set，则：

```text
foo snapshot
├── SKILL.md
└── scripts/run.sh

bar snapshot
├── SKILL.md
└── helper.py
```

也就是：**一个已发现的 nested Skill Root 从所有祖先 Package snapshot 中裁掉，并作为独立 Package snapshot。**

这样：

- 修改 `bar` 不会改变 `foo` 的 digest；
- `foo` 不会因为目录嵌套获得对 `bar` 的隐式 runtime dependency；
- 一个 Package 仍然恰好对应一个 Skill。

如果 nested `SKILL.md` 被 `skiloom-repo.toml` 的 discovery filter 排除，它就不是独立 Package Root，因此其目录仍作为普通内容保留在祖先 Package snapshot 中。

## 3. 允许的文件类型

v0 Package snapshot 只允许：

```text
regular file
目录（由文件路径隐式表达）
```

拒绝：

```text
symlink
hardlink
FIFO
device node
socket
其他特殊文件
```

原因是 symlink/特殊文件会引入宿主平台差异、路径逃逸和 materialization 语义差异。未来如果出现真实 Skill 使用场景，再通过新 snapshot format version 扩展。

## 4. Path 契约

进入 snapshot 的每个文件路径必须：

- 相对 Package Root；
- 使用 `/` 作为协议分隔符；
- 是合法 UTF-8；
- 非空；
- 不是 absolute path；
- 不包含 NUL；
- 不包含 `.` 或 `..` path component；
- 不在 Unicode default case folding 后与另一路径冲突。

例如以下 Package 非法：

```text
assets/Icon.png
assets/icon.png
```

因为它们在 case-insensitive filesystem 上不能可靠共存。

v0 **不执行 Unicode normalization**。路径的原始 UTF-8 code point sequence 保持不变；case-fold 只用于 portability collision 检查，不改变实际 path，也不改变 digest 输入。

## 5. 文件 metadata

Package content identity 只保留真正影响 runtime 的文件语义：

```text
relative path
executable bit
exact file bytes
```

忽略：

```text
mtime / ctime / atime
uid / gid / owner / group
inode
普通 read/write permission 差异
archive entry order
archive compression metadata
checkout directory metadata
```

Executable 语义归一成一个布尔值：

```text
executable = false | true
```

对 GitHub Release/Git source，executable 必须从 exact repository snapshot 的 Git file mode 得出：普通 blob mode `100755` 为 `true`，普通 blob mode `100644` 为 `false`；不得从 materialize 后的宿主文件系统权限反推。

也就是本机 `0644` 与 `0664` 不产生不同 Package identity；source snapshot 的 `100644` 与 `100755` 产生不同 identity。

## 6. 文件 bytes 不做内容重写

Skiloom 对文件 bytes 原样计算 digest。

明确不做：

```text
CRLF -> LF
LF -> CRLF
Unicode normalization
trim whitespace
Markdown/TOML/YAML reformat
text encoding conversion
```

因此 source snapshot 中的 bytes 改变，就应该改变 Package content identity。

## 7. Canonical entry ordering

目录 entry 本身不进入 canonical digest stream，因为：

- Git 不保存空目录；
- 非空目录结构已经由 relative file path 完整表达；
- Package identity 不需要绑定宿主文件系统的目录 metadata。

所有 regular-file entries 先按 **relative path 的原始 UTF-8 bytes** 做升序字典排序。

排序不使用：

- locale；
- Unicode normalization；
- case folding；
- 宿主文件系统排序规则。

Case folding 只用于前置 collision validation。

## 8. `SKILOOM-PACKAGE-V1` canonical digest

v0 format identifier：

```text
SKILOOM-PACKAGE-V1
```

每个文件先计算：

```text
file-digest = SHA-256(exact file bytes)
file-size   = exact byte length
```

然后为每个已排序 entry 编码以下字段：

```text
relative-path UTF-8 bytes
executable flag
file-size
file-digest raw 32 bytes
```

Canonical stream 使用固定二进制 framing，不得使用可产生连接歧义的裸字符串拼接。

v0 的字节级编码固定如下：

```text
header:
  ASCII bytes: "SKILOOM-PACKAGE-V1\0"
  entry-count: uint64 big-endian

for each file entry in canonical order:
  entry-kind:   0x01                    # regular file
  path-length:  uint64 big-endian       # UTF-8 byte length
  path-bytes:   exact relative path UTF-8 bytes
  executable:   0x00 | 0x01
  file-size:    uint64 big-endian
  file-digest:  32 raw SHA-256 bytes
```

`uint64 big-endian` 表示固定 8 bytes、无符号、网络字节序。v0 不允许另一种等价 varint/整数编码，因此同一 Package entry sequence 只有一个 canonical byte stream。

最终：

```text
content-digest = SHA-256(canonical stream)
```

标准文本表达：

```text
sha256:<64 lowercase hex chars>
```

## 9. 为什么不 hash archive

Package identity 不使用：

```text
SHA256(release.tar.gz)
SHA256(source.zip)
SHA256(temp-directory-tarball)
```

因为 archive compression、header、timestamp、entry layout 等 transport metadata 可以变化，而解压后的 Package 语义不变。

Release/Git source provenance 负责回答“内容从哪里来”；`content-digest` 负责回答“选中的 Package snapshot 是什么内容”。两者在 Machine Registry 的当前已接受精确状态中保持分离，并在显式精确导出中一起传播。

## 10. Store Key

Package Store 直接以 `content-digest` 寻址。

逻辑布局：

```text
<store>/
└── sha256/
    └── <64-hex-digest>/
        ├── SKILL.md
        ├── scripts/
        └── ...
```

因此不同来源：

```text
repo A / commit X / foo
repo A / commit Y / foo
repo B / commit Z / foo
```

只要最终 canonical Package snapshot 完全相同，就复用同一 Store entry。

GitHub owner/repo、Release version、tag、commit、package-root 等 provenance 不进入 Store key；它们保存在 Machine Registry 的当前精确来源/Package records 中。

## 11. Store 写入与验证

Store entry 是 immutable。

写入流程：

```text
materialize selected Package snapshot
  -> validate path/file-type portability
  -> remove independently discovered nested Package Roots
  -> compute SKILOOM-PACKAGE-V1 digest
  -> if Store entry already exists:
       verify existing entry computes to same digest
       reuse
     else:
       write to temporary location
       verify materialized digest
       atomically publish under sha256/<digest>
```

不得把 mutable Git checkout 或 Release extraction directory 直接作为 Store entry。

## 12. 与当前精确安装状态的关系

Machine Registry 把 Package content identity 与 source provenance 重新关联，但不复制第二套 Package name/ref authority：

```text
Direct Install Requirement
  -> Package coordinate 或 repository-wide coordinate
  -> top-level Release requirement 或 requested Git ref

Resolved Source
  -> canonical repository coordinate
  -> Release: normalized SemVer + actual tag + exact commit + immutable signal
  -> Git: requested ref + exact commit

Resolved Package
  -> full Package coordinate（末段即 SKILL.md.name）
  -> repository-relative package-root
  -> content-digest
  -> resolved dependency edges
```

Git requested ref 属于用户的直接安装要求与精确来源 provenance；Package name 已编码在 full Package coordinate 中，不再复制独立 name authority。`content-digest` 不包含 provenance，所以 Store 可以跨 repository/source 去重；Machine Registry 通过 direct requirement、resolved source、resolved package/edge 关系把内容与来源重新关联。

## 13. 错误边界

v0 至少需要区分：

- `UnsupportedPackageFileType`：包含 symlink 或其他特殊文件；
- `InvalidPackagePath`：路径不是合法 portable relative UTF-8 path；
- `PackagePathCollision`：Unicode default case folding 后发生冲突；
- `PackageContentDigestMismatch`：已有/重建 snapshot 与当前已接受或导出记录的 expected digest 不一致；
- `CorruptStoreEntry`：content-addressed Store entry 自校验失败。

## 14. 最终 v0 契约

```text
snapshot boundary:
  selected Skill Root
  - independently discovered nested Skill Roots

allowed files:
  regular files only

symlink:
  forbidden

content semantics:
  relative UTF-8 path
  executable bool
  exact bytes

ignored metadata:
  timestamps / owner / ordinary permissions / inode / transport metadata

ordering:
  raw UTF-8 path bytes ascending

normalization:
  none

portability:
  reject Unicode case-fold path collision

digest:
  SHA-256(SKILOOM-PACKAGE-V1 canonical binary stream)

Store key:
  content-digest
```
