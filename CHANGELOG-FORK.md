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
- #361 `feat`: 加固 Codex turn 生命周期 — 用 `Promise.race([work, ceiling, stall, exit])` + `interruptTurnBestEffort` 替换 #302 在 captureTurn 的 idle 机制(额外覆盖 pre-ACK start RPC hang/reject、abandoned turn 上游 interrupt 防重叠重试),保留 #302 的 app-server `request()` 超时;broker 闲置自杀(`CODEX_COMPANION_BROKER_IDLE_MS` 默认 30min)+ `onSocketGone` 孤儿 turn 自毁(根治 broker 进程泄漏)+ shutdown 先关 listener 再关 appClient;失败回传错误而非空响应(治「无响应」)— `8be4ab3`。**双审 Opus + Codex(gpt-5.5 xhigh)均 APPROVE**,9 红线全清、0 安全发现,3 个互相印证的 LOW 非阻断(onSocketGone `error+close` 双事件幂等但无专测、`CEILING_MS` 兜底路径无专测、#355 后台任务交互——#355 未合,非缺陷)。全套 98/98 干净环境绿

**暂缓 / 不合入**:

- #312(per-turn watchdog):**已被 #361 取代(SUPERSEDED),永久弃用**。#312 的 watchdog 打不断卡住的 `startRequest()`,timer reject 一个无人 await 的 promise → unhandledRejection / exit 1(而非 PR 承诺的 exit 124)——Codex 在 Node v24.10.0 复现 HIGH 正确性缺陷;新测试也只覆盖错误对象形状、未测真实 timeout 行为。#361 用 `Promise.race`(从创建即观测所有 racer、包裹 start RPC、上游 interrupt)**正确实现了 #312 想做的事**,已于 `8be4ab3` 合入,故 #312 不再合入。
- #294 / #343 / #355:仍 **HOLD**(未变)。#294 Windows `cmd.exe` + baseRef 校验自带命令注入风险;#343 PowerShell 进程清理自带注入 + 误杀风险;#355 background job broker 保活属独立功能(非缺陷),#361 的 broker 闲置自杀与其**互补**(一个保活一个收尸),如未来重度依赖跨会话后台任务再单独评估合入。
- #346(codex-rescue reliability pass):**HOLD,暂不考虑合并**(用户 2026-06-09 决定:改动太大)。16 文件 / 3099 行,且是整批唯一引入**自动执行 PostToolUse hook** 的 PR(`codex-rescue-completion-hook.mjs`:Agent 工具用后注入"已完成/别空等"上下文)+ 后台 task-worker spawn + 测试用 `NODE_OPTIONS` preload。功能为 codex-rescue 完成信号 + worker 生命周期检测,属**可靠性打磨**而非根因修复——「卡死/无响应」主根因已被 #302+#361 覆盖,边际价值低;risk/reward 全批最差(最大改动 + 新增 auto-exec hook 攻击面)。快扫未见明显危险(hook 仅读 state 吐文本、spawn 用数组参数),但**未做 merge 级完整双审**。将来若"Claude 在 codex-rescue 已返回后仍空等/轮询"症状明显,再正经双审或只 cherry-pick 最小完成信号版。
