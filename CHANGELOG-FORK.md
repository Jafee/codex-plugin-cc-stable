# Fork 维护说明 / CHANGELOG-FORK

本仓库是 [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 的**私有自维护 fork**(`stable` 分支),用于在官方维护停滞期间合入**经过 Opus + Codex 双重安全审计**的稳定性修复(主要解决「卡死 / 无响应」)。

## 来源与合规(Apache-2.0)

- **Upstream**: `openai/codex-plugin-cc`
- **Fork 基线**: `807e03ac9d5aa23bc395fdec8c3767500a86b3cf`(v1.0.4,2026-04-18,已逐字节核验等于官方 main tip)
- **许可证**: Apache-2.0(保留原 `LICENSE` 与 `NOTICE`)
- 本 fork 的所有修改在下方 Changelog 标注

## 维护原则(安全不变量,不可破坏)

- **零运行时依赖**:绝不引入任何 runtime dependency
- **无对外网络**:核心代码不新增 `fetch/http/net.connect` 到外部主机
- **无 shell 注入**:`spawn` 一律用数组参数,不拼接 shell 字符串
- **不放宽 CI**:保持 `on: pull_request`,绝不改成 `pull_request_target`
- **双审强制**:每个合入的 upstream PR 必须通过 Opus + Codex 双重安全审计(Verdict 一致 PASS 才合)
- **干净落地**:审计 PR 的净 diff 后,重落为本 fork 的干净 commit(co-author 原作者),不直接 merge 陌生人分支历史
- **回归门禁**:合入后 `npm test` 必须在干净环境(`env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID ...`)全绿

## Changelog

### [未发布] stable

- `docs`: 添加 fork 维护计划(`IMPLEMENTATION_PLAN.md`)与本说明
- _(进行中)_ `security`: 修复 untracked 文件 symlink 跟随导致的潜在凭据泄露(`lib/git.mjs`)
- _(进行中)_ 合入卡死/无响应修复 #302 #312 #300(Opus + Codex 双审通过后)
