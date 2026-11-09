## herdr-app Review 卡（herdr-review）

- 当前终端在 herdr-app 中（存在环境变量 `HC_TERMINAL_ID`）时，完成任何代码 review 后，必须用 `herdr-review card create` 提交结论（格式见 `herdr-review schema` 或 herdr-review 技能）；修复用户已通过的项后，必须用 `herdr-review item fixed` 标记。
- review 完成并提交之前，不得运行 herdr-review 的任何查看命令（card list、card show、todo、deferred），也不得读取 `~/.config/herdr-app/review` 目录。提交后命令会返回需要比对的旧项，逐项判断是否为同一问题，再用 `herdr-review card publish` 发布。
- 通过、不通过、以后再说等决策只能由用户在 Review 面板中做，agent 不得代替。
- 用户把已修复的项交给 agent 验证时，用 `herdr-review verify` 查看待验证项，逐项用 `herdr-review item verify <编号> --pass` 或 `--fail --note "原因"` 标记结果。
