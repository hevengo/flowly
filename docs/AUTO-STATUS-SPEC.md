# 自动进度 v1：事实 → 规则 → 状态

> 2026-10-29: Committed（[COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md) §4）在 A1/A1r 中与 In review 相同：新一轮从 Committed 进 Development，本轮没有任何看板报告时 A1r 恢复到 Committed。
>
> 2026-10-29: Integrated（[INTEGRATED-STAGE-SPEC](INTEGRATED-STAGE-SPEC.md) §4）与 Committed 相同：新一轮从 Integrated 进 Development，本轮没有任何看板报告时 A1r 恢复到 Integrated；没有规则会把卡片移进 Integrated。
>
> 2026-10-15 修订（全局设置）：自动流转同时作为插件设置项提供：Ultra Kanban settings → Moving cards → “Auto-update status from sessions”，host 级设置 `auto-status`（`{ autoStatus: boolean }`），**默认开启**，未保存或无效的存储值按开启处理。关闭时 A1/A1r 都不运行（turn 生命周期事实照常记录，M1/M2 标记不受影响）；开启时项目 `autoStatus=false` 仍可单独关闭该项目（项目表单开关改名 “Auto-update status in this project”）。即规则生效 = 全局开启 且 项目未关闭。设置读取失败时按默认开启。
>
> 2026-10-15 修订：In progress 已拆为 Design / Development / Test（[WORKFLOW-STAGES-SPEC](WORKFLOW-STAGES-SPEC.md)）。A1 不再处理 Backlog/Todo（由 agent 自选开工阶段），从 In review 继续时进 Development，从 Blocked 继续时回到上一个工作阶段；A1r、M2 中的 “In progress” 指任一工作阶段。下表保留原文作为历史。

状态：用户 2026-10-15 授权（“你说了算，你来推进”）。设计依据见 [AGENT-PROGRESS-DESIGN](AGENT-PROGRESS-DESIGN.md)，三个待定项按推荐方案执行：
1. 系统规则可以改状态，默认开启，可按项目关闭；
2. 回合结束且没有报告时，只打标记；
3. 回答问题直接用 session 输入框。

## 1. 范围

- 只处理**看板管理的 session**：从卡片 Start session 创建，或被显式发送过看板工作指示的 session（见 PHASE-02 修订），且其凭据绑定的 workspace 与卡片一致。
- 其他 session 一律不记录 turn/授权活动，也不触发规则。此前对卡片 workspace 中所有 session 都记活动，主 workspace 的普通对话因此在一张卡上留下了 84 条无关回合。
- 已完成（Done/Cancelled）或已归档的卡片、已归档项目永不被规则修改。

## 2. 规则

| 规则 | 触发 | 条件 | 动作 |
| --- | --- | --- | --- |
| **A1 开工 / 继续** | 看板管理的 session 开始一轮（`agent.turn_started`） | 卡片在 Backlog、Todo、In review、Blocked；项目 `autoStatus` 未关闭 | 状态 → In progress，task revision +1，活动 `status_changed`，actor=system，`rule="A1"`，note 标明哪个 session 开始了工作 |
| **A1r 恢复** | 看板管理的 session 一轮结束 | 本轮由 A1 从 In review/Blocked 拉回，本轮该 session 没有任何看板报告，回合未失败，且之后没有其他状态变更 | 恢复到原状态（`rule="A1r"`），避免一句“谢谢”让已交付的卡看起来又在进行中 |
| A2 交付 | agent 调 `flowly_update_status(in_review)` | 已有 | 不变 |
| **M1 问题** | agent 调 `flowly_report_progress(kind="question")` | — | 不改状态；卡片显示“需要你回答”，直到该 session 开始下一轮（即你已回复）或 agent 再次报告 |
| **M2 静默结束** | 看板管理的 session 一轮结束 | 卡片 In progress；该轮内该 session 没有任何看板报告 | 不改状态；该 session 的 Attention 项标注 “No report” |
| M3 出错 / 授权 | 已有 | — | 不变 |

说明：
- 回合只能由提示词触发：你的消息、看板指示，或 Paseo 定时任务。因此“session 开始新一轮”即可代表开工或返工。agent 若随后判断仍受阻，可再次设 Blocked。
- A1 只基于明确事实，不会把卡片设为 Done，也不因回合结束改状态。

M1、M2 由共享纯函数从活动记录推导，客户端和测试共用：

```
openQuestion(agentId) = 该 agent 最近一条 kind=question 的报告晚于它最近一次 turn_started，且之后没有它的其他报告
silentTurn(agentId)   = 卡片 In progress，该 agent 最近一次 turn_ended 晚于最近一次 turn_started，且两者之间没有它的报告
```

卡片侧栏顶部为每个待回答问题显示提示块（提问 session、问题原文、Reply 按钮直达该 session 预览）。

## 3. 数据与兼容

- 存储不升级版本（仍为 v3），只新增可选字段：
  - `project.autoStatus?: boolean`：缺省视为开启；
  - `event.rule?: string`；
  - 报告 kind 增加 `question`。
- 旧数据原样可读。
- `projects.update` 接受 `autoStatus`。项目编辑表单增加开关 “Auto-update status from sessions”。
- skill 增补：有需要用户回答的问题时用 `kind=question` 写清问题并结束本轮；用户回复后会开始新一轮。2026-10-20 起（SESSION-QUESTION-SPEC §2.2）：provider 有自带提问工具（AskUserQuestion 等）时优先用它，`kind=question` 是回退；同一问题只用一种方式问，因为工具里作答不会开始新一轮，同题的 `kind=question` 会一直算作 openQuestion。

## 4. UI

- 卡片信号行：有未回答问题时显示 “Needs you”（warning）。
- Attention：
  - 新增 “question” 原因，与授权、错误并列排在前面；
  - 静默结束在原因中标注 “no report”。
- 活动时间线：规则产生的变更显示 “Auto” 标签和触发说明。

## 5. 验收

- 规则纯函数测试：A1 各起始状态、已完成/已归档不动、`autoStatus=false` 不动、非看板管理 session 不动；M1/M2 推导。
- hook 集成测试（fake SDK）：只为看板管理 session 记活动。
- typecheck、全量测试；只 reload 本插件；用 web 客户端只读渲染检查。
