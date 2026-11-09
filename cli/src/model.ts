// 卡片和条目的数据结构，以及条目状态的流转规则。
// 卡片阶段（cardStage）和验证状态（verifyState）等共用规则在 mod/review/lifecycle.js，
// 这里转出口给命令和测试使用，面板用的是同一份文件的拷贝。

import { cardStage, verifyPending, verifyState, waitingFix } from "../../mod/review/lifecycle.js";

export { cardStage, verifyPending, verifyState, waitingFix };

export type Severity = "P0" | "P1" | "P2" | "P3";
export type Status = "pending" | "decided" | "fixed" | "deferred";
export type Decision = "approve" | "reject";

/** agent 提交的一条 review 结论。 */
export interface Submitted {
  title: string;
  severity: Severity;
  location: string | null;
  problem: string;
  suggestion: string;
  ue_scenario: string;
  ue_impact: string;
}

/** 后续轮次再次提出的同一问题：记在原条目上，保留该轮 agent 写的完整内容。 */
export interface Repeat {
  card_id: string;
  round: number;
  at: string;
  item: Submitted & { id: string };
}

export interface Fixer {
  terminal: string | null;
  app: string | null;
  name: string;
  at: string;
}

export interface Fix {
  note: string;
  commit: string | null;
  by: string;
  terminal: string | null;
  /** 修复时终端的标题（侧栏 Agents 里显示的名字）。终端关闭后面板用它显示。 */
  title?: string | null;
  /** 修复 agent 的程序 id（"claude-code"、"codex"），面板用它挑图标。 */
  app?: string | null;
  at: string;
}

/** 验证结果：result 为 pass / fail，fail 时 note 必填原因。 */
export interface Verify {
  result: "pass" | "fail";
  note: string;
  by: string;
  terminal: string | null;
  title?: string | null;
  at: string;
}

export interface Item extends Submitted {
  id: string;
  status: Status;
  decision: Decision | null;
  decision_note: string;
  fixer: Fixer | null;
  fix: Fix | null;
  /** 交给哪个 agent 验证，结构同 fixer。 */
  verifier?: Fixer | null;
  /** 验证结果；重新打开和再次标记已修复时清空。 */
  verify?: Verify | null;
  repeats: Repeat[];
}

export interface Reviewer {
  terminal: string | null;
  app: string | null;
  name: string;
  /** 提交时终端的标题（侧栏 Agents 里显示的名字）。终端关闭后面板用它显示。 */
  title?: string | null;
}

export interface LogEntry {
  at: string;
  actor: string;
  action: string;
  item?: string;
  from?: string;
  to?: string;
  note?: string;
}

export interface Card {
  schema: 1;
  id: string;
  state: "draft" | "published";
  /** 是否完成了与旧问题的比对。草稿超时自动发布时为 false。 */
  compared: boolean;
  title: string;
  scope: string;
  summary: string;
  space_id: string | null;
  space_name: string | null;
  repo_root: string | null;
  branch: string | null;
  head: string | null;
  cwd: string;
  reviewer: Reviewer;
  round: number;
  created_at: string;
  published_at: string | null;
  merged: { id: string; into: string }[];
  /** 草稿需要比对的旧条目编号；发布后删除。 */
  compare_with?: string[];
  /** 副本卡和从副本卡拉出的卡记录原卡编号；普通卡为 null。面板据此显示"来自以后再说"。 */
  origin?: string | null;
  /** 移到副本卡的条目，原卡底部灰字"N 项已移到以后再说"用。 */
  moved?: { item: string; to: string; at: string }[];
  archived_at?: string | null;
  archived_by?: string | null;
  items: Item[];
  log: LogEntry[];
}

export class CliError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

export const SEVERITIES: Severity[] = ["P0", "P1", "P2", "P3"];

export function statusLabel(it: Pick<Item, "status" | "decision">): string {
  if (it.status === "pending") return "待决策";
  if (it.status === "deferred") return "以后再说";
  if (it.status === "fixed") return "已修复";
  return it.decision === "reject" ? "已决策·不通过" : "已决策·通过";
}

export type DecideAction = "approve" | "reject" | "defer" | "pending" | "reopen";

const ACTION_LABEL: Record<DecideAction, string> = {
  approve: "标记为通过",
  reject: "标记为不通过",
  defer: "移到以后再说",
  pending: "移回待决策",
  reopen: "重新打开",
};

/**
 * 用户的决策操作。返回变化前后的状态文字，供写流水；不允许的变化抛出错误。
 * 备注：note 为 undefined 时一律保留已有备注（例如先写备注、选“以后再说”，之后再通过或发给 agent）；
 * 要清空时显式传空字符串。
 */
export function applyDecision(it: Item, action: DecideAction, note: string | undefined): { from: string; to: string } {
  const from = statusLabel(it);
  const deny = () => new CliError(`${it.id} 当前是"${from}"，不能${ACTION_LABEL[action]}`, 4);
  switch (action) {
    case "approve":
    case "reject": {
      if (it.status === "fixed") throw deny();
      it.status = "decided";
      it.decision = action;
      if (note !== undefined) it.decision_note = note;
      if (action === "reject") it.fixer = null;
      break;
    }
    case "defer":
      if (it.status === "fixed" || it.status === "deferred") throw deny();
      it.status = "deferred";
      it.decision = null;
      it.fixer = null;
      if (note !== undefined) it.decision_note = note;
      break;
    case "pending":
      if (it.status === "pending" || it.status === "fixed") throw deny();
      it.status = "pending";
      it.decision = null;
      it.fixer = null;
      if (note !== undefined) it.decision_note = note;
      break;
    case "reopen":
      if (it.status !== "fixed") throw deny();
      it.status = "decided";
      it.decision = "approve";
      it.fix = null;
      it.fixer = null;
      it.verify = null;
      it.verifier = null;
      if (note !== undefined) it.decision_note = note;
      break;
  }
  return { from, to: statusLabel(it) };
}

export function isOpen(it: Item): boolean {
  return it.status !== "fixed";
}
