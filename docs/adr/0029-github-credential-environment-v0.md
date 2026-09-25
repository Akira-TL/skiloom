# ADR 0029：v0 GitHub 凭据只通过环境注入

- 状态：Accepted（GitHub API credential boundary；Git repository transport 范围由 ADR 0032 修订）
- 日期：2026-09-20
- 对应 Wayfinder：#127 `Decide v0 GitHub credential and private-source boundary`
- 修订：ADR 0032 `GitHub repository 内容优先使用 system Git transport`

## 背景

Skiloom v0 的 GitHub source runtime 已经完整区分 `github-release` 与 explicit `git`，并且底层 source pipeline 已有显式 `credential?: string` seam。Transport 会把该值作为 GitHub API Bearer credential 使用，现有测试也已经证明 credential 不进入 source identity、result 或 structured error。

但是截至 `0.8.3`，公开 CLI/runtime orchestration 从未提供 credential，因此实际只能匿名访问 GitHub。这样会造成两个问题：

1. private repository 虽然底层 runtime 可处理 credential，公开产品却没有合法入口；
2. public repository 的 authenticated rate-limit 场景同样无法利用已有 seam。

另一方面，v0 已明确不建立 generic provider/credential framework，也不允许 credentials 进入 Registry、Store、marker 或 export。通过 CLI argv 直接提供 token 还会把 secret 暴露给 shell history / process listing，因此不适合作为默认公开接口。

## 决定

### 1. github.com API credential discovery 只读取环境

Skiloom v0 对 GitHub API metadata transport 使用第一项非空环境变量：

```text
GH_TOKEN
> GITHUB_TOKEN
> anonymous
```

即：

1. 非空 `GH_TOKEN`；
2. 否则非空 `GITHUB_TOKEN`；
3. 两者都没有时保持匿名 GitHub source access。

空字符串或纯空白值视为未设置。选中的非空 token 作为 opaque credential 使用；Skiloom 不定义 GitHub token 自身的格式或权限模型。

这个优先级与当前 GitHub CLI 针对 `github.com` 的环境变量约定一致。

### 2. 不建立其他凭据来源

v0 不：

- 增加 `--token` / `--credential`；
- 读取 `gh auth` 的持久登录态；
- 调用 `gh auth token`；
- 由 Skiloom 主进程主动读取 Git credential helper secret；
- 由 Skiloom 主进程主动访问 OS keychain；
- 建立 Skiloom credential file/store/profile；
- prompt 用户输入 token；
- 自动写入 shell/environment 配置。

Skiloom 的 GitHub source 目前固定为 `github.com` / `api.github.com`，因此 `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` 与 GitHub Enterprise host discovery 不属于 v0。

### 3. 凭据只适用于需要 GitHub API metadata 的 source path

ADR 0032 将 Git repository transport 与 GitHub API metadata transport 分开。选中的 token 只传给仍需要 GitHub API facts 的路径，例如 GitHub Release listing、immutable signal 与明确需要 API repository metadata 的验证。

Git ref/tag、exact commit、tree/blob 等 Git facts迁移到 system Git 后，不要求把 `GH_TOKEN` / `GITHUB_TOKEN` 传给 Git subprocess。system Git / OpenSSH MAY 使用用户已有的 SSH config / ssh-agent，但 Skiloom 不读取这些 credential。

`github-release` 和 explicit `git` 仍是不同 source kind；任何 transport fallback 都不得把一种 source kind 静默改成另一种。

`sync` 只 replay accepted exact state，不重新 source resolve，因此没有 GitHub credential requirement。

Exact import 继续允许完全离线。它接受的是 export 中记录的 exact source set 和内容，而不是使用当前 token 从远端重新选择/替换内容；因此 import 不因为本 ADR 变成 online credential flow。

### 4. 私有仓库支持是权限结果，不是新的 source kind

Private repository 可以通过用户现有 Git/SSH access 提供 Git repository facts；需要 GitHub API metadata 的路径仍可使用 `GH_TOKEN` / `GITHUB_TOKEN`。两种 credential transport 都不形成新的 source kind。

Skiloom 不把：

```text
public-github
private-github
authenticated-github
```

建成新的 source kind 或 accepted-state identity。

是否使用 credential 不进入 resolver ordering、source binding、Package digest 或 Store key。

### 5. 凭据绝不进入持久化或输出

Credential bytes 不得进入：

- Machine Registry；
- Package Store；
- Git source cache key或 cache payload；
- `.skiloom-state`；
- exact export/import；
- accepted source identity；
- candidate facts；
- JSON/human output；
- warnings/logs；
- first-party Skill content。

现有 `SourceAccessUnavailable` 的 `401 | 403 | 404` 边界保持不变。特别是 `404` 仍不推断“repository 不存在”还是“private 且当前 credential 无权限”，也不输出 credential 来源或值。

### 6. Catalog 凭据与 GitHub 凭据分离

SkillsMP 仍是 discovery-only provider。GitHub token discovery：

- 不传给 SkillsMP；
- 不改变 Catalog ranking/provenance；
- 不把 Catalog credential 解释成 GitHub credential；
- 不让 Catalog 成为 source authority。

### 7. Source cache 不绑定 credential

Git source cache 仍按 canonical repository + exact commit 等 source 内容事实寻址，而不是 credential。

因此曾经通过有效 credential 获取并校验的 exact snapshot 可以在 credential 后来不存在时继续作为 disposable cache 命中；这不会把 credential 传播到 cache，也不会改变 Package content identity。

## 实现边界

官方实现增加一个极小的 Node credential resolver：

```text
process.env
  -> GH_TOKEN
  -> GITHUB_TOKEN
  -> credential | undefined
```

随后只把结果传给 GitHub API metadata transport。Git repository transport 的 ambient SSH/Git authentication 由 system Git/OpenSSH 自己处理；Skiloom 不把这些 credential material 转换成该 `credential` 参数。

不要为此创建：

- CredentialProvider registry；
- auth plugin；
- encrypted credential database；
- generic host authentication framework。

## 测试要求

至少验证：

1. `GH_TOKEN` 优先于 `GITHUB_TOKEN`；
2. 空/纯空白变量按未设置处理；
3. 无 credential 时匿名行为保持；
4. Release source 和 explicit Git source 都收到同一 credential；
5. install/update/remove/recover/fork/repair 的 network source path 都传播 credential；
6. bootstrap 通过普通 install 自动继承；
7. credential 不进入 error/result/JSON、Registry、marker、Store/source-cache payload 或 export；
8. 401/403/404 仍保持原有 `SourceAccessUnavailable` 语义。

## 结果

Skiloom v0 获得 private GitHub source 的最小合法入口，同时不增加 token CLI surface、不建立 credential store，也不改变 source identity 或安全边界。
