# Review: 20260522-allowed-chat-groups

**Base:** master@f7d7241113b085c91ba3ac08dcf76bfa383fa903
**Head:** 661abc79c2c577f9e495770a082abc7038dfcc9c
**Date:** 2026-05-23

## 🟢 Passing

| Item | Status | Evidence |
|---|---|---|
| FR-1 | Covered | d3462ba, `src/bot-registry.ts:44`, `src/bot-registry.ts:260-298`, `test/bot-registry.test.ts:363-375`. |
| FR-2 | Covered | d3462ba, `src/bot-registry.ts:67`, `src/bot-registry.ts:114`, `test/bot-registry.test.ts:87-90`; group-derived members are stored separately from `resolvedAllowedUsers`. |
| FR-3 | Covered | 781a22a + e96d3e8, `src/im/lark/client.ts:444`, `src/services/allowed-chat-groups.ts:5-19`, daemon startup call at `src/daemon.ts:1148`; tests `test/lark-client-allowed-chat-groups.test.ts:23-58` and `test/allowed-chat-groups.test.ts:15-38`. |
| FR-4 | Covered | e96d3e8, fail-closed/partial-failure behavior in `src/services/allowed-chat-groups.ts:12-19`; regression `test/allowed-chat-groups.test.ts:41-62`. |
| FR-5 | Covered | 55acbc0 + 97d54c5, `src/im/lark/event-dispatcher.ts:486-494`, `test/event-dispatcher.test.ts:439-448`. |
| FR-6 | Covered | 55acbc0, `test/event-dispatcher.test.ts:448` calls `canTalk` with `oc_different_chat`, proving membership is not a chat whitelist. |
| FR-7 | Covered | 55acbc0 + 7946f53, `src/im/lark/event-dispatcher.ts:498-504`, `test/event-dispatcher.test.ts:463-483`; card fallback tightened by 661abc7 at `src/im/lark/card-handler.ts:156-163` and `test/card-integration.test.ts:558-581`. |
| FR-8 | Covered | Existing unrestricted behavior retained only when no allowlist source is configured: `src/im/lark/event-dispatcher.ts:492-493` and `src/im/lark/event-dispatcher.ts:501-502`; target suites passed. |
| FR-9 | Covered | No `setInterval` / `Cron` / `scheduler` references mention `allowedChatGroups`; startup-only call at `src/daemon.ts:1148`. |
| FR-10 | Covered | d3462ba, `README.md:437,458`, `README.en.md:366,387`, `bots.json.example:7`, `src/setup/bot-config-editor.ts:221-226`, `src/cli.ts:568-574`. |
| T-1 | Covered | d3462ba. |
| T-2 | Covered | 781a22a + e96d3e8. |
| T-3 | Covered | 55acbc0 + 97d54c5 + 7946f53 + 661abc7. |
| T-4 | Covered | Fresh verification: `./node_modules/.bin/vitest run test/bot-registry.test.ts test/bot-config-editor.test.ts test/lark-client-allowed-chat-groups.test.ts test/allowed-chat-groups.test.ts test/event-dispatcher.test.ts test/card-integration.test.ts` passed 6 files / 150 tests. |
| External security review | Covered | Coco third review reported no blocking; two prior blocking findings were fixed by 97d54c5 and 7946f53; fallback risk fixed by 661abc7. |

Risk scan: correctness, security, robustness, testability, API contract, and architecture checks have no blocking findings after the fail-closed fixes.

## 🟡 Improvement

- Build command is blocked by existing environment/setup issues, not this feature: `npx tsc --noEmit` fails on `src/setup/register-app.ts` missing SDK export/types, and `corepack pnpm build` fails because the current `pnpm-workspace.yaml` lacks `packages`. Release verification needs a working build path or cleanup of those pre-existing workspace/dependency issues.
- `allowedChatGroups` is intentionally a startup snapshot. Members removed from an authorized chat retain ordinary talk permission until daemon restart. This matches the approved spec, and README documents restart semantics at `README.md:458` / `README.en.md:387`.
- If all configured group resolutions fail, ordinary group-derived access fails closed. This is safe but may be operationally noisy only in daemon logs (`src/services/allowed-chat-groups.ts:14-16`); a future diagnostic/DM could improve visibility.

## 🔴 Blocking

- (none)
