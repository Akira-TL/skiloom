# ADR 0027：v0 managed transformed copy 只确定性改写 `SKILL.md`

- 状态：Accepted
- 日期：2026-09-18

## 背景

Skiloom v0 已接受 flat Target、Target-local rename 与 Dependency Routing Overlay，并要求这些变换可由 exact Package graph + projection names 确定性重建。Machine Registry 保存 managed transform facts，`.skiloom-state` 与 exact export 则明确不保存 transformed-copy 展开 bytes。

实现 #54 前仍缺少一个关键约束：当前 Accepted 文档没有定义 transformed copy 的精确输出树。若 runtime 自行选择隐藏 routing 文件、目录 alias、整份 YAML rewrite 或其他字节协议，会让 live Target、drift verification、detach 和未来恢复出现实现自创语义。

旧 ADR 0008（已被 ADR 0018 supersede）曾给出一个仍有价值的最小 rename 原则：rename 的 activation view 应同步改变顶层 `SKILL.md.name`，但不能污染 immutable Store。

## 决定

1. v1 managed transformed copy 的 path set 与原 Store Package Snapshot 完全相同；除顶层 `SKILL.md` 外所有 bytes 与 executable bits 不变。
2. rename 只替换顶层 frontmatter `name` value node 的 YAML source range，不 canonicalize 整份 YAML，也不改正文自然语言。
3. Dependency Routing Overlay 不创建目录 alias 或隐藏 sidecar；只向直接反向依赖 Package 的 `SKILL.md` 末尾追加 canonical `SKILOOM-DEPENDENCY-ROUTING-V1` Markdown instruction block。
4. routing block 是 generated-byte sentinel，不是公开输入格式、恢复权威或 Package metadata。原 Store `SKILL.md` 与 reserved marker 冲突时 fail closed。
5. composition 固定为 rename 后 routing；存在任一 transform 的 projection 必须使用 managed copy。
6. verification 从 Store Snapshot + transform facts 重新生成 expected tree，并比较 exact path/bytes/executable bits；不得从 live routing block 反推状态。
7. transformed copy 不获得第二个 Package digest/Store identity。Package Content Digest 始终指向原始 immutable Package Snapshot。
8. detach 原地转移当前 transformed bytes 的 ownership，不在 detach 时暗中清除 generated block。

完整 byte grammar、newline 与错误边界见 [`../design/managed-transformed-copy-v1.md`](../design/managed-transformed-copy-v1.md)。

## 结果

- #54 可以在不发明新公开格式的前提下实现 rename/routing transformed copy；
- routing 仍是能力调用提示，而不是跨 Package filesystem ABI；
- Store、export、recovery marker 不需要保存生成后 bytes；
- drift verification 有唯一 expected tree；
- 用户 source Package 若碰撞 reserved routing marker，会明确失败而不是被静默改写。
