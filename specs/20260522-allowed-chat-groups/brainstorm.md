# allowedChatGroups Brainstorm

## Background

当前 botmux 的授权主要是 `allowedUsers`：按单个用户 open_id/邮箱授权；`oncallChats` 虽然能让某个群内所有人提问，但它绑定的是“群聊 + 工作目录”的 oncall 场景，不适合作为通用授权模型。

现在需要支持一种新的授权方式：把某个飞书群配置为“成员授权源”。该群里的成员都获得 bot 的普通使用权限，并且这份权限跟随用户身份，而不是限定只能在该群里使用。这样团队/项目群可以统一授权，避免逐个维护 open_id。

## Goals & End State

- Goal: bot 配置支持声明一个或多个“允许的群聊组”。
- Goal: 这些群聊里的成员自动获得普通使用权限，可在群聊/话题/私聊等入口向 bot 提问或继续会话。
- Goal: 敏感操作权限保持不变，仍由 `allowedUsers` 控制。
- Goal: 群成员在 daemon 启动时解析并缓存，运行期间不要求自动刷新。
- End State: `~/.botmux/bots.json` 可写 `"allowedChatGroups": ["oc_xxx"]`。
- End State: daemon 启动时加载这些群聊的成员 open_id；群成员变化需重启 daemon 生效。
- End State: `canTalk` 判断变为：`allowedUsers` 命中，或发送人属于任一 `allowedChatGroups` 群成员缓存，则允许普通使用。
- End State: `canOperate` 不读取群成员缓存，继续只看 `allowedUsers`。
- End State: README / example / setup 编辑器 / 单测覆盖对应行为。

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| 配置字段 | `allowedChatGroups: string[]` | 明确表示“允许的群聊组”，值使用飞书 `chat_id`（`oc_xxx`），避免和单用户授权混淆。 |
| 授权语义 | 群聊成员获得普通使用权限，权限跟随用户身份 | 目标是按群成员关系授权用户，不是限制 bot 只能在这些群里响应。 |
| 与 `allowedUsers` 关系 | `canTalk = allowedUsers 命中 OR allowedChatGroups 成员命中` | 保留个人授权能力，同时新增团队/项目群成员授权。 |
| 敏感操作边界 | `canOperate` 仍只看 `allowedUsers` | 群成员默认只获得普通使用权限，避免群内任意成员执行重启、关闭、终端写入等高风险操作。 |
| 私聊行为 | 群成员可在私聊普通使用；敏感操作仍需 `allowedUsers` | 权限跟随用户身份，入口不限于授权源群聊本身。 |
| 群成员缓存 | 启动时加载到内存缓存，运行期间不自动刷新 | 与 `allowedUsers` 启动解析的心智模型一致；避免后台刷新任务和运行期 API 压力；成员变更通过重启 daemon 生效。 |
| 兼容性 | 未配置 `allowedChatGroups` 时维持现状 | 已有用户不受影响；`allowedUsers` 空仍表示不限制。 |
| 文档与配置编辑 | README、`bots.json.example`、setup 编辑器展示/编辑新字段 | 让手动配置和交互式编辑都能发现并维护该能力。 |

## Out of Scope

- 不把 `allowedChatGroups` 做成“群白名单”；它是群成员授权源，不限制只能在这些群里使用。
- 不改变 `oncallChats` 的语义；oncall 仍只负责群绑定工作目录。
- 不把群成员自动提升为管理员；敏感操作仍由 `allowedUsers` 控制。
- 不做部门/组织架构授权；只支持飞书群聊 `chat_id`。
- 不要求群成员变更自动生效；成员新增/移除通过重启 daemon 刷新授权缓存。

## Risks & Mitigations

- Risk: 飞书群成员接口权限不足或调用失败，导致启动时无法解析授权群成员。 Mitigation: 启动解析失败写日志；无缓存时该授权源不放行，不影响 `allowedUsers`。
- Risk: `open_id` 按应用隔离，错误 app 视角下的群成员 ID 会导致误判。 Mitigation: 用当前 bot 的 `larkAppId` 对应 client 拉群成员，并把缓存按 bot/app 维度隔离。
- Risk: 群成员规模较大时启动解析成本高。 Mitigation: 启动时批量解析，权限判断只查内存 `Set`，避免每条消息打 API。
- Risk: 用户误以为 `allowedChatGroups` 的成员也能执行 `/restart` 等操作。 Mitigation: README、配置说明、权限拒绝文案明确区分普通使用权限和敏感操作权限。
- Risk: 成员被移出授权群后，在 daemon 重启前仍可普通使用。 Mitigation: 文档明确说明群成员授权是启动时快照，权限收敛需要重启 daemon。
