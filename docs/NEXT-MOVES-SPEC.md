# 下一步建议（NEXT-MOVES-SPEC）

## 1. 目标

Agent 完成一段工作后常在回复末尾写“接下来要不要……或者……”（例如开发完建议做 Luna 验证、验证完建议提交合入）。这些建议埋在文字里，用户要自己重新组织成一条消息再发。

本功能给 agent 一个工具，把本轮结束后的候选下一步结构化地交给 Flowly；会话输入框上方显示这一轮的建议，点一下就把对应指令**预填**进输入框，**不自动发送**，由用户修改或直接发送。

与 Ideas 的区别：idea 是本卡目标之外、值得以后做的工作（进 Ideas 收件箱，可建新卡）；next move 是**这个会话下一条消息**的候选，只在本轮结束到下一轮开始之间有效，不进收件箱、不建卡。

## 2. Agent 工具 `flowly_suggest_next_moves`

- 输入：`expectedRevision`、`request`（照抄 get_task）、`moves`：1–3 条（§9.4 起也可为空列表，表示“本轮没有需要用户的下一步”），每条
  - `label`：按钮文字，1–60 字符，短动词短语，用用户使用的语言（如“用 Luna 验证”“提交并推送”）。
  - `prompt`：点按后预填进输入框的完整指令，1–2000 字符，写成用户发给 agent 的话，能独立理解。
- 同一会话同一轮内再次调用：以最新一次为准（整组替换）。
- 写入：记录事件 `next_moves_suggested`（actor=agent，`agentId`，`note` 为各 label 用 ` · ` 连接，新字段 `moves` 保存原样的列表）。**不改** task revision、卡片状态，不进 Ideas。
- 校验与其它写工具一致：签名、revision、过期、归档、Done/Cancelled 拒绝（`TASK_FINISHED`）、精确重放返回原回执，`REQUEST_REUSED`。回执 action=`next_moves`。label/prompt 去掉首尾空白后为空、超长、条数大于 3 为 `INVALID_INPUT`（空列表在 §9.4 之前也是 `INVALID_INPUT`）。
- CLI：`next-moves --request-file <snapshot> --moves '<JSON 数组>'`（`[{"label":"…","prompt":"…"}]`）。HTTP API action `next_moves`。
- 何时调用（写进 skill）：一轮工作结束、准备把控制交回用户前，如果有明确的下一步（验证、提交/推送、继续下一阶段、修复刚发现的问题），调用一次；只放用户最可能选的 1–3 个，最推荐的放第一个。不需要用户动作时不调用。仍应在回复正文里简述这些选项（用户可能不在 Flowly 里看）。不要用它提问（提问用 provider 自带的提问工具，没有时用 `kind=question`，SESSION-QUESTION-SPEC §2.2），不要用它代替 idea。§9 把“如果有明确的下一步”改成与交付时刻绑定的规则。

## 3. 有效期（“这一轮的”建议）

`openNextMoves(events, agentId)`（`shared/next-moves.ts`）：该会话最新一条 `next_moves_suggested` 事件，且其后没有该会话的 `agent.turn_started`；否则为空。即用户发出下一条消息、新一轮开始后，旧建议自动消失。

客户端再加两条：会话 `lastUserMessageAt` 晚于事件时间（生命周期事件缺失时的兜底）不显示；本地点了关闭（×）的那一组（按事件 id）不再显示，直到新的一组出现。

活动时间线不显示 `next_moves_suggested`（它是会话级提示，不是卡片变化）；flow log 照常记录（不含 `moves`）。规则 A1r（“只回了句谢谢”回退 In review）不把这个事件当作工作汇报。

## 4. 界面

位置：Flowly 会话视图输入框正上方（与问题/审批表单同一位置，排在其后）。

显示条件：有有效建议，会话不在运行（`running`/`initializing`），没有待答的问题/审批，用户可以写入该会话。

样式：一行，左侧小号 `Sparkles` 图标，后接最多 3 个胶囊按钮（单行截断，横向可滚动，不换行，不把输入框顶高），行尾 × 关闭。出现时使用共享的 `Enter` 过渡（遵循减少动态效果）。手机与桌面同一组件，手机上触控高度保持可点。

点按一个建议：
- 输入框为空：填入其 `prompt`。
- 输入框已有文字：在原文后空一行追加 `prompt`（不覆盖用户已输入的内容）。
- 然后聚焦输入框（原生端按“外部改写”重挂载输入并聚焦，不破坏 IME；web 直接改受控值）。**不发送**。建议行保留到用户发送（新一轮开始）或关闭。
- 无障碍：按钮名“Suggested next step: {label}”，提示“Fills the message box. Nothing is sent until you send it.”

## 5. 新手引导

- 欢迎页特色列表新增一条“Suggested next steps”。
- 新一次性提示 `next-move`：当前项目某卡有有效建议时出现，文案“When an agent finishes a turn, its suggested next steps sit above the message box. Tap one to fill it in; nothing is sent until you press Send.”优先级排在 first-idea 之前（它比 idea 更直接地等待用户）。
- README Highlights 的“Needs-you reminders”后补一句，并在 agent 工具列表加上新工具。

## 6. 验收

- `server/agent-service.test.ts`：写入事件并带 `moves`、不改 revision；同轮再次调用以最新为准；重放；空/超长/超过 3 条拒绝；Done 卡拒绝。
- `shared/next-moves.test.ts`：新一轮开始后失效、取最新一组、只看本会话、预填拼接规则。
- `server/progress-rules.test.ts`：只有 next moves 的回合仍按 A1r 回退。
- `server/tool-server.test.ts`：工具列表包含 `flowly_suggest_next_moves`。
- `client/onboarding-logic.test.ts`：`next-move` 提示规则与优先级。
- Skill 文本（`server/skill-source.ts` 与 `skills/flowly/SKILL.md` 一致；`server/tool-server.test.ts` 逐字比较）。
- §9（交付时提醒）的验收见 §9.9。
- 人工/Luna：真实会话调用工具后输入框上方出现建议；点按只预填不发送、可编辑；已有文字时追加；发送后建议消失；关闭后不再显示；手机紧凑布局可用。

## 7. “移至 Done”建议（设计，待实现）

### 7.1 目标与边界

任务完成、已提交并推送后，agent 最自然的下一步是“把卡片放到 Done”。但 Done 是**用户的决定**（`allowedStatuses` 不含 done，agent 不能自己移）。所以它不是一条预填的消息，而是一种**动作型建议**：agent 只提出，用户点一下才移动；点按本身就是用户的决定。

不做：agent 直接把卡移到 Done；点按之外的自动移动；在 Flowly 里自行判断“已推送”（git 状态由 agent 判断，见 7.5）。

### 7.2 数据契约

`NextMove` 增加可选字段 `moveTo: "done"`（枚举预留，现在只允许 `done`）。

- 普通建议：`{label, prompt}`，行为不变。
- 动作建议：`{label, moveTo:"done"}`，`prompt` 可省略（省略即不预填任何内容；如给出则忽略）。
- 校验（`nextMovesInputSchema` 与 `nextMoveSchema`，`prompt` 改为可选，非动作建议仍必须有非空 `prompt`）：一组里最多 1 条动作建议；动作建议与普通建议可混排，总数仍 1–3；未知 `moveTo` 为 `INVALID_INPUT`。
- 事件 `next_moves_suggested` 的 `moves` 原样保存新字段；有效期、重放、Done/Cancelled 拒绝、revision 规则不变。旧事件无该字段，照常工作。
- CLI：`--moves '[{"label":"移至 Done","moveTo":"done"}]'`。

### 7.3 界面

- 动作建议的胶囊前加 `Check` 图标，边框用成功色，与消息型胶囊区分；仍在同一行，沿用 3 条上限与横向滚动。
- 显示条件在 §4 基础上再加：卡片当前不在 Done/Cancelled（已完成则隐藏该胶囊），且用户有权限移动卡片。
- 点按：
  1. 不动输入框内容，不发送任何消息。
  2. 走与拖拽到 Done 相同的移动路径（`rpc.moveTask`），再进入 `askWrapup`：未开 *Auto wrap up* 时弹出“是否收尾（归档会话与自有工作区）”，开了则由守护进程处理，规则不变（`docs/MULTITASK-SPEC.md`）。
  3. 成功用原生 toast“Moved to Done”；失败（revision 过期等）用现有错误提示，建议行保留，用户可重试。
  4. 移动成功后卡片已是 Done，该胶囊自然消失；其余消息型建议保留到本轮结束或关闭。
- 不额外弹确认框：点一个标明“Move to Done”的按钮已是明确意图；移出 Done 可恢复（`WORKSPACE-RESTORE-SPEC.md`）。
- 无障碍：按钮名“Suggested next step: {label}”，提示“Moves this card to Done.”（消息型仍用原提示）。
- 实现点：`session-preview.tsx` 新增 `onMoveToDone` 属性，由 `board.tsx` 提供（复用 `reorder` + `askWrapup`，无新 RPC）；`NextMoves` 按 `move.moveTo` 分支渲染并调用 `onPick` / `onAction`；传入的回调用 `useStableCallback`，保持 `React.memo`。

### 7.4 对其它规则的影响

- 规则 A1r（只回了句谢谢回退 In review）、活动时间线、flow log：不变。
- “agent 不能设 Done”不变：工具只是提出建议，状态变更由用户点按触发，事件记录 actor=human。

### 7.5 Skill 文本（`server/skill-source.ts` 与 `skills/paseo-ultra-kanban/SKILL.md` 同步）

在 next moves 一条后补：整张卡的工作已完成、已交付到 In review、改动已提交并推送（或确认无需提交）、没有遗留问题时，可在 moves 中加入一条 `moveTo:"done"` 的建议（label 用用户语言，如“移至 Done”），通常放在“提交并推送”之后的下一轮、或与其它收尾项并列；还有未提交/未推送改动、未验证项或待用户决定的问题时不要加。每组最多一条。

### 7.6 新手引导

- 欢迎页 “Suggested next steps” 一条补半句：“…including moving the card to Done once the work is pushed.”
- 现有 `next-move` 提示文案补一句“Some steps move the card, like Done.”，不新增 tip id（不重复向所有人弹出）。README Highlights 同步。所有新文案加入全部语言包。

### 7.7 验收

- `shared/next-moves.test.ts`：动作建议随有效期失效；卡已 Done 时过滤掉动作建议。
- `server/agent-service.test.ts`：接受 `moveTo:"done"` 且无 prompt；同组两条动作建议、未知 `moveTo`、非动作建议缺 prompt 均 `INVALID_INPUT`；事件保存 `moveTo`；不改 revision。
- `server/tool-server.test.ts`：工具 schema 含 `moveTo`。
- `client/onboarding-logic.test.ts`：无新 tip，现有规则不回归。
- 人工/Luna：agent 提交推送后建议出现“移至 Done”；点按不改输入框、卡片进入 Done 并按设置弹出/自动收尾；revision 冲突时报错且建议保留；已 Done 卡片不显示；手机紧凑布局可点。

## 8. 下一步建议随交付调用一起提交（已实现，桌面真实会话已验证）

> 2026-10-20 已实现：`shared/tools.ts`（共用的 0–3 条建议 schema，`nextMoves` 加到 status/progress，独立工具下限同为 0）、`server/agent-service.ts`（Done 守卫、同事务第二条事件）、`server/cli-source.ts`（`--moves` / `--no-moves`）、`shared/next-moves.ts`（`isNoMoves`、`noMovesNote`）、`client/drawer.tsx`（活动里的 “Suggested no next moves”）、工具描述与 skill 两份文字、README 两份、9 个语言包各 1 条。2026-10-20 已用两个 `codex/gpt-6-luna` full-access 会话在 Tinylink 临时卡上验证（MCP 与不带 MCP 的纯 CLI：带建议出现胶囊、`[]`/`--no-moves` 无胶囊且活动里有一行、Done 守卫在真实环境被拒），见 [verification/next-moves-delivery.md](verification/next-moves-delivery.md)；手机/紧凑布局与上线后覆盖率未验。§9（交付时提醒）尚未实现，见 §9.11。

### 8.1 评估

**问题成立，方案可行，按卡片实现，另有两处调整（8.2）。遗漏提示不在本节，由 §9 承担（8.9）。**

依据（`~/.paseo/plugin-data/flowly/board.json`，2026-10-19 起、按“会话的一轮”统计，agent 事件，共 171 轮）：

| 这一轮怎么结束 | 轮数 | 其中带下一步建议 |
|---|---|---|
| 交付到 In review（`status in_review`） | 89 | 48（54%） |
| `question` / `result` | 8 / 4 | 4 / 4 |
| 其它状态切换、仅 `progress` | 22 / 7 | 3 / 1 |
| 没有任何 status/progress 调用 | 41 | 2 |

- 交付轮只有约一半带建议，且分布不均：有会话 7 次交付全带，另有两个会话共 22 次交付只有 2 次带。从这个分布看，建议是否出现更像取决于 agent 是否想起第二次调用，而不是有没有下一步（这是推断，看板数据里没有 agent 的想法）。§9.1 的统计口径略宽（把系统或人写的 in_review 也算进去），结论一致：约一半交付轮没有建议。
- 交付、提问、结果这三类轮（101 轮，占 59%）结束时本来就会调用 `flowly_update_status` / `flowly_report_progress`。把字段放在这两个调用上，能覆盖这 101 轮；现在这些轮里只有 56 轮（48+4+4）有建议。
- **覆盖不到的部分要说清楚**：41 轮（24%）没有调用任何 Flowly 写工具（纯对话轮），本方案对它们无效，也不打算处理（这类轮多半不需要建议，且没有可挂的调用）。验收按“交付/提问/结果轮的覆盖率”衡量，不按全部轮。
- 卡片里的“MCP 重连后收尾退化成一条 status 命令”这一场景，说明 CLI 与 MCP 必须同等支持（8.4）。

**考虑过、不采用：**
- `nextMoves` 在 `in_review` 上设为必填：仍在运行的旧会话（旧 skill、旧 CLI 快照）会交付失败，还会逼出“继续”之类的凑数建议。可选字段 + 显式 `[]` 的可见度相同，不让交付失败。
- 守护进程在一轮结束时代为写入“无建议”：与“没传”无法区分，抹掉“agent 的选择可见”这一目的。
- 新增“结束本轮”合并工具：又多一个要记住的工具，失败模式不变。
- 用摘要器的 `next` 一句话补建议：每轮多开一个子会话、只在开启自动摘要时有、一句话不是可执行的 prompt。

### 8.2 数据契约

- `statusInputSchema` 与 `progressInputSchema` 增加可选字段 `nextMoves`，元素与 `flowly_suggest_next_moves` 的 `moves` 完全相同（label 1–60、prompt 1–2000、`moveTo:"done"` 且无 prompt、一组最多 1 条 `moveTo`、至多 3 条）。**三处下限相同，都是 0**：独立工具也接受 `[]`（§9.4、§9.11 第 1 点：提醒之后 agent 唯一的补救就是调用它）。实现上抽出共用的元素 schema 与校验函数，三处引用，不复制；现有测试“独立工具拒绝 `[]`”相应改为接受。
- 三种取值：
  - **没传**：不记录任何东西，行为与今天完全一致（本轮此前的建议保留）。
  - **`[]`**：显式“这一轮没有要用户做的事”。
  - **1–3 条**：与独立工具相同的建议。
- `nextMoves` 可用于 `report_progress` 的所有 `kind`（`progress` 也接受）。工具描述与 skill 只要求在交付、提问、阻塞、结果时传。**我的决定**：不在 `kind=progress` 上拒绝，因为守护进程无法判断这一轮是否结束，而拒绝会让整条汇报失败；代价是中途 `progress` 带 `[]` 会清掉本轮先前的建议，与“同轮后一次替换前一次”一致，描述里写明。
- **Done 守卫**（卡片所说的“同样的守卫”）：
  - 沿用：一组至多 1 条 `moveTo`、非动作建议必须有 prompt、未知 `moveTo` 为 `INVALID_INPUT`、已 Done/Cancelled 的卡为 `TASK_FINISHED`。
  - **新增，仅对合并调用**：带 `moveTo:"done"` 的 `nextMoves` 只在这次调用之后卡片处于 In review 时接受（`status in_review`，或卡片已在 In review 时的 `report_progress`）；否则 `INVALID_INPUT`（“moveTo done is only offered with a delivery to In review”），整条调用不写入任何东西。这把 skill 里的“已交付到 In review”变成机械检查。独立工具不加这条，避免改变已有调用的行为。
  - 不做：在守护进程里判断“已提交并推送”（见 7.1，仍是 agent 的判断）。
  - 2026-10-29：Committed 也是交付状态，`moveTo:"done"` 随 `status committed` 同样接受（[COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md) §3）。

### 8.3 写入语义

- 在同一个事务里，主事件（`status_changed` 或 `progress_reported`）之后再写一条 `next_moves_suggested`（actor=agent、同一 `agentId`、`moves` 原样、`note` 为各 label 用 ` · ` 连接；`[]` 时 `note` 为 `No next steps needed`，与 §9.4 相同）。主事件先，所以活动里先看到“改状态/汇报”，再看到“没有下一步”。
- 一次调用一份回执：`action` 仍是 `status` / `progress`，`eventId` 指向主事件。回执重放返回原回执，不再写第二条建议事件；`payloadHash` 包含 `nextMoves`，同一请求 ID 换了 `nextMoves` 为 `REQUEST_REUSED`。
- 任何拒绝都不写建议：`WORKPAD_OPEN`、`REVISION_CONFLICT`、Done 守卫等。事务内抛错整体不落盘（`store.transaction` 每次重新加载看板，抛错即丢弃），所以不存在“状态改了、建议没写”。skill 里写明：被拒后用同样的 `nextMoves` 重发。
- 有效期不变，`openNextMoves` 无需改动：它已经把 `moves` 为空的最新事件当作“没有”（`shared/next-moves.ts`），所以 `[]` 自然替换本轮先前的建议并且不出现胶囊。独立工具与合并调用混用时，同轮以最后一次为准。
- 不改 task revision（状态切换本身的 revision 变化照旧）。

### 8.4 CLI

- `status <state> --note … [--moves '<JSON 数组>' | --no-moves]`、`note [--kind …] --note … [--moves '<JSON 数组>' | --no-moves]`。
- `--no-moves` 等价于 `nextMoves: []`；`--moves` 必须是 JSON 数组（可为 `[]`）；`--moves` 与 `--no-moves` 同时给出、`--no-moves` 用在 `next-moves`/其它命令上都在客户端报错。`next-moves` 命令不变（`--moves '[]'` 现在也被接受，§9.4）。
- `cli-source.ts`：`allowed` 增加 `no-moves`，`booleanFlags` 增加它；现有“`--moves` 只能用于 next-moves”的检查改为允许 `status`/`note`/`next-moves`。skill 末尾的命令说明与 CLI 用法串同步。
- MCP 与 CLI 走同一个 `write(identity, "status"|"progress", input)`，没有第二套逻辑。

### 8.5 界面

- 胶囊行不变：交付后会话空闲时显示。
- **活动时间线**：`next_moves_suggested` 对非空建议仍不显示，**例外**是 `moves` 为空（显式无建议）的那条，显示为“{agent} suggested no next moves”（时间照常；这一行不再显示 `note`，避免与文案重复）。这**取代** §9.4 里“活动时间线（不显示该事件）”一句：卡片要求 agent 的“无”选择在活动里可见。判断函数放在 `shared/next-moves.ts`（`isNoMoves(event)`），时间线过滤与文案共用，单元测试直接测它。新字符串 “Suggested no next moves” 加入全部语言包。
- flow log 照常记录；`moves` 为空的 `next_moves_suggested`（`note` 为 `No next steps needed`）即显式无建议，覆盖率统计可据此区分“建议 / 无 / 没传”。
- 手机与桌面同一行，无新布局。

### 8.6 文案

工具描述（`server/tool-server.ts`）：
- `flowly_update_status` 末尾加：“When you deliver (in_review), pass nextMoves: the 1-3 messages the user is most likely to send you next (same items as flowly_suggest_next_moves; a moveTo=\"done\" move is only accepted together with in_review), or [] when nothing needs the user. Leave it out on mid-work stage changes. A refused call records nothing: resend it with the same nextMoves.”
- `flowly_report_progress` 末尾加：“When you ask (kind=question; the moves are the likely answers), report a blocker or give a result, pass nextMoves (or [] when nothing needs the user).”
- `flowly_suggest_next_moves` 开头加：“For updates in the middle of a turn, or when your delivery call had none; when you deliver or ask, pass nextMoves on flowly_update_status / flowly_report_progress instead.”

Skill（`server/skill-source.ts` 与 `skills/flowly/SKILL.md` 逐字相同，`tool-server.test.ts` 已比较两者）：skill 只改一次，与 §9 合并（§9.11 第 3 点）。§8 这一半的目标语义，替换以 “When you end a turn and there are clear next steps” 开头的那条：交付（in_review）、提问（kind=question）、汇报结果（kind=result）的回合，在结束本轮的那次调用里带 next moves——交付传给 `flowly_update_status`，提问或汇报结果传给 `flowly_report_progress`；内容是 1–3 条用户最可能发给你的下一条消息（提问时是可能的回答），最推荐的放第一个，label 用用户的语言、prompt 写成用户对你的指令；没有需要用户的事就传 `nextMoves: []`（CLI `--no-moves`），不要直接跳过；`flowly_suggest_next_moves` 用于一轮中途的更新，或交付调用没带时的补救；被拒绝的调用不会记录，重发时带上同样的 `nextMoves`。有效期、“仍在回复里简述选项”、`moveTo:"done"` 的条件（并注明它只在随 `in_review` 交付时被接受）、“提问用 `kind=question`、分叉的工作用 `flowly_propose_idea`”都保留。§9 的 `reminders` 与 ideas 两句另加。skill 最后一条命令说明补 `--moves`/`--no-moves`。`description` 前言不变。

### 8.7 对其它规则的影响

- A1r（“只回了句谢谢”回退）：合并调用的主事件是 agent 的工作汇报，不会被回退；只有建议事件的回合仍按 A1r 回退。逻辑不改，补一个两事件的用例。
- “Needs you”、注意力、会话已读：不变（建议事件与今天同一 action）。
- 新手引导：不加 tour 条目或新 tip（可见变化只有活动里一行“suggested no next moves”，用户已通过 `next-move` 提示了解建议）。README 两份在 agent 工具一行补一句“`flowly_update_status` / `flowly_report_progress` 可携带 `nextMoves`”。交付说明里写明此判断。
- 工具列表体积：两个工具各多一份建议元素 schema，估计多几百个 token；实现时用 `tools/list` 实测，明显偏大就缩短字段说明（说明写在共用 schema 上，不重复）。

### 8.8 兼容与上线

- 纯增量：旧 skill、旧 CLI 快照、仍在运行的会话照常工作；新字段只有传了才生效。旧版本读到 `moves: []` 的事件也合法（schema 本就允许 0–3 条）。
- 插件重载时 `ToolServer.initialize()` 重写运行时的 `flowly.mjs` 与 `SKILL.md`；已连接的 MCP 会话通常要重连才会看到新的工具 schema，在那之前只能用 CLI 传，所以 CLI 必须完整支持（8.4）。落地顺序见 §9.11：先 §8，再 §9，最好同一个会话做。
- 实现时工作区里 `client/drawer.tsx`、`server/agent-service.ts`、`server/skill-source.ts`、`shared/tools.ts`、`skills/flowly/SKILL.md` 已有别的卡片的未提交改动；提交时只暂存本卡的 hunk（`git add -p`）。

### 8.9 遗漏提示

字段是可选的，没传仍然静默；补这个洞的是 §9 的 `reminders`（交付、提问、结果之后，若本轮还没有 next moves 事件，结果里带一句提醒），不在本节。本节只需保证两点：(1) 合并调用在同一事务里写建议事件，所以带了 `nextMoves`（含 `[]`）的交付不会再收到“没有建议”的提醒（§9.3）；(2) §9.6 的提醒文字里“call flowly_suggest_next_moves”在本节落地后仍然成立（独立工具保留），无需改。

### 8.10 验收

- `server/agent-service.test.ts`：
  1. `status in_review` + `nextMoves`：一条 `status_changed`、一条 `next_moves_suggested`（顺序、`agentId`、`moves`、`note`），task revision 只涨一次，回执 `action=status`，`openNextMoves` 返回该组。
  2. `nextMoves: []`：写入 `moves: []`、`note` 为 `No next steps needed`；`openNextMoves` 为 `null`；本轮先前非空的建议被替换为无。
  3. 没传：不写建议事件，先前的建议保留。
  4. `report_progress` 的 `question`/`blocker`/`result`/`progress` 都能带；非法元素（空 label、超长、4 条、缺 prompt、未知 `moveTo`）为 `INVALID_INPUT` 且不写状态。
  5. Done 守卫：`in_review` + `moveTo:"done"` 通过；`development` + `moveTo:"done"` 为 `INVALID_INPUT`，状态不变、无事件、无回执；同组两条 `moveTo` 拒绝；Done/Cancelled 卡为 `TASK_FINISHED`。
  6. 重放返回原回执且只有一条建议事件；同请求换 `nextMoves` 为 `REQUEST_REUSED`。
  7. `WORKPAD_OPEN` 拒绝时不写建议；带 `acknowledgeOpen` 重发后写入。
  8. 独立 `next_moves` 用例保持通过，唯一改动是“`[]` 被拒绝”改为接受并记录（§9.4）；独立与合并混用以最后一次为准。
- `shared/next-moves.test.ts`：`[]` 在非空之后替换为无；`isNoMoves`；带 `nextMoves`（含 `[]`）的交付不触发 §9 的提醒（`needsNextMoves`，两张卡都落地后）。
- `server/progress-rules.test.ts`：主事件 + 建议事件的回合不回退；只有建议事件的回合仍回退。
- `server/tool-server.test.ts`：两个工具的 schema 含 `nextMoves`（可为空数组）；CLI：`status --moves`、`status --no-moves`、`note --kind question --moves`；`--moves` 与 `--no-moves` 并用、`--moves` 非数组、`--no-moves` 用在 `next-moves` 均失败；skill 两份文件一致。
- 客户端：时间线过滤只放行显式无建议的那条；新字符串在全部语言包（`npm test` 的 i18n 检查）。
- §9 的提醒用例由 §9.9 负责；两张卡合并后补一条：交付调用带 `nextMoves`（含 `[]`）时结果没有 `reminders`。
- 人工/Luna：真实会话 `status in_review` 带建议后胶囊出现；`[]` 后无胶囊且活动里有一行“suggested no next moves”；CLI 路径同样；旧 skill 的会话不受影响。
- 上线后用同一脚本复算：交付/提问/结果轮中，带建议（含显式 `[]`）的比例，目标 ≥ 90%。基线 56/101（约 55%）。
- 先 `npm run typecheck`，再 `npm test`，再 `paseo plugin install "$PWD" --id flowly` / `paseo plugin reload flowly`。

## 9. 交付时提醒（已实现，2026-10-20）

卡片：“Delivery-time reminders for missing next moves and ideas, plus firmer skill wording”（2026-10-20，Sidebar UI/UX 调整的跟进）。同一机制也提醒 Ideas，见 [IDEAS-SPEC](IDEAS-SPEC.md) §4.1。

### 9.1 目标与边界

skill 里“有明确下一步时调用一次”是**可选的第二次调用**，agent 做完活后常常忽略。看板数据（`board.json` 事件，按“同一会话、同一卡片、`agent.turn_started` 起的一轮”统计）：

| 日期 | 回合 | 有 next moves 的回合 | 含交付类写入（→ in_review、`question`、`result`）的回合 | 其中没有 next moves |
| --- | --- | --- | --- | --- |
| 2026-10-19 | 145 | 60 | 102 | 47 |
| 2026-10-20（截至设计时） | 26 | 2 | 11 | 9 |

做法：agent 在**本来就要调用**的交付类写工具成功后，结果里附一条纯文字提醒。此刻 agent 仍在回合内、还能再调用工具，成本只是结果里的一行字。

不做：
- 不拦截、不报错、不新增错误码、不改写入语义（不同于 `WORKPAD_OPEN`）；提醒只是文字，写入照常成功。
- 不覆盖没有任何交付类调用的回合（上表：10-19 有 43 个，10-20 有 15 个）。那些回合只有 skill 文字能影响；是否值得补一个覆盖率指标见 §9.10。
- 不在回合结束后由守护进程替 agent 发消息或代调工具（AGENTS.md：普通跟进只发送用户的文字）。

### 9.2 触发

写入成功后（含 §9.5 的重放）、且卡片仍可写（未归档、不在 Done/Cancelled）时判断：

| 调用 | next moves 提醒 | ideas 提醒 |
| --- | --- | --- |
| `flowly_update_status` → `in_review` | 是 | 是 |
| `flowly_update_status` → `blocked`（项目启用该泳道时） | 是 | 否 |
| `flowly_report_progress` `kind=question` | 是（“可能的回答”措辞） | 否 |
| `flowly_report_progress` `kind=result` | 是 | 否 |
| 其它：切换到 design/development/test、`kind=progress`/`blocker`、其它工具 | 否 | 否 |

2026-10-21：卡片缺 type、tags 或 workpad 时，**所有**写工具的结果还会带一条设置提醒（排在本表两种提醒之后），见 [CARD-SETUP-SPEC](CARD-SETUP-SPEC.md) §3.3。

`in_review` 不要求状态真的发生变化：卡片已在 In review 时再次调用同样会判断（仍是一次交付调用）。写入失败（含 `WORKPAD_OPEN`、`REVISION_CONFLICT`）不带提醒，因为什么都没写入。

### 9.3 条件

- **next moves**：该会话在本卡上，最近一次 `agent.turn_started` 之后没有任何 `next_moves_suggested` 事件。**空列表事件（§9.4）也算**，它表示 agent 已决定本轮无需用户动作。若该会话在本卡没有 `agent.turn_started`（生命周期事件缺失），把保留的全部事件当作同一轮；这只会少提醒，不会多提醒。判断是纯函数 `needsNextMoves(events, taskId, agentId)`（放在 `shared/next-moves.ts`，与 `openNextMoves` 并排）。注意 `board.events` 含所有卡片，必须按 `taskId` 过滤，这一点不同于只收到本卡事件的客户端。
- **ideas**：提醒只在 `in_review`；要求 Ideas 设置为开，且该会话在本卡**从未**提出过 idea。来源取 `board.ideas`（`taskId` + `agentId` 匹配，含已忽略/已采纳的），**不用** `idea_proposed` 事件：事件按卡片只保留最近 100 条（`BoardStore.event`），一张忙碌的卡上旧的 `idea_proposed` 会被修剪，提醒会误报。取舍：这是“卡片级”判断，不是“本轮级”——会话在本卡提过一次后，之后的交付（返工后再交付）不再收到 ideas 提醒（skill 仍写“每次交付”）。选它是为了让“有意识决定提 0 个”的卡不至于每个回合被重复提醒；想改成本轮级只需把来源换成 `idea_proposed` 事件加 `agent.turn_started` 边界。
- **安静路径**：Ideas 关闭（`ideasOn()` 为 false）时不提 ideas，也不为此读取其它数据；工作板关闭、`IDEAS_DISABLED`、`ARTIFACTS_DISABLED` 等路径行为不变，提醒文字不提它们。
- 计算在**写入事务内、事件写完之后**进行，读同一份 `board`。这样 §8（`update_status`/`report_progress` 自带 `nextMoves`）把 moves 事件写在同一事务里时，本条件不用改：交付调用传了 `nextMoves`（含 `[]`）就没有提醒，两样都没做才提醒。
- 子 agent（Paseo 原生子会话，带 `paseo.parent-agent-id` 标签）由主 agent 管理，其 next moves 没有用户去点（SUBAGENTS-SPEC 的 attention 决定同理）。核实结果：会话只有被插件准备过（卡片启动或显式加入）才持有 Flowly 工具身份（`ToolSecrets.managedIdentity`；`tool-server.test.ts` “session_open injection is limited to Kanban-managed sessions”），子会话默认没有，调不到这些工具，所以无需特殊处理；被准备过的子会话与其它会话同样对待。

### 9.4 空列表：显式“本轮不需要”

卡片里的提醒文字写着“…or [] if nothing needs them”，但现状 `moves` 至少 1 条，空列表是 `INVALID_INPUT`。不放开就没有“有意识地选择不建议”的出口，每个无事可建议的交付都会被重复提醒。因此：

- `moves` 允许 0–3 条（`nextMovesInputSchema` 的 `.min(1)` 改为 `.min(0)`；描述改为“0-3 next steps … pass [] when nothing needs the user this turn”）。
- 空列表照常记录 `next_moves_suggested` 事件（`moves: []`，`note` 为 `No next steps needed`）；不改 task revision、状态，不进 Ideas。回执 action 仍为 `next_moves`；重放、签名、过期、`TASK_FINISHED` 规则不变。
- 同轮的后一次调用整组替换前一次：空列表会清掉本轮先前的建议，之后再给非空列表则重新出现。
- 会话视图无需改：`openNextMoves` 对空 `moves` 返回 `null`，会话视图的 `moves.length > 0` 判断已覆盖；`hasOpenNextMoves`（`next-move` 提示）、规则 A1r（`next_moves_suggested` 不算工作汇报）都不受影响；活动时间线对非空建议仍不显示，只多显示空列表这一条（§8.5）。现有测试“`bad([])` 被拒绝”要改成“接受并记录”。
- CLI：`next-moves --moves '[]'` 已能通过（非空字符串）；只更新用法文字为“0-3”。

### 9.5 结果形状与位置

- `toolResultSchema` 增加可选 `reminders: string[]`（英文，面向 agent）。没有提醒时不出现该键，其它调用的结果完全不变。
- 键顺序固定为 `receipt, replayed, reminders, …, current`：`current` 是整张卡的上下文（数 KB），提醒必须排在它前面，agent 才不会漏看。MCP 的文本内容和 `structuredContent` 同源；CLI 本就把整个结果格式化输出，所以提醒自然跟在回执后面，**不需要**另写 stderr 输出（stdout 保持可解析的 JSON）。
- 重放（`replayed: true`）也带提醒，按**当前**看板判断：重放通常是首次响应丢了，agent 恰好没看到过提醒。卡片已 Done/Cancelled 或已归档时（重放仍返回回执）不带提醒。

### 9.6 文案（英文，agent 面向）

- next moves（in_review / blocked / result）：`No next moves suggested this turn. Before you end the turn, call flowly_suggest_next_moves with the 1-3 messages the user is most likely to send you next (recommended first), or with moves=[] if nothing needs the user. This write already succeeded.`
- next moves（question）：`No answers suggested for your question. If the user is likely to reply with one of a few options, call flowly_suggest_next_moves with those replies (1-3, recommended first) before you end the turn, or with moves=[] if the reply is free-form. This write already succeeded.`
- ideas（in_review）：`You have proposed no ideas on this card. Consider 0-3 ideas (flowly_propose_idea) for worthwhile follow-ups you noticed: bugs, refactors, next features. Zero is fine; decide on purpose.`

两条同时出现时 next moves 在前。

### 9.7 `question` 与 next moves 的关系（措辞决定）

skill 现有一句“Questions go through kind=question … not next moves”。卡片要求 question 回合也以 next moves 结尾。两者不矛盾，但措辞要改清楚：**问题本身仍走 `kind=question`**；next moves 放用户**可能发回的回答**（如“用方案 A”），点按即预填输入框。会话视图在没有待答的原生问题/审批时显示建议，所以回答胶囊与 “Needs you” 并存没有冲突。这是本设计的措辞选择，不改 §4 的界面。

2026-10-20 补充（SESSION-QUESTION-SPEC §2.2）：provider 自带提问工具时问题走该工具，选项就在表单里，不需要 next moves；上述规则只适用于 `kind=question` 的回退提问。

### 9.8 Skill 文本（`server/skill-source.ts` 与 `skills/flowly/SKILL.md` 同步）

- next moves 一条（替换“When you end a turn and there are clear next steps … call once”）：每个**交付（in_review）、提问（kind=question）或汇报结果（kind=result）**的回合都以 `flowly_suggest_next_moves` 结尾：1–3 条用户最可能发给你的下一条消息（提问时是可能的回答；问题本身仍走 kind=question），最推荐的放第一个。只有确实不需要用户时才传空列表 `[]`，不要直接跳过——这几个写入的结果会提醒你。其余原文保留（label/prompt 要求、过期规则、仍在正文里简述、`moveTo="done"` 的条件）。末句改为：“The question itself goes through kind=question and divergent work through flowly_propose_idea; next moves are only messages for this session.”
- 紧随其后补一条：写入结果若带 `reminders`，那是本轮漏掉的调用；在结束回合前补上（或有意识地不做）。写入本身已经成功。
- ideas 一条（见 IDEAS-SPEC §4）：把“usually when you deliver”改成“每次交付时回顾你注意到的东西，最多提 3 个；没有值得提的可以是 0 个，但要有意识地决定”。
- 第一条里的 skill `description` 不变。

### 9.9 验收

- `server/agent-service.test.ts`：
  - `in_review` 无 moves、无 ideas：`reminders` 同时有两条，键顺序在 `current` 之前。
  - 本轮已发 moves：只剩 ideas 提醒；Ideas 关闭：只剩 moves 提醒；该会话已提过 idea：只剩 moves 提醒；两者都满足：结果没有 `reminders` 键。
  - 回合边界：上一轮有 moves、新的 `agent.turn_started` 之后重新提醒；新一轮内再发 moves 后不提醒；另一个会话的 moves 不算。
  - 空列表：被接受并记录、清掉先前建议、抑制提醒；同轮再给非空列表后重新生效。
  - 触发矩阵：`question`/`result` 有 moves 提醒（`question` 为回答措辞）；`progress`/`blocker`、design/development/test 没有；`blocked`（启用该泳道的项目）只有 moves 提醒，没有 ideas。
  - 失败不带提醒（`WORKPAD_OPEN`）；重放带提醒，Done 后的重放不带。
  - 现有 “`bad([])` 被拒绝” 改为接受。
- `shared/next-moves.test.ts`：`needsNextMoves` 的回合边界、按 `taskId`/`agentId` 过滤、空列表事件算已决定、无 `turn_started` 时的退化。
- `server/tool-server.test.ts`：`flowly_suggest_next_moves` 的 schema 允许空数组；结果 schema 含 `reminders`；SKILL.md 与 `skillText` 逐字一致（已有）。
- `typecheck`、全量 `npm test`。
- 人工（可与 Luna 一起做）：真实会话交付到 In review 时结果里有提醒；调用 `moves=[]` 后同一轮再次交付不再提醒。

### 9.10 影响与后续

- 新手引导：不变。这是 agent 面向的改动，用户看到的只是更多的建议胶囊和 Ideas，现有 `next-move` / `first-idea` 提示已覆盖；README 不需新增卖点。交付说明里写明。
- 所有提醒文字是 agent 面向的英文，不进入语言包。
- 效果无法保证：提醒只能影响出现交付类调用的回合。建议上线后用同一口径复盘“交付回合中有 moves 的比例”；若要常态化，可作为后续在 Workflow Insights 里加一条覆盖率规则（已作为 idea 提出）。

### 9.11 与 §8（next moves 随交付调用提交）的关系

状态：§8 已先落地（commit 96ac586）：`moves` 下限在三处统一为 0，§8.9 已改成指向本节，`isNoMoves`、`noMovesNote` 已存在。下面第 1、2 点因此已满足；第 3 点（skill 只改一次）由本节的实现完成。

§8 是另一张卡并行写下的设计（同一份规格、同一批文件），目前只有规格、没有代码。两者目标一致，机制互补：§8 让 agent 在交付调用里**一次写完**，§9 在它**没写**时提醒。需要对齐的地方：

1. **独立工具必须接受 `[]`。** §8.2 写的是“独立工具仍是 1–3 条”。§9 的提醒发生在交付调用**之后**，agent 能补救的唯一办法就是调用独立工具，提醒文字也这么写，所以 `flowly_suggest_next_moves` 也要允许 `[]`（§9.4）。落地时 §8.2 那句改成“三处下限相同，都是 0”，共用的元素 schema 与数组校验函数仍只有一份。
2. **§8.9 的 `notice` 被 §9 取代**（§8.9 本就在等用户确认）：同一机制，但用 `reminders: string[]`，因为它还要承载 ideas 提醒；触发范围按本卡（in_review/blocked、question/result，不含 `blocker`）；重放也带提醒（§9.5）。§8.9 里“没传 `nextMoves` 且本轮没有建议”的条件，在 §9.3 里就是“事务内事件写完后仍没有 moves 事件”，自动涵盖。§8.9 已改为指向本节的说明，不再有待决定项。
3. **skill 只改一次。** 两处都要改“When you end a turn and there are clear next steps…”这一条。合并后的语义：交付/提问/汇报结果的回合以 next moves 结尾，首选写在交付调用的 `nextMoves` 里（§8），其次独立工具；没有需要用户的事就传 `[]`；写入结果带 `reminders` 时补上。措辞在实现时一次写定，`skill-source.ts` 与 `SKILL.md` 同步。
4. **落地顺序**：先 §8，再 §9；最好同一个会话做，避免 `server/agent-service.ts`、`shared/tools.ts`、`server/skill-source.ts`、`skills/flowly/SKILL.md`、`server/tool-server.ts` 的重复冲突。工作区里这些文件已有别的卡片的未提交改动，提交时只暂存本卡的 hunk。
5. **成功指标共用** §8.10 的口径：交付/提问/结果轮中带建议（含显式 `[]`）的比例，基线约 55%，目标 ≥ 90%。

### 9.12 实现与检查（2026-10-20）

- 代码：`shared/next-moves.ts` `needsNextMoves`（回合边界，纯函数）；`server/reminders.ts`（三条文案与 `deliveryReminders`，触发矩阵）；`server/agent-service.ts` `write()`（事务内、事件写完后计算，重放也计算；Ideas 开关只在 `in_review` 交付时读取；`remindersField` 控制键顺序）；`shared/tools.ts` `toolResultSchema.reminders`；`server/skill-source.ts` 与 `skills/flowly/SKILL.md`（两条规则加一条 `reminders` 说明）；`server/tool-server.ts` 两个工具的描述各加一句。CLI 无需改动：它输出整个结果，`reminders` 紧跟回执。
- 通过：`npm run typecheck`；`npm test`（93 个文件通过，711 个用例通过，13 个文件 / 65 个用例按原样跳过）；新增用例在 `server/agent-service.test.ts`（五个：默认两条、各种“已做过”、回合边界、触发矩阵、失败与已完成卡）、`shared/next-moves.test.ts`（`needsNextMoves`）、`server/tool-server.test.ts`（MCP 的 `structuredContent.reminders` 与 JSON 文本键序、CLI 输出键序、skill 与工具描述文字）。
- 实机（2026-10-20，`docs/verification/delivery-reminders.md`）：5 个 `codex/gpt-6-luna` 全权限会话在 Tinylink 临时卡上交付。MCP 与 CLI 的结果里都带 `reminders`（键序 `receipt, replayed, reminders, current`）；允许会话响应时（S3 走 MCP 传 `[]`、S4 走 CLI `next-moves`）第二次交付不再带 next moves 提醒；交付调用自带 `[]` 的会话（S1、S5）也没有该提醒；ideas 提醒在 9 次 in_review 交付里都出现、没有会话提 idea。**没有证明的**：会话被要求“别传 next moves 并结束本轮”时（S2）不会响应提醒（用户指令优先），所以这轮只证明提醒送达且可操作，不是遵从率；遵从率看 Insights 的 Agent habits。手机布局、非英文、`question`/`result` 与重放的实机未做。
- 上线后的效果指标：Insights 的 Agent habits（WORKFLOW-INSIGHTS-SPEC §12）已按 flow log 统计交付/结果回合里 next moves 与 idea 的占比，并标出 10 次以上交付仍没有 next moves 的模型/会话，用它复盘即可，不需要另做覆盖率规则。注意 `board.json` 每卡只留最近 100 条事件，本节开头的统计只能当量级参考，以 flow log 为准。
