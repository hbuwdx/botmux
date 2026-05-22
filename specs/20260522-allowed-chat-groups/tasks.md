# allowedChatGroups Tasks

| ID | Description | Files | Depends-On | Acceptance |
|---|---|---|---|---|
| T-1 | Add `allowedChatGroups` to bot config parsing, runtime state defaults, setup editing, examples, and README docs. | `src/bot-registry.ts`, `src/setup/bot-config-editor.ts`, `src/cli.ts`, `bots.json.example`, `README.md`, `README.en.md`, `test/bot-registry.test.ts`, `test/bot-config-editor.test.ts` | — | `pnpm vitest run test/bot-registry.test.ts test/bot-config-editor.test.ts` passes. |
| T-2 | Add Lark chat-member open_id pagination and resolve each configured `allowedChatGroups` into a daemon startup snapshot. | `src/im/lark/client.ts`, `src/daemon.ts`, `test/lark-client-allowed-chat-groups.test.ts` | T-1 | `pnpm vitest run test/lark-client-allowed-chat-groups.test.ts && pnpm build` passes. |
| T-3 | Make `canTalk` allow users from the resolved `allowedChatGroups` snapshot while keeping `canOperate` restricted to `allowedUsers`. | `src/im/lark/event-dispatcher.ts`, `test/event-dispatcher.test.ts` | T-1, T-2 | `pnpm vitest run test/event-dispatcher.test.ts` passes. |
| T-4 | Run final integration verification and confirm no periodic or per-message refresh path was added for `allowedChatGroups`. | `src/bot-registry.ts`, `src/im/lark/client.ts`, `src/daemon.ts`, `src/im/lark/event-dispatcher.ts`, `src/setup/bot-config-editor.ts`, `src/cli.ts`, `README.md`, `README.en.md`, `bots.json.example`, `test/bot-registry.test.ts`, `test/bot-config-editor.test.ts`, `test/lark-client-allowed-chat-groups.test.ts`, `test/event-dispatcher.test.ts` | T-1, T-2, T-3 | `pnpm vitest run test/bot-registry.test.ts test/bot-config-editor.test.ts test/lark-client-allowed-chat-groups.test.ts test/event-dispatcher.test.ts && pnpm build && grep -R "allowedChatGroups" -n src test README.md README.en.md bots.json.example && ! grep -R "setInterval\|Cron\|scheduler" -n src \| grep "allowedChatGroups"` passes. |

## Dispatch notes

- 选择 `sdd-implement` 串行执行更合适：T-2 依赖 T-1 新增的 `BotState.resolvedAllowedChatGroupUsers` 与 `BotConfig.allowedChatGroups`，T-3 又依赖 T-1/T-2 的运行态字段，文件分区不是干净并行。
- T-1 可以独立开始；T-2 必须在 T-1 的类型字段存在后执行；T-3 必须在运行态缓存字段和 daemon 解析逻辑存在后执行；T-4 只做最终验证。
- 若后续强行 dispatch，必须按 T-1 → T-2 → T-3 → T-4 顺序逐个派发，并在每个 subagent prompt 内内联对应 plan Task 的完整步骤与代码片段。
