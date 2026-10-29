# 工作流阶段拆分：In progress → Design / Development / Test

状态：用户 2026-10-15 批准（“可以 试试看吧，不行再改回去”），已实现。回退见 §8。

> 2026-10-29：In review 之后新增 Committed（[COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md)），状态集合长度为 10；它不是工作阶段。

用户决定：
1. In progress 范围过大，拆成 **Design → Development → Test** 三个阶段；
2. 对**所有项目**生效：`in_progress` 退役，现有数据迁移（方案 B）；
3. 先设计还是直接开发，**由 agent 根据指令自行决定**：系统规则不替 agent 选择开工阶段。

## 1. 状态集合

默认顺序：

```
backlog → todo → design → development → test → in_review → blocked → done → cancelled
```

| status | 默认名称 | 含义 |
| --- | --- | --- |
| `design` | Design | 方案、规格、调研 |
| `development` | Development | 实现 |
| `test` | Test | 验证、修复验证中发现的问题 |

- `in_progress` 不再是卡片或泳道的合法状态，`taskInput`、`taskEdit`、`tasks.place`、`projects.update` 中出现 `in_progress` 一律按校验错误拒绝。
- 三者统称“工作阶段”（`workStatuses = ["design", "development", "test"]`，在 `shared/model.ts` 导出），凡原来判断 `status === "in_progress"` 的地方改为判断“属于工作阶段”。
- 泳道配置仍是全部内置状态的有序列表（长度变为 9），可排序、开关、改名，规则不变。

## 2. 数据迁移（v3 → v4）

`board.json` 版本升为 4。`BoardStore.load` 读到 v3 时在内存中迁移，下一次写入时持久化：

1. **卡片**：`status === "in_progress"` → `development`。不增加 revision，不写活动（迁移不是业务变更）。
2. **泳道**：项目有 `lanes` 时，把 `in_progress` 那一项原位替换为 `design`、`development`、`test` 三项，`enabled` 沿用原值；原 `name` 若非空，转给 `development`。没有 `lanes` 的项目继续用默认值。
3. **历史**：`events[].from/to` 与 `agentReceipts[].status` **不改写**。它们改用 `historyStatusSchema = statusSchema ∪ {"in_progress"}`，界面显示为“In progress”。
4. **备份**：首次读到 v4 之前的数据时，若 `board.pre-v4.json` 不存在，则把原文件复制为 `board.pre-v4.json`（与已有的 `.bak` 分开，不会被后续写入覆盖）。
5. v1/v2 先按现有路径升到 v3 形态，再走上述步骤。
6. 迁移后不变式校验失败时按现有规则保留原文件、报 `StoreInvalidError`，不重置数据。

## 3. 自动状态规则（修订 AUTO-STATUS-SPEC）

| 规则 | 修订后行为 |
| --- | --- |
| **A1 开工** | 卡片在 Backlog/Todo 时，session 开始一轮**不再改状态**。进入哪个阶段由 agent 按指令判断并调用 `flowly_update_status` 设置；agent 指南要求它在开始实际工作时立即设置。 |
| **A1 继续** | （2026-10-15 再修订）卡片在 **In review** 时，session 开始一轮 → **Development**（评审后的反馈通常是返工；方案返工由 agent 改回 Design）；Development 未开启时按下述 Blocked 的回退。卡片在 **Blocked** 时 → 回到**卡片上一次所在的工作阶段**：从活动中最近一条 `to ∈ 工作阶段 ∪ {in_progress}` 的 `status_changed` 推导，`in_progress` 视为 `development`；找不到或该泳道未开启时，取已开启工作阶段中的第一个；三个都关闭则不动。 |
| **A1r 恢复** | 判断条件中的 “task.status === in_progress” 改为“属于工作阶段”，其余不变。 |
| **M2 静默结束** | `silentTurn` 的条件改为“卡片在任一工作阶段”。 |
| 其他 | A2、M1、M3 不变。规则从不在三个工作阶段之间自动推进。 |

已知取舍：Backlog/Todo 的卡片在 agent 设状态之前仍留在原列，session 的运行状态照常显示在卡片上。

## 4. Agent 工具、CLI、skill

- `agentStatuses = ["design", "development", "test", "blocked", "in_review"]`；`allowedStatuses` 仍只列出项目已开启的泳道。
- **兼容旧调用**：已运行的 session 可能还持有旧工具 schema，或按旧 skill 调 `status in_progress`。工具输入额外接受 `in_progress` 作为别名：卡片已在工作阶段时保持不变（只记录 note），否则解析为 `development`。回执与活动记录的是解析后的真实状态。别名不出现在 `allowedStatuses` 或文档中。
- CLI `status <state>` 的用法提示和校验同步更新，别名规则相同。
- skill 与工具描述改为：开始方案/调研时设 Design，开始实现时设 Development，开始验证时设 Test，按任务需要自行决定从哪个阶段开始、可以跳过或回退阶段；交付设 In review；被阻塞设 Blocked。“新一轮自动回到 in_progress” 改为“自动回到之前的工作阶段”。
- 2026-10-15 修订（用户反馈：返工实现的卡被拉回 Design）：agent 曾在 Design 中完成实现并直接交付，未切到 Development，A1 因此回到过期阶段。指南与工具描述补充：阶段要随工作实时切换，开始改代码立即设 Development，不得从 Design 直接交付实现；每轮开始时核对自动恢复的阶段，与本轮工作不符就先改正（原文“不要为了继续而自己设置”已删除）。同日用户再次反馈旧 session 仍被拉回 Design，于是 A1 改为 In review 继续时进 Development（见 §3）。

## 5. 界面

- 状态图标/颜色：与其他状态同属 lucide `Circle*` 一族以保持视觉大小一致（宿主内置完整 lucide，已在安装包中确认）：Design `CircleEllipsis`（foreground）、Development `CircleDot`（warning）、Test `CircleGauge`（accent）。
- 泳道编辑器、看板列、手机状态弹层、卡片状态下拉、紧凑布局“首个有卡的泳道”逻辑都通过 `statuses` 自动覆盖，无需特判。
- 文案更新：项目设置中 Auto-update 说明（`client/forms.tsx`）、session 预览中的工具说明（`client/session-preview.tsx`）。
- 活动时间线中的历史 `in_progress` 显示为 “In progress”。

## 6. 文档

- 更新 AUTO-STATUS-SPEC（A1/A1r/M2）、SPEC-OUTLINE 顶部增加本条目、PROGRESS 记录检查结果。

## 7. 验收

聚焦测试：
- 迁移：v3 卡片 `in_progress` → `development`；泳道原位展开、开关沿用、改名转给 Development；无 `lanes` 项目不变；历史事件与回执保持原值且可解析；`board.pre-v4.json` 只写一次；v1/v2 链式迁移。
- 规则：Backlog/Todo 开工不动；In review 继续进 Development（未开启时回退）；Blocked 继续回到上一个工作阶段（含历史 `in_progress` → development、泳道关闭时的回退、全部关闭不动）；A1r 在三个阶段都能恢复；`autoStatus=false`、已完成/归档不动；`silentTurn` 覆盖三个阶段。
- 工具：`allowedStatuses` 按泳道过滤；三个阶段可设置；`in_progress` 别名两种情形；未开启泳道被拒绝。
- 输入校验：人为 `in_progress` 写入被拒绝。

其他：`npm run typecheck`、`npm test`；`paseo plugin reload paseo-ultra-kanban` 后检查真实看板数据迁移结果（迁移前记录 `board.json` 中 in_progress 卡片数量）；按项目要求用 full-access 的 `codex/gpt-6-luna` session 验证桌面与紧凑 UI、agent 设置阶段和规则，证据保存到 `docs/verification/workflow-stages.md`。

## 8. 回退

拆分不合适时：停用插件或回滚代码前，用 `board.pre-v4.json` 覆盖 `board.json`（会丢失迁移之后的看板变更），或保留数据、仅把 v4 中的 design/development/test 卡片手工映射回 `in_progress` 并降回 v3。旧代码无法读取 v4 数据（版本校验失败时会保留文件并报错，不会重置）。

