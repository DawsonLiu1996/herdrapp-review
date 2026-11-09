---
name: herdr-review
description: 在 herdr-app 里做代码 review 或修复 review 项时使用。完成任何代码 review 后，用 herdr-review 命令把结论提交到 Review 面板，由用户逐项决策；修复用户已通过的项后用它标记已修复。用户提到 review 卡、Review 面板、herdr-review、修复 review 项（如 R12-1）时也使用。
---

# herdr-review：herdr-app 的 Review 卡

用户在 herdr-app 的 Review 面板里查看 agent 提交的 review 结论，逐项选择"通过"（认可，需要修）、"不通过"（不认可，不修）或"以后再说"，再指定一个 agent 修复。你负责提交结论，或者修复用户已通过的项。

当前终端在 herdr-app 中时存在环境变量 `HC_TERMINAL_ID`。命令会自动记录你所在的 space、worktree 和终端，不需要手动填写。

## 做 review 的流程

顺序不能变：

1. **独立完成 review。** 完成并提交之前，不运行 `card list`、`card show`、`todo`、`deferred`，也不读取 `~/.config/herdr-app/review` 目录。旧结论会影响本轮判断。
2. **写结论文件。** 用文件工具把 JSON 写到临时文件（UTF-8），格式见下文，或运行 `herdr-review schema` 查看。
3. **提交：** `herdr-review card create --file <文件路径>`
   - 退出码 2：内容不合格，按提示逐项修改后重新提交。
   - 返回 `"status": "published"`：已发布，完成。
   - 返回 `"status": "draft"`：继续第 4 步。
4. **比对旧项。** 返回的 `compare_with` 是同一 worktree 里还没修复的旧项。逐项判断本轮哪些条目和旧项是同一个问题，然后发布：
   - 有重复：`herdr-review card publish R16 --same R16-3=R12-2 --same R16-4=R12-5`
   - 没有重复：`herdr-review card publish R16`
   - 比对阶段只标重复，不修改本轮结论。拿不准时按新问题处理，用户可以在面板上纠正。
5. 需要等用户决策后再继续时：`herdr-review wait`（默认最多等 30 分钟）。

没发现问题也要提交：`items` 写 `[]`，`summary` 写结论。

## 结论格式

```json
{
  "title": "登录流程 review",
  "scope": "src/auth/**，提交 a1b2c3..HEAD",
  "summary": "共 1 项，影响登录后首屏",
  "items": [
    {
      "title": "token 过期时页面白屏",
      "severity": "P1",
      "location": "src/auth/session.ts:42",
      "problem": "refreshToken 失败时异常未被捕获，路由守卫拿到 undefined 后停止渲染",
      "suggestion": "在 refresh 失败分支清理本地会话并跳转登录页，保留当前路由用于登录后返回",
      "ue_scenario": "用户隔夜后重新打开应用，token 已过期",
      "ue_impact": "页面白屏，只能强制刷新；未保存的草稿丢失"
    }
  ]
}
```

- 必填：`title`、`severity`（P0 最严重，到 P3）、`problem`（问题）、`suggestion`（建议修法）、`ue_scenario`（影响场景）、`ue_impact`（影响点）。`location` 跨文件时可省略。
- 影响场景和影响点从用户角度写：在什么场景下，影响用户的什么体验。确实没有用户可感知影响时，`ue_scenario` 写"无用户可感知影响"，`ue_impact` 写明理由。
- 不接受"无""N/A""TBD""同上"等占位写法。
- 卡片的 `title` 只写这次 review 的范围和重点，不写项目名或 worktree 名，Review 面板已经按项目和 worktree 分组显示。例如写"全项目代码审查""修复后复查"，不写"herdr-review-plugin 全项目代码审查"。

## 修复的流程

用户在面板上把项交给你时，会发来条目编号，例如 R12-1、R12-3。

1. `herdr-review todo R12-1 R12-3` 查看问题、建议修法和**用户备注**（备注优先于建议修法）。不带编号时列出当前 worktree 所有待修复的项。
2. 只修"已决策·通过"的项。
3. 每修完一项：`herdr-review item fixed R12-1 --note "改了什么" --commit <提交号>`（没有提交时省略 `--commit`）。

## 验证的流程

用户在面板上把已修复的项交给你验证时，会发来条目编号。

1. `herdr-review verify`（或 `herdr-review verify --card R12`）列出已修复卡里待验证的项，注意用户的修复备注。
2. 逐项实际验证后标记结果：
   - 通过：`herdr-review item verify R12-1 --pass`
   - 不通过：`herdr-review item verify R12-1 --fail --note "哪里还不对"`（原因必填，会展示给用户）
3. 验证结果写进卡片后，全部验证通过的卡可以由用户归档。

## 不能做的事

- 不能代替用户决策：`item decide`、`item assign`、`item split` 只能由用户在 Review 面板中操作，agent 调用会被拒绝。
- 不能修改已提交的结论内容；需要补充时重新做一轮 review 并提交新卡。

## 其他命令

- `herdr-review` 或 `herdr-review help`：命令说明
- `herdr-review card show R12`：查看一张卡（review 提交之后才可以看）
- `herdr-review deferred --format md`：用户暂缓的项
