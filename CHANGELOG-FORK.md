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

**已合入**(均经 Opus + Codex 双重安全审计:9 条红线全清、0 安全发现):

- `docs`: 添加 fork 维护计划(`IMPLEMENTATION_PLAN.md`)与本说明 — `71e17e8`
- `security`: 修复 untracked 文件 symlink 逃逸导致的凭据泄露(`lib/git.mjs`,`realpathSync` 限定 workspace 内)— `487b54d`,边界测试/TOCTOU 标注 `138958e`。Opus 设计+验证,Codex 独立复审 NEEDS_DISCUSSION(**无安全阻断**;TOCTOU 残余需本机并发执行能力、在威胁模型外,已诚实标注)
- #300 `fix`: broker shutdown 加 wall-clock timeout,broker 接受连接却不回复时不再无限挂 — `357893b`
- #302 `feat`: JSON-RPC `request()` 加 per-request wall-clock timeout + turn idle timeout,根治「卡死/无响应」主根因(request 永久 pending)— `18d3ee9`

**暂缓 / 不合入**:

- #312(per-turn watchdog):**HOLD**。Codex 在 Node v24.10.0 **复现** HIGH 正确性缺陷——watchdog 打不断卡住的 `startRequest()`,timer reject 一个无人 await 的 promise 导致 unhandledRejection / exit 1(而非 PR 承诺的 exit 124),且新测试只覆盖错误对象形状、未测真实 timeout 行为。安全无虞(9 红线全清),但功能不达标;且 #302 的 request 层 timeout 已更根本地覆盖该场景(任何 RPC hang 都会被 reject),故暂不合入。如需补,要重写 watchdog 使其能中断 `startRequest`(如 `Promise.race`)。
