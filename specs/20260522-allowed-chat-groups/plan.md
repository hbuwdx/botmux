# allowedChatGroups Implementation Plan

**Goal:** 为 botmux 增加 `allowedChatGroups` 配置，让指定飞书群聊的成员获得普通使用权限，同时保持敏感操作只由 `allowedUsers` 控制。

**Architecture:** 配置层新增 `allowedChatGroups`，运行态在 `BotState` 中单独保存解析后的群成员 open_id。daemon 启动时一次性调用 Lark 群成员接口生成内存快照；权限入口 `canTalk` 增加群成员命中分支，`canOperate` 保持用户白名单逻辑不变。

**Tech Stack:** TypeScript, Lark Node SDK `im.v1.chatMembers.get`, Vitest, `pnpm vitest run`, `pnpm build`。

---

## File Structure

- Modify: `src/bot-registry.ts:33-66,278-292` — 配置解析与运行态 bot 状态。
- Modify: `src/im/lark/client.ts:401-442` — 新增群成员 open_id 列表 API wrapper。
- Modify: `src/daemon.ts:11-12,1128-1145` — daemon 启动阶段解析 `allowedChatGroups`。
- Modify: `src/im/lark/event-dispatcher.ts:470-498` — `canTalk` 使用群成员缓存，`canOperate` 不变。
- Modify: `src/setup/bot-config-editor.ts:33-42,211-220` — setup 编辑器支持新字段。
- Modify: `src/cli.ts:563-569` — setup 交互提示和输入收集。
- Modify: `README.md:426-459` — 中文配置文档。
- Modify: `README.en.md` — 英文配置文档中同步字段。
- Modify: `bots.json.example:1-23` — 示例配置增加新字段。
- Modify: `test/bot-registry.test.ts:75-85,345-368` — 配置解析与运行态状态测试。
- Modify: `test/bot-config-editor.test.ts:65-118` — setup 编辑器测试。
- Modify: `test/event-dispatcher.test.ts:84-99,406-459` — 普通使用与敏感操作权限测试。
- Create: `test/lark-client-allowed-chat-groups.test.ts` — Lark 群成员列表 wrapper 测试。

---

### Task 1: 配置模型、解析、setup 编辑和文档

**Files:**
- Modify: `src/bot-registry.ts:33-66,278-292`
- Modify: `src/setup/bot-config-editor.ts:33-42,211-220`
- Modify: `src/cli.ts:563-569`
- Modify: `bots.json.example:1-23`
- Modify: `README.md:426-459`
- Modify: `README.en.md`
- Test:   `test/bot-registry.test.ts:75-85,345-368`
- Test:   `test/bot-config-editor.test.ts:65-118`

- [ ] **Step 1: Write the failing tests**

Add these assertions to `test/bot-registry.test.ts`:

```ts
it('should set resolvedAllowedChatGroupUsers empty by default', () => {
  const cfg = makeCfg();
  const state = mod.registerBot(cfg);
  expect(state.resolvedAllowedChatGroupUsers).toEqual([]);
});

it('should parse allowedChatGroups from config file', () => {
  process.env.BOTS_CONFIG = '/tmp/full.json';
  fsMock.existsSync.mockReturnValue(true);
  fsMock.readFileSync.mockReturnValue(JSON.stringify([{
    larkAppId: 'app_full',
    larkAppSecret: 'secret_full',
    name: 'codex-main',
    cliId: 'gemini',
    cliPathOverride: '/usr/local/bin/gemini',
    backendType: 'tmux',
    workingDir: '/home/user/project',
    allowedUsers: ['alice', 'bob'],
    allowedChatGroups: ['oc_team', 'oc_project'],
  }]));

  const configs = mod.loadBotConfigs();
  const c = configs[0];
  expect(c.allowedChatGroups).toEqual(['oc_team', 'oc_project']);
});
```

Add this case to `test/bot-config-editor.test.ts`:

```ts
it('edits and clears allowedChatGroups', () => {
  const edited = applyBotConfigEdits({
    larkAppId: 'app',
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    allowedChatGroups: ['oc_old'],
  }, {
    allowedChatGroups: 'oc_team, oc_project',
  });
  expect(edited.allowedChatGroups).toEqual(['oc_team', 'oc_project']);

  const cleared = applyBotConfigEdits(edited, { allowedChatGroups: '-' });
  expect(cleared.allowedChatGroups).toBeUndefined();
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
pnpm vitest run test/bot-registry.test.ts test/bot-config-editor.test.ts
```

Expected: FAIL because `resolvedAllowedChatGroupUsers` and `allowedChatGroups` edit parsing do not exist.

- [ ] **Step 3: Minimal implementation**

Update `src/bot-registry.ts`:

```ts
export interface BotConfig {
  larkAppId: string;
  larkAppSecret: string;
  name?: string;
  cliId: CliId;
  cliPathOverride?: string;
  backendType?: 'pty' | 'tmux';
  workingDir?: string;
  workingDirs?: string[];
  allowedUsers?: string[];
  allowedChatGroups?: string[];
  oncallChats?: OncallChat[];
  lang?: Locale;
  defaultOncall?: BotDefaultOncall;
  defaultOncallAutoboundChats?: string[];
}

export interface BotState {
  config: BotConfig;
  client: Lark.Client;
  botOpenId?: string;
  botName?: string;
  resolvedAllowedUsers: string[];
  resolvedAllowedChatGroupUsers: string[];
}

export function registerBot(cfg: BotConfig): BotState {
  const client = new Lark.Client({
    appId: cfg.larkAppId,
    appSecret: cfg.larkAppSecret,
    logger: larkLogger,
  });
  const state: BotState = {
    config: cfg,
    client,
    resolvedAllowedUsers: [...(cfg.allowedUsers ?? [])],
    resolvedAllowedChatGroupUsers: [],
  };
  bots.set(cfg.larkAppId, state);
  return state;
}
```

In `parseBotConfigFile`, parse the array before `configs.push`:

```ts
let allowedChatGroups: string[] | undefined;
if (Array.isArray(entry.allowedChatGroups)) {
  allowedChatGroups = entry.allowedChatGroups
    .filter((x: any): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x: string) => x.trim());
}
```

Add it to the pushed config object:

```ts
allowedUsers: entry.allowedUsers,
allowedChatGroups,
oncallChats,
```

Update `src/setup/bot-config-editor.ts`:

```ts
export interface BotConfigEditInput {
  name?: string;
  larkAppId?: string;
  larkAppSecret?: string;
  cliChoice?: string;
  cliPathOverride?: string;
  backendType?: string;
  workingDir?: string;
  allowedUsers?: string;
  allowedChatGroups?: string;
}
```

Add this block after `allowedUsers` parsing:

```ts
if (input.allowedChatGroups !== undefined) {
  const allowedChatGroups = input.allowedChatGroups.trim();
  if (allowedChatGroups === '-') {
    delete out.allowedChatGroups;
  } else if (allowedChatGroups) {
    out.allowedChatGroups = allowedChatGroups.split(',').map(s => s.trim()).filter(Boolean);
  }
}
```

Update `src/cli.ts` after the allowed users prompt:

```ts
printInputHelp('允许的群聊组', [
  '可选。把飞书群聊作为成员授权源，群内成员获得普通使用权限；多个 chat_id 用逗号分隔。',
  '值通常是 oc_xxx；留空保留当前值；输入 - 清空。',
  '群成员授权不授予 /restart、/close、终端写入等敏感操作权限。',
]);
input.allowedChatGroups = await ask(rl, `允许的群聊组 [${formatOptionalValue(bot.allowedChatGroups)}]: `);
```

Update `bots.json.example` first bot entry:

```json
{
  "larkAppId": "cli_xxx_bot1",
  "larkAppSecret": "your_secret_1",
  "cliId": "claude-code",
  "allowedUsers": ["alice@company.com"],
  "allowedChatGroups": ["oc_xxx_team"],
  "workingDir": "~/projects"
}
```

Update README table with:

```markdown
| `allowedChatGroups` | 否 | 允许的群聊组列表（飞书 `chat_id`，如 `oc_xxx`）。这些群聊的成员获得普通使用权限；成员变更需重启 daemon 生效；敏感操作仍由 `allowedUsers` 控制。 |
```

Update README.en with the same field in English:

```markdown
| `allowedChatGroups` | No | Allowed chat groups (`chat_id`, for example `oc_xxx`). Members of these chats can use the bot normally; membership changes take effect after daemon restart; sensitive operations still require `allowedUsers`. |
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
pnpm vitest run test/bot-registry.test.ts test/bot-config-editor.test.ts
```

Expected: PASS for both files.

- [ ] **Step 5: Commit**

```bash
git add src/bot-registry.ts src/setup/bot-config-editor.ts src/cli.ts bots.json.example README.md README.en.md test/bot-registry.test.ts test/bot-config-editor.test.ts
git commit -m "feat(config): 支持 allowedChatGroups 配置"
```

---

### Task 2: Lark 群成员解析与 daemon 启动缓存

**Files:**
- Modify: `src/im/lark/client.ts:401-442`
- Modify: `src/daemon.ts:11-12,1128-1145`
- Test:   `test/lark-client-allowed-chat-groups.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lark-client-allowed-chat-groups.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatMembersGet = vi.fn();

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({
    im: {
      v1: {
        chatMembers: {
          get: chatMembersGet,
        },
      },
    },
  })),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { listChatMemberOpenIds } from '../src/im/lark/client.js';

describe('listChatMemberOpenIds', () => {
  beforeEach(() => chatMembersGet.mockReset());

  it('paginates chat members and returns open_ids', async () => {
    chatMembersGet
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id: 'ou_a' }, { member_id: 'ou_b' }],
          has_more: true,
          page_token: 'next',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id: 'ou_c' }, { name: 'missing id' }],
          has_more: false,
        },
      });

    await expect(listChatMemberOpenIds('app_a', 'oc_team')).resolves.toEqual(['ou_a', 'ou_b', 'ou_c']);
    expect(chatMembersGet).toHaveBeenNthCalledWith(1, {
      path: { chat_id: 'oc_team' },
      params: { member_id_type: 'open_id', page_size: 100 },
    });
    expect(chatMembersGet).toHaveBeenNthCalledWith(2, {
      path: { chat_id: 'oc_team' },
      params: { member_id_type: 'open_id', page_size: 100, page_token: 'next' },
    });
  });

  it('throws on Lark API errors', async () => {
    chatMembersGet.mockResolvedValueOnce({ code: 999, msg: 'denied' });
    await expect(listChatMemberOpenIds('app_a', 'oc_denied'))
      .rejects.toThrow('Failed to list chat members for oc_denied: denied (code=999)');
  });
});
```

- [ ] **Step 2: Verify test fails**

Run:

```bash
pnpm vitest run test/lark-client-allowed-chat-groups.test.ts
```

Expected: FAIL because `listChatMemberOpenIds` is not exported.

- [ ] **Step 3: Minimal implementation**

Add to `src/im/lark/client.ts` after `resolveAllowedUsers`:

```ts
export async function listChatMemberOpenIds(larkAppId: string, chatId: string): Promise<string[]> {
  const c = getBotClient(larkAppId);
  const openIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await (c as any).im.v1.chatMembers.get({
      path: { chat_id: chatId },
      params: {
        member_id_type: 'open_id',
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code !== 0) {
      throw new Error(`Failed to list chat members for ${chatId}: ${res.msg} (code=${res.code})`);
    }
    for (const item of res.data?.items ?? []) {
      if (item.member_id) openIds.push(item.member_id);
    }
    pageToken = res.data?.has_more ? res.data?.page_token : undefined;
  } while (pageToken);

  return openIds;
}
```

Update `src/daemon.ts` import:

```ts
import { getChatMode, listChatMemberOpenIds, replyMessage, resolveAllowedUsers, sendMessage } from './im/lark/client.js';
```

Add this helper near the per-bot initialization block or above `main()`:

```ts
async function resolveAllowedChatGroups(bot: BotState): Promise<void> {
  const chatIds = bot.config.allowedChatGroups ?? [];
  if (chatIds.length === 0) return;

  const resolved = new Set<string>();
  for (const chatId of chatIds) {
    try {
      const members = await listChatMemberOpenIds(bot.config.larkAppId, chatId);
      for (const openId of members) resolved.add(openId);
      logger.info(`[${bot.config.larkAppId}] Resolved allowedChatGroups ${chatId}: ${members.length} member(s)`);
    } catch (err: any) {
      logger.warn(`[${bot.config.larkAppId}] Failed to resolve allowedChatGroups ${chatId}: ${err?.message ?? err}`);
    }
  }
  bot.resolvedAllowedChatGroupUsers = [...resolved];
}
```

Call it after `allowedUsers` resolution in the per-bot loop:

```ts
await resolveAllowedChatGroups(bot);
```

- [ ] **Step 4: Verify test passes and build succeeds**

Run:

```bash
pnpm vitest run test/lark-client-allowed-chat-groups.test.ts && pnpm build
```

Expected: PASS for the test file and `pnpm build` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/client.ts src/daemon.ts test/lark-client-allowed-chat-groups.test.ts
git commit -m "feat(lark): 启动时解析 allowedChatGroups 成员"
```

---

### Task 3: 普通使用权限接入 canTalk，敏感操作保持 canOperate

**Files:**
- Modify: `src/im/lark/event-dispatcher.ts:470-498`
- Test:   `test/event-dispatcher.test.ts:84-99,406-459`

- [ ] **Step 1: Write the failing tests**

Update import in `test/event-dispatcher.test.ts`:

```ts
import { canOperate, canTalk, isBotMentioned, startLarkEventDispatcher, writeBotInfoFile, type EventHandlers } from '../src/im/lark/event-dispatcher.js';
```

Add these tests near existing permission-gate tests:

```ts
it('allows ordinary talk for users resolved from allowedChatGroups regardless of current chat', () => {
  mockIsChatOncallBoundForAnyBot.mockReturnValue(false);
  mockGetBot.mockReturnValue({
    config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
    botOpenId: MY_OPEN_ID,
    resolvedAllowedUsers: ['ou_admin'],
    resolvedAllowedChatGroupUsers: [USER_OPEN_ID],
  });

  expect(canTalk(MY_APP_ID, 'oc_different_chat', USER_OPEN_ID)).toBe(true);
});

it('does not grant sensitive operations to allowedChatGroups members', () => {
  mockGetBot.mockReturnValue({
    config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
    botOpenId: MY_OPEN_ID,
    resolvedAllowedUsers: ['ou_admin'],
    resolvedAllowedChatGroupUsers: [USER_OPEN_ID],
  });

  expect(canOperate(MY_APP_ID, 'oc_any', USER_OPEN_ID)).toBe(false);
  expect(canOperate(MY_APP_ID, 'oc_any', 'ou_admin')).toBe(true);
});
```

Add `resolvedAllowedChatGroupUsers: []` to existing `setupBotState` and explicit `mockGetBot.mockReturnValue` objects that represent a `BotState`.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
pnpm vitest run test/event-dispatcher.test.ts
```

Expected: FAIL because `canTalk` does not consult `resolvedAllowedChatGroupUsers`.

- [ ] **Step 3: Minimal implementation**

Update the permission comments and `canTalk` in `src/im/lark/event-dispatcher.ts`:

```ts
export function canTalk(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined): boolean {
  if (chatId && isChatOncallBoundForAnyBot(chatId)) return true;
  if (isKnownPeerBot(config.session.dataDir, larkAppId, senderOpenId)) return true;
  const bot = getBot(larkAppId);
  const allowedUsers = bot.resolvedAllowedUsers;
  if (allowedUsers.length === 0) return true;
  if (!senderOpenId) return false;
  return allowedUsers.includes(senderOpenId) || bot.resolvedAllowedChatGroupUsers.includes(senderOpenId);
}

export function canOperate(larkAppId: string, _chatId: string | undefined, senderOpenId: string | undefined): boolean {
  const allowedUsers = getBot(larkAppId).resolvedAllowedUsers;
  if (allowedUsers.length === 0) return true;
  return !!senderOpenId && allowedUsers.includes(senderOpenId);
}
```

Keep `canOperate` unchanged except formatting if needed.

- [ ] **Step 4: Verify tests pass**

Run:

```bash
pnpm vitest run test/event-dispatcher.test.ts
```

Expected: PASS for `test/event-dispatcher.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/event-dispatcher.ts test/event-dispatcher.test.ts
git commit -m "feat(auth): 允许 allowedChatGroups 成员普通使用"
```

---

### Task 4: 集成验证与无刷新约束检查

**Files:**
- Modify: `specs/20260522-allowed-chat-groups/plan.md`
- Verify: `src/bot-registry.ts`
- Verify: `src/im/lark/client.ts`
- Verify: `src/daemon.ts`
- Verify: `src/im/lark/event-dispatcher.ts`
- Verify: `src/setup/bot-config-editor.ts`
- Verify: `src/cli.ts`
- Verify: `README.md`
- Verify: `README.en.md`
- Verify: `bots.json.example`
- Test:   `test/bot-registry.test.ts`
- Test:   `test/bot-config-editor.test.ts`
- Test:   `test/lark-client-allowed-chat-groups.test.ts`
- Test:   `test/event-dispatcher.test.ts`

- [ ] **Step 1: Write the final regression check command**

Use this command as the final verification target:

```bash
pnpm vitest run test/bot-registry.test.ts test/bot-config-editor.test.ts test/lark-client-allowed-chat-groups.test.ts test/event-dispatcher.test.ts && pnpm build
```

Add this no-refresh grep check to the verification notes:

```bash
grep -R "allowedChatGroups" -n src test README.md README.en.md bots.json.example && ! grep -R "setInterval\|Cron\|scheduler" -n src | grep "allowedChatGroups"
```

- [ ] **Step 2: Verify command fails before all tasks are complete**

Run before Task 1-3 are done:

```bash
pnpm vitest run test/bot-registry.test.ts test/bot-config-editor.test.ts test/lark-client-allowed-chat-groups.test.ts test/event-dispatcher.test.ts
```

Expected: FAIL until the new test file and implementation from Task 1-3 exist.

- [ ] **Step 3: Minimal implementation**

No production code belongs to this task. The implementation is the completed output of Task 1, Task 2, and Task 3. This task only runs the combined verification and checks that `allowedChatGroups` has no runtime refresh hook.

- [ ] **Step 4: Verify final checks pass**

Run:

```bash
pnpm vitest run test/bot-registry.test.ts test/bot-config-editor.test.ts test/lark-client-allowed-chat-groups.test.ts test/event-dispatcher.test.ts && pnpm build && grep -R "allowedChatGroups" -n src test README.md README.en.md bots.json.example && ! grep -R "setInterval\|Cron\|scheduler" -n src | grep "allowedChatGroups"
```

Expected: vitest PASS, build exits 0, first grep prints `allowedChatGroups` occurrences, second grep prints nothing and exits 0 because no refresh scheduler references the feature.

- [ ] **Step 5: Commit**

If Task 1-3 were already committed and this task changes no source files, do not create an empty commit. If final verification required adjustments, commit only those files:

```bash
git add <adjusted-files>
git commit -m "test(auth): 验证 allowedChatGroups 集成行为"
```

---

## Spec Coverage Map

- FR-1: Task 1.
- FR-2: Task 1 and Task 2.
- FR-3: Task 2.
- FR-4: Task 2.
- FR-5: Task 3.
- FR-6: Task 3.
- FR-7: Task 3.
- FR-8: Task 1 and Task 3.
- FR-9: Task 2 and Task 4.
- FR-10: Task 1.
