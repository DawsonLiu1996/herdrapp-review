// 校验 agent 提交的 review 内容。校验失败时逐项说明缺什么、该怎么写，数据不写入。

import { CliError, SEVERITIES } from "./model.ts";
import type { Severity, Submitted } from "./model.ts";

export interface Submission {
  title: string;
  scope: string;
  summary: string;
  items: Submitted[];
}

const PLACEHOLDER = /^(无|没有|暂无|不详|未知|略|待定|同上|见上|如上|n\/?a|none|null|nil|tbd|todo|-+|\.+|…+)$/i;

const FIELD_HELP: Record<string, string> = {
  title: "标题：一句话说清问题，例如“token 过期时页面白屏”",
  problem: "问题：代码哪里有问题、为什么有问题",
  suggestion: "建议修法：具体怎么改",
  ue_scenario: "影响场景：用户在什么情况下会遇到；确实没有用户可感知影响时写“无用户可感知影响”",
  ue_impact: "影响点：用户会受到什么影响；没有用户可感知影响时写明理由，例如“仅影响内部日志格式”",
};

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function filled(v: string): boolean {
  return v.length > 0 && !PLACEHOLDER.test(v);
}

export function validateSubmission(raw: unknown): Submission {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError("提交内容必须是一个 JSON 对象。运行 herdr-review schema 查看格式和示例。", 2);
  }
  const obj = raw as Record<string, unknown>;
  const title = text(obj.title);
  const scope = text(obj.scope);
  const summary = text(obj.summary);
  if (!filled(title)) errors.push("缺少 title：这次 review 的标题，例如“登录流程 review”");
  if (!Array.isArray(obj.items)) {
    errors.push("缺少 items：review 结论列表。没发现问题时写 []，并在 summary 里写结论");
  }
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  if (rawItems.length === 0 && Array.isArray(obj.items) && !filled(summary)) {
    errors.push("items 为空时必须填写 summary：写明 review 结论，例如“未发现问题，已检查 src/auth 下的登录流程”");
  }

  const items: Submitted[] = [];
  rawItems.forEach((value, index) => {
    const n = index + 1;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`第 ${n} 项不是 JSON 对象`);
      return;
    }
    const it = value as Record<string, unknown>;
    const name = text(it.title) || "未命名";
    const where = `第 ${n} 项（${name}）`;
    for (const key of ["title", "problem", "suggestion", "ue_scenario", "ue_impact"]) {
      const v = text(it[key]);
      if (!v) errors.push(`${where}缺少 ${key}。${FIELD_HELP[key]}`);
      else if (!filled(v)) errors.push(`${where}的 ${key} 写成了“${v}”，这是占位写法。${FIELD_HELP[key]}`);
    }
    const severity = text(it.severity).toUpperCase();
    if (!SEVERITIES.includes(severity as Severity)) {
      errors.push(`${where}的 severity 必须是 P0、P1、P2、P3 之一（P0 最严重）`);
    }
    const location = text(it.location);
    items.push({
      title: text(it.title),
      severity: severity as Severity,
      location: location || null,
      problem: text(it.problem),
      suggestion: text(it.suggestion),
      ue_scenario: text(it.ue_scenario),
      ue_impact: text(it.ue_impact),
    });
  });

  if (errors.length) {
    throw new CliError(["提交内容没有通过校验，数据未写入。请修改后重新提交：", ...errors.map((e) => `- ${e}`)].join("\n"), 2);
  }
  return { title, scope, summary, items };
}
