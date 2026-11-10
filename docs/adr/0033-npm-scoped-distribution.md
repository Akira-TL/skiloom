# ADR 0033：npm 发行包统一使用 @akira-tl Scope

- 状态：Accepted
- 日期：2026-11-10
- Supersedes：ADR 0017 中 unscoped npm package 发行命名；ADR 0016 中 reference implementation 的首选 unscoped distribution token

## 背景

Skiloom 的产品、CLI、协议和文件 namespace 已经稳定使用 `Skiloom / skiloom`。首次 npm 发布使用了 unscoped 包：

```text
skiloom
skiloom-lock-darwin-arm64
skiloom-lock-darwin-x64
skiloom-lock-linux-x64-gnu
skiloom-lock-win32-x64-msvc
```

实际发布后，这五个包在 npm 公共 namespace 中彼此独立，无法像现有 `@akira-tl/forgerelay` 一样明确表达同一发行者和同一产品族。平台 helper 本来就是主包的内部发行实现细节，把它们留在全局 unscoped namespace 还会额外占用多个通用包名。

同时，npm scope 只改变 registry package coordinate，不要求修改 CLI executable、产品品牌、协议 token、配置文件名或 Skiloom 自己的 Package Name 概念。

## 决定

1. Skiloom 的产品、CLI、协议和公开文件 namespace 继续保持 `Skiloom / skiloom`。
2. 官方 npm 主包改为：
   ```text
   @akira-tl/skiloom
   ```
3. 官方 npm 平台 helper 改为：
   ```text
   @akira-tl/skiloom-lock-darwin-arm64
   @akira-tl/skiloom-lock-darwin-x64
   @akira-tl/skiloom-lock-linux-x64-gnu
   @akira-tl/skiloom-lock-win32-x64-msvc
   ```
4. CLI executable 继续固定为 `skiloom`。用户全局安装入口变为 `npm install -g @akira-tl/skiloom`；一次性执行使用 `npx --package @akira-tl/skiloom -- skiloom ...`。
5. 主包继续通过精确版本 `optionalDependencies` 引用四个平台 helper，npm 仍依据 `os` / `cpu` / `libc` 选择当前平台包。
6. npm scope 不进入 Skiloom 的 GitHub Package Coordinate、Package Name、Package Content Digest、Machine Registry、Target、marker 或 export 格式。它只属于官方 Node/npm distribution identity。
7. 已发布的 unscoped `0.8.16` 保持原样，不重写其 Git tag 或 tarball。Scoped 发行从下一补丁版本开始；旧 unscoped 包只作为迁移入口，不再作为未来主线发行坐标。
8. Trusted Publishing 对五个 scoped 包分别配置，但都绑定同一 GitHub repository 与 release workflow。正式长期配置只允许 staged publishing；首次创建 scoped package 时允许使用一次现有 npm token 完成 staged bootstrap，包存在后立即迁移到 OIDC 并撤销长期 token。

## 结果

- npm 页面与现有 `@akira-tl/forgerelay` 的组织方式一致；
- 用户需要记住的 CLI 仍只有 `skiloom`；
- 四个平台 helper 明确成为 `@akira-tl` 产品族的一部分，不继续占用全局 unscoped namespace；
- npm distribution identity 与 Skiloom 产品/协议 namespace 明确分离；
- `v0.8.16` 的已发布 unscoped 产物保持不可变，后续迁移不依赖 retag 或覆盖历史包。
