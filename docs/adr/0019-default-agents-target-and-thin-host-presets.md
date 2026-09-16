# ADR 0019：默认 `.agents/skills` Target 与轻量 Host preset

- 状态：Accepted
- 日期：2026-09-16

## 背景

#22 已确认 Codex、Gemini CLI、OpenCode 都支持 `.agents/skills`，Claude Code 则以 `.claude/skills` 为原生目录；多个宿主也支持 symlink，但具体平台/沙箱仍存在差异。

Skiloom 已采用任意 Target + 机器级共享 Store 模型。如果让每个宿主拥有自己的安装架构、Store 和 materialization 策略，会重新制造宿主耦合，并与统一 Target/ownership 设计冲突。

## 决定

1. Skiloom 官方实现的内部机器数据放在 `~/.skiloom/`，Package Store 默认位于 `~/.skiloom/store/`。
2. 用户未提供显式 Target 或 Host preset 时：workspace scope 默认 `<workspace>/.agents/skills/`，user scope 默认 `~/.agents/skills/`。
3. v0 内建 Host preset 只做 Target 快捷映射：Codex/Gemini/OpenCode 继续映射到 `.agents/skills`；只有用户明确选择 Claude preset 时映射到 `.claude/skills`。
4. Target 选择优先级固定为：显式 Target > 显式 Host preset + scope > 默认 `.agents/skills`。
5. Host preset 不修改宿主配置、不拥有 Package Store、不处理 dependency graph、不决定来源确认，也不形成宿主专用 installer。
6. symlink/junction/copy 继续由通用 Target materialization 逻辑决定；Host preset最多提供已知能力或风险提示。
7. 同一个 Package 可从单一 Store 同时投影到多个 Target；每个 Target 独立拥有 Target Identity/Generation 与 ownership 状态。
8. v0 不建立第三方 Host Adapter SDK 或动态 plugin registry；未来只有在真实宿主需求无法由“路径映射 + 提示 + 显式 Target”满足时再单独扩展。

详细契约见 [`../design/host-target-presets.md`](../design/host-target-presets.md)。

## 结果

Skiloom 的默认公开安装面统一为 `.agents/skills`，内部内容仓库统一位于自己的 `.skiloom` 管理范围；Host 集成保持薄层，不会反向塑造 Package Store、依赖解析或 Target ownership 架构。
