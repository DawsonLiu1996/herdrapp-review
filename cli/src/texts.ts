// 命令自带的说明。agent 不确定用法时运行 herdr-review 或 herdr-review schema 就能看到。

export const HELP = `herdr-review：把代码 review 结论提交到 herdr-app 的 Review 面板，由用户逐项决策，agent 修复后标记。

review agent 的流程（顺序不能变）：
  1. 独立完成 review。完成并提交之前，不运行 card list、card show、todo、deferred，
     也不读取 ~/.config/herdr-app/review 目录，避免旧结论影响本轮判断。
  2. 提交本轮结论：herdr-review card create --file review.json（格式见 herdr-review schema）
  3. 如果返回 status=draft，逐项比对返回的 compare_with（同一 worktree 里未修复的旧项），
     判断本轮哪些条目是旧问题再次出现，然后发布：
       herdr-review card publish R16 --same R16-3=R12-2
     没有重复项时直接运行 herdr-review card publish R16。比对阶段只标重复，不改结论内容。
  4. 需要等用户决策时：herdr-review wait

修复 agent 的流程：
  1. herdr-review todo（或用户消息里给出的编号：herdr-review todo R12-1 R12-3），
     只修"已决策·通过"的项，注意用户备注。
  2. 每修完一项：herdr-review item fixed R12-1 --note "改了什么" [--commit 提交号]

验证 agent 的流程（用户把已修复的项交给你验证时）：
  1. herdr-review verify（或 herdr-review verify --card R12），列出已修复卡里待验证的项。
  2. 逐项实际验证后标记：herdr-review item verify R12-1 --pass；
     不通过用 herdr-review item verify R12-1 --fail --note "原因"（原因必填）。

命令：
  card create --file F | --stdin   提交本轮 review 结论
  card publish <卡号> [--same 本轮编号=旧编号 ...]   比对完成后发布
  schema                           提交格式、字段要求和示例
  todo [编号...] [--card R12] [--all] [--json]   待修复的项（已决策·通过）
  item fixed <编号...> --note "..." [--commit SHA]   标记已修复
  verify [--card R12] [--json]     已修复卡里待验证的项
  item verify <编号...> --pass | --fail --note "原因"   agent 标记验证结果
  wait [--card R12] [--timeout 30m]   等用户把这张卡的待决策项处理完
  card list [--all] [--json] / card show <卡号> [--json]   查看卡片
  deferred [--all] [--format text|md|json]   "以后再说"的项
  list --json                      全部卡片（面板和脚本使用）
  item decide / item assign / item split / card delete / card restore / card archive / card unarchive   用户操作，只能在 Review 面板或用户终端中执行
  setup                            安装：命令入口、agent 技能、Review 面板

默认只看当前 worktree（按当前目录的 Git 仓库判断），--all 看全部。
退出码：0 成功，2 提交内容不合格（按提示修改后重交），3 权限不足或等待超时，4 编号或状态不对。`;

export const SCHEMA = `提交格式（JSON，UTF-8）：

{
  "title": "这次 review 的标题，只写范围和重点，例如：登录流程 review",
  "scope": "review 的范围，例如：src/auth/**，提交 a1b2c3..HEAD",
  "summary": "一句话结论，例如：共 2 项，1 项影响登录后首屏",
  "items": [
    {
      "title": "一句话说清问题",
      "severity": "P0 | P1 | P2 | P3（P0 最严重）",
      "location": "代码位置，例如 src/auth/session.ts:42；跨文件的问题可以省略",
      "problem": "问题：哪里有问题、为什么有问题",
      "suggestion": "建议修法：具体怎么改",
      "ue_scenario": "影响场景：用户在什么情况下会遇到",
      "ue_impact": "影响点：用户会受到什么影响"
    }
  ]
}

字段要求：
- title、severity、problem、suggestion、ue_scenario、ue_impact 必填；不接受"无""N/A""TBD""同上"等占位写法。
- 卡片的 title 不写项目名或 worktree 名，Review 面板已经按项目和 worktree 分组显示。例如写"全项目代码审查""修复后复查"，不写"herdr-review-plugin 全项目代码审查"。
- 影响场景和影响点要从用户角度写：在什么场景下，影响用户的什么体验。
- 确实没有用户可感知影响时，ue_scenario 写"无用户可感知影响"，ue_impact 写明理由，例如"仅影响内部日志格式"。
- 没发现问题也要提交：items 写 []，summary 写结论，例如"未发现问题，已检查 src/auth 下的登录流程"。

示例：
{
  "title": "登录流程 review",
  "scope": "src/auth/**",
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

提交方式（推荐写文件，Windows 下不会出现中文乱码）：
  先用文件工具把 JSON 写到一个临时文件，再运行：herdr-review card create --file <文件路径>
  也可以用管道：cat review.json | herdr-review card create --stdin

提交后：
- 返回 status=published：已发布到 Review 面板，完成。
- 返回 status=draft：按返回的 compare_with 逐项比对，再运行返回的 next 里的发布命令。
- 退出码 2：内容不合格，按提示逐项修改后重新提交。`;
