# ADR 0017：Node.js 官方实现 + Optional Native Helpers

- 状态：Accepted
- 日期：2026-09-15

## 背景

Skiloom v0 的主要产品行为已经收敛，但官方实现的语言、包管理、代码组织与高复杂度算法实现方式尚未固定。

项目的首要产品目标是低摩擦传播：用户应能通过 npm 快速安装或直接 `npx` 运行，而不是先选择平台 binary、安装额外 toolchain 或理解多套发行方式。

同时，Resolver、Git object processing、超大 Package Snapshot hashing 等热点未来可能存在性能或底层能力需求。要求所有算法永久使用 TypeScript 会不必要地限制实现；反过来把 Rust/C/C++ 作为主程序又会提高发布与安装复杂度。

## 决定

1. **官方实现主技术栈固定为 Node.js + TypeScript + npm。** Runtime support floor 为 Node.js 22；开发/release 主线使用 Node.js 24 LTS；TypeScript 使用 strict + ESM；提交 `package-lock.json`。
2. **公开发行入口固定为 npm package / executable `skiloom`。** 用户目标入口是 `npm install -g skiloom` 与 `npx skiloom`。v0 不先拆成多个 public npm library packages。
3. **Node/TypeScript 是 control plane。** CLI、GitHub access、credentials、本机状态写入策略、状态接受、Store/Target side effects 与用户交互都由 Node 层拥有。
4. **允许 optional prebuilt native compute helper。** Rust、C、C++ 等可以实现明确的计算热点或底层处理，但 helper 位于窄的内部 seam 后，不形成通用 provider/plugin framework。
5. **Standalone executable 是默认 native seam。** Node 通过 direct child-process spawn 调用预编译 helper；不要求用户机器安装 compiler/toolchain，也不默认绑定 Node/V8 native addon ABI。
6. **Native helper 不拥有隐式外部状态。** 它不得自行获取 GitHub/network/credentials、做用户授权、写本机状态库、修改 Target 或决定 Package Store ownership；只处理 Node 显式提供的 deterministic input，并返回 deterministic result/error。
7. **产品行为权威始终是官方产品规范 + 官方行为测试数据。** TypeScript/native 对同一固定输入必须产生产品规则要求的一致结果。计算算法可以只存在 native implementation，不强制维护重复的 TypeScript fallback，但必须通过同一官方行为测试。
8. **Native binary通过 npm平台包优先分发。** CI预编译；platform package使用 npm `os` / `cpu` / 必要时 `libc` metadata；主 package可通过 `optionalDependencies`携带 optional accelerator。普通用户仍只安装 `skiloom`。
9. **不在 install 时现场编译 native code。** v0 不要求 Rust/C/C++/CMake/SDK；也不通过运行时任意 URL 下载未被 release/npm provenance管理的 executable。
10. **不预造 native abstraction。** 只有真实 helper出现时才建立对应内部 seam；不提前设计 `NativeProvider`、backend registry或算法 plugin体系。
11. **代码保持单一公开 package、多 deep Module。** 初始内部 ownership为 `domain`、`source/github`、`runtime`、`native`、`cli`，官方行为测试数据独立于内部实现结构。只有出现真实第二发布物时才启用 npm workspaces。

## 结果

- npm保持 Skiloom 最低摩擦的传播路径；
- 普通安装不依赖 native build toolchain；
- 复杂算法仍可以按实际需要迁移到 Rust/C/C++；
- native helper crash/performance/runtime lifecycle与 Node 主进程隔离；
- 产品语义不会因 TypeScript/native implementation choice 分叉；
- 不会因为“未来可能需要其他 backend”而提前引入 generic provider framework；
- implementation tickets必须基于本 architecture，而不是此前的 Rust/Cargo 假设。

完整 project structure、dependency direction、native packaging 与 testing 原则见 [`../design/official-implementation-architecture.md`](../design/official-implementation-architecture.md)。
